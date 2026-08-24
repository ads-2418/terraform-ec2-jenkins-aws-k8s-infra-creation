#!/usr/bin/env node
// Drives a full WhatsApp booking + cancellation conversation through the
// *real* HTTP webhook route, with a correctly-computed X-Hub-Signature-256,
// exactly as Meta's Cloud API would deliver it - the only difference from
// production is who's sending the POST. Requires apps/api and apps/worker
// already running locally (see docs/WHATSAPP.md §5) against the seeded
// demo tenant (`pnpm db:seed`), since the seeded tenant's
// whatsappPhoneNumberId ("demo-phone-number-id") is this script's routing
// target.
//
// Usage: node scripts/simulate-whatsapp-webhook.mjs

import { createHmac, randomUUID } from "node:crypto";
import { loadConfig } from "@app/config";
import { getPrismaClient, withTenantContext, disconnectPrisma } from "@app/db";
import { computeAvailability } from "@app/domain-appointment";

const config = loadConfig();
const prisma = getPrismaClient();

const API_BASE = `http://localhost:${config.API_PORT}`;
const PHONE_NUMBER_ID = "demo-phone-number-id";
const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const DOCTOR_ID = "00000000-0000-0000-0000-000000000401"; // Dr. Anjali Mehta
const SERVICE_ID = "00000000-0000-0000-0000-000000000201"; // General Consultation

// A fresh number each run so this script is repeatable without colliding
// with a previous run's patient/appointment record.
const PATIENT_PHONE = `+9198${String(Date.now()).slice(-8)}`;
const PATIENT_MSISDN = PATIENT_PHONE.slice(1); // Meta's wire format has no leading '+'

function log(step, detail) {
  console.log(`\n[${new Date().toISOString()}] ${step}${detail ? " - " + detail : ""}`);
}

function metaEnvelope(value) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "demo-waba-id", changes: [{ field: "messages", value }] }],
  };
}

function textPayload(from, body) {
  return metaEnvelope({
    messaging_product: "whatsapp",
    metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: "911234567890" },
    contacts: [{ profile: { name: "Simulated Patient" }, wa_id: from }],
    messages: [
      { from, id: `wamid.sim.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } },
    ],
  });
}

function interactiveReplyPayload(from, kind, replyId, title) {
  return metaEnvelope({
    messaging_product: "whatsapp",
    metadata: { phone_number_id: PHONE_NUMBER_ID, display_phone_number: "911234567890" },
    contacts: [{ profile: { name: "Simulated Patient" }, wa_id: from }],
    messages: [
      {
        from,
        id: `wamid.sim.${randomUUID()}`,
        timestamp: String(Math.floor(Date.now() / 1000)),
        type: "interactive",
        interactive: { type: kind, [kind]: { id: replyId, title } },
      },
    ],
  });
}

function sign(rawBody) {
  return "sha256=" + createHmac("sha256", config.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
}

async function postWebhook(payload, { badSignature = false } = {}) {
  const raw = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = badSignature ? "sha256=" + "0".repeat(64) : sign(raw);
  const res = await fetch(`${API_BASE}/v1/webhooks/whatsapp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
    body: raw,
  });
  return res;
}

async function pollSessionState(expected, { timeoutMs = 10_000, intervalMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await withTenantContext(prisma, TENANT_ID, (tx) =>
      tx.whatsappSession.findUnique({ where: { tenantId_patientPhone: { tenantId: TENANT_ID, patientPhone: PATIENT_PHONE } } }),
    );
    if (session && (Array.isArray(expected) ? expected.includes(session.state) : session.state === expected)) {
      return session;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for whatsapp_sessions.state to reach "${expected}" (currently: ${session?.state ?? "<no session>"}). ` +
          "Is apps/worker running and consuming the whatsapp-inbound queue?",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function assertOk(res, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${label} failed: ${res.status} ${body}`);
  }
}

async function main() {
  log("Checking API is reachable", API_BASE);
  const health = await fetch(`${API_BASE}/healthz`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Cannot reach ${API_BASE}/healthz. Start apps/api ("pnpm --filter @app/api dev") and apps/worker ` +
        '("pnpm --filter @app/worker dev") first, and run "pnpm db:seed" if you have not already.',
    );
  }

  log("Step 1: GET webhook verification handshake");
  const challenge = String(randomUUID());
  const verifyUrl = `${API_BASE}/v1/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(config.WHATSAPP_VERIFY_TOKEN)}&hub.challenge=${encodeURIComponent(challenge)}`;
  const verifyRes = await fetch(verifyUrl);
  const verifyBody = await verifyRes.text();
  if (verifyRes.status !== 200 || verifyBody !== challenge) {
    throw new Error(`Handshake failed: status=${verifyRes.status} body=${verifyBody}`);
  }
  log("  OK - challenge echoed back", verifyBody);

  log("Step 2: POST with a bad signature is rejected");
  const rejectRes = await postWebhook(textPayload(PATIENT_MSISDN, "hi"), { badSignature: true });
  if (rejectRes.status !== 401) {
    throw new Error(`Expected 401 for a bad signature, got ${rejectRes.status}`);
  }
  log("  OK - rejected with 401");

  log("Step 3: patient says 'hi'", PATIENT_PHONE);
  await assertOk(await postWebhook(textPayload(PATIENT_MSISDN, "hi")), "POST hi");
  await pollSessionState("MAIN_MENU");
  log("  OK - session reached MAIN_MENU");

  log("Step 4: patient taps 'Book appointment'");
  await assertOk(await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", "book", "Book appointment")), "POST book");
  await pollSessionState("SELECT_DOCTOR");
  log("  OK - session reached SELECT_DOCTOR");

  log("Step 5: patient picks Dr. Anjali Mehta");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", DOCTOR_ID, "Dr. Anjali Mehta")),
    "POST select doctor",
  );
  await pollSessionState("SELECT_SERVICE");
  log("  OK - session reached SELECT_SERVICE");

  log("Step 6: patient picks General Consultation");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", SERVICE_ID, "General Consultation")),
    "POST select service",
  );
  await pollSessionState("SELECT_SLOT");
  log("  OK - session reached SELECT_SLOT");

  log("Step 7: computing the slot the server will have offered");
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 24 * 60 * 60 * 1000);
  const slots = await withTenantContext(prisma, TENANT_ID, (tx) =>
    computeAvailability(tx, { tenantId: TENANT_ID, doctorId: DOCTOR_ID, serviceId: SERVICE_ID, from, to }),
  );
  if (slots.length === 0) throw new Error("No available slots found - is the seed data intact?");
  const chosenSlotIso = slots[0].startAt.toISOString();
  log("  Chosen slot", chosenSlotIso);

  log("Step 8: patient picks that slot (new patient, so the bot asks for a name)");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", chosenSlotIso, "slot")),
    "POST select slot",
  );
  await pollSessionState("AWAITING_NAME");
  log("  OK - session reached AWAITING_NAME");

  log("Step 9: patient sends their name");
  await assertOk(await postWebhook(textPayload(PATIENT_MSISDN, "Simulated Patient")), "POST patient name");
  await pollSessionState("AWAITING_CONFIRMATION");
  log("  OK - session reached AWAITING_CONFIRMATION (hold created)");

  log("Step 10: patient taps Confirm");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "button_reply", "confirm", "Confirm")),
    "POST confirm",
  );
  await pollSessionState("MAIN_MENU");

  const patient = await withTenantContext(prisma, TENANT_ID, (tx) =>
    tx.patient.findUniqueOrThrow({ where: { tenantId_phone: { tenantId: TENANT_ID, phone: PATIENT_PHONE } } }),
  );
  const appointment = await withTenantContext(prisma, TENANT_ID, (tx) =>
    tx.appointment.findFirstOrThrow({ where: { patientId: patient.id }, orderBy: { createdAt: "desc" } }),
  );
  if (appointment.status !== "CONFIRMED") {
    throw new Error(`Expected appointment status CONFIRMED, got ${appointment.status}`);
  }
  log("  OK - appointment CONFIRMED in the database", `${appointment.id} @ ${appointment.startAt.toISOString()}`);

  log("Step 11: patient checks 'My appointments' and cancels it");
  await assertOk(await postWebhook(textPayload(PATIENT_MSISDN, "menu")), "POST menu");
  await pollSessionState("MAIN_MENU");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", "status", "My appointments")),
    "POST status",
  );
  await pollSessionState("MANAGE_APPOINTMENT");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "list_reply", appointment.id, "appointment")),
    "POST select appointment",
  );
  await pollSessionState("CANCEL_CONFIRM");
  await assertOk(
    await postWebhook(interactiveReplyPayload(PATIENT_MSISDN, "button_reply", "cancel_yes", "Cancel it")),
    "POST cancel",
  );
  await pollSessionState("MAIN_MENU");

  const cancelled = await withTenantContext(prisma, TENANT_ID, (tx) =>
    tx.appointment.findUniqueOrThrow({ where: { id: appointment.id } }),
  );
  if (cancelled.status !== "CANCELLED") {
    throw new Error(`Expected appointment status CANCELLED, got ${cancelled.status}`);
  }
  log("  OK - appointment CANCELLED in the database");

  const messages = await withTenantContext(prisma, TENANT_ID, (tx) =>
    tx.whatsappMessage.count({ where: { tenantId: TENANT_ID } }),
  );
  log("Done", `${messages} whatsapp_messages rows recorded for this tenant so far. Full conversation verified end-to-end.`);
}

main()
  .catch((err) => {
    console.error("\nSimulation FAILED:", err.message ?? err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
