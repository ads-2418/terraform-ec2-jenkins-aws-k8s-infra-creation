import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@app/db";
import { processInboundMessage } from "../src/conversation.js";
import { SimulatedWhatsAppSendClient } from "../src/send-client.js";
import type { InboundMessage } from "../src/webhook-parser.js";
import type { OutboundMessage } from "../src/templates.js";
import { createFixture, prisma, resetDb, testPhone, type Fixture } from "./fixtures.js";

/** Drives one inbound message through the state machine and returns only the messages it produced. */
async function step(
  fixture: Fixture,
  sendClient: SimulatedWhatsAppSendClient,
  phone: string,
  partial: Partial<InboundMessage> & Pick<InboundMessage, "kind">,
): Promise<OutboundMessage[]> {
  const before = sendClient.sent.length;
  const message: InboundMessage = {
    waMessageId: randomUUID(),
    businessPhoneNumberId: fixture.tenant.whatsappPhoneNumberId ?? "wa-phone-test",
    fromPhone: phone,
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...partial,
  };
  await processInboundMessage(prisma, sendClient, {
    tenantId: fixture.tenant.id,
    message,
    holdTtlMinutes: 15,
  });
  return sendClient.sent.slice(before).map((s) => s.message);
}

function listRowIds(message: OutboundMessage): string[] {
  if (message.kind !== "list") throw new Error(`expected a list message, got ${message.kind}`);
  return message.rows.map((r) => r.id);
}

/** Books straight through from a blank session to a CONFIRMED appointment, returning its id. */
async function bookAppointment(
  fixture: Fixture,
  sendClient: SimulatedWhatsAppSendClient,
  phone: string,
  patientName: string,
): Promise<string> {
  await step(fixture, sendClient, phone, { kind: "text", text: "hi" });

  const [doctorList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: "book", text: "Book appointment" });
  expect(listRowIds(doctorList)).toContain(fixture.doctor.id);

  const [serviceList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: fixture.doctor.id, text: "Dr. Test" });
  expect(listRowIds(serviceList)).toContain(fixture.service.id);

  const [slotList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: fixture.service.id, text: "Consultation" });
  const slotIso = listRowIds(slotList)[0];
  expect(slotIso).toBeTruthy();

  const [namePrompt] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: slotIso, text: "slot" });
  expect(namePrompt.kind).toBe("text");

  const [confirmPrompt] = await step(fixture, sendClient, phone, { kind: "text", text: patientName });
  if (confirmPrompt.kind !== "buttons") throw new Error("expected a confirmation buttons message");
  expect(confirmPrompt.buttons.map((b) => b.id)).toContain("confirm");

  const [confirmed] = await step(fixture, sendClient, phone, { kind: "button_reply", replyId: "confirm", text: "Confirm" });
  expect(confirmed.kind).toBe("text");

  const patient = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
    tx.patient.findUniqueOrThrow({ where: { tenantId_phone: { tenantId: fixture.tenant.id, phone } } }),
  );
  const appointment = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
    tx.appointment.findFirstOrThrow({ where: { patientId: patient.id }, orderBy: { createdAt: "desc" } }),
  );
  return appointment.id;
}

describe("WhatsApp conversation engine (simulated send client, real Postgres)", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("books an appointment end-to-end through the full menu flow", async () => {
    const fixture = await createFixture();
    const sendClient = new SimulatedWhatsAppSendClient();
    const phone = testPhone();

    const appointmentId = await bookAppointment(fixture, sendClient, phone, "New Patient");

    const appointment = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    );
    expect(appointment.status).toBe("CONFIRMED");
    expect(appointment.channel).toBe("WHATSAPP");
  });

  it("cancels an existing appointment via the status/manage flow", async () => {
    const fixture = await createFixture();
    const sendClient = new SimulatedWhatsAppSendClient();
    const phone = testPhone();
    const appointmentId = await bookAppointment(fixture, sendClient, phone, "Cancel Me");

    const [statusList] = await step(fixture, sendClient, phone, { kind: "text", text: "menu" });
    expect(statusList.kind).toBe("list");

    const [manageList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: "status", text: "My appointments" });
    expect(listRowIds(manageList)).toContain(appointmentId);

    const [cancelButtons] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: appointmentId, text: "appt" });
    if (cancelButtons.kind !== "buttons") throw new Error("expected cancel/reschedule buttons");
    expect(cancelButtons.buttons.map((b) => b.id)).toEqual(expect.arrayContaining(["cancel_yes", "reschedule"]));

    await step(fixture, sendClient, phone, { kind: "button_reply", replyId: "cancel_yes", text: "Cancel it" });

    const appointment = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.findUniqueOrThrow({ where: { id: appointmentId } }),
    );
    expect(appointment.status).toBe("CANCELLED");
  });

  it("does not let one patient manage another patient's appointment via a crafted reply id", async () => {
    const fixture = await createFixture();
    const sendClientA = new SimulatedWhatsAppSendClient();
    const sendClientB = new SimulatedWhatsAppSendClient();
    const phoneA = testPhone();
    const phoneB = testPhone();

    await bookAppointment(fixture, sendClientA, phoneA, "Patient A");
    const appointmentBId = await bookAppointment(fixture, sendClientB, phoneB, "Patient B");

    // Patient A opens the status/manage flow, then replies with Patient B's
    // appointment id instead of one from their own list - a crafted
    // interactive reply payload could produce exactly this.
    await step(fixture, sendClientA, phoneA, { kind: "text", text: "menu" });
    await step(fixture, sendClientA, phoneA, { kind: "list_reply", replyId: "status", text: "My appointments" });
    const [result] = await step(fixture, sendClientA, phoneA, { kind: "list_reply", replyId: appointmentBId, text: "appt" });

    // Rejected back to the main menu, not the cancel/reschedule buttons.
    expect(result.kind).toBe("list");

    const appointmentB = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.findUniqueOrThrow({ where: { id: appointmentBId } }),
    );
    expect(appointmentB.status).toBe("CONFIRMED");
  });

  it("is safe to process the same inbound message twice (webhook redelivery)", async () => {
    const fixture = await createFixture();
    const sendClient = new SimulatedWhatsAppSendClient();
    const phone = testPhone();

    await step(fixture, sendClient, phone, { kind: "text", text: "hi" });
    const [doctorList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: "book", text: "Book appointment" });
    const [serviceList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: fixture.doctor.id, text: "Dr. Test" });
    void doctorList;
    const [slotList] = await step(fixture, sendClient, phone, { kind: "list_reply", replyId: fixture.service.id, text: "Consultation" });
    void serviceList;
    const slotIso = listRowIds(slotList)[0];
    await step(fixture, sendClient, phone, { kind: "list_reply", replyId: slotIso, text: "slot" });

    const waMessageId = randomUUID();
    const message: InboundMessage = {
      waMessageId,
      businessPhoneNumberId: fixture.tenant.whatsappPhoneNumberId ?? "wa-phone-test",
      fromPhone: phone,
      timestamp: String(Math.floor(Date.now() / 1000)),
      kind: "text",
      text: "Replay Patient",
    };

    // Same waMessageId processed twice, as would happen if Meta redelivers
    // before the webhook route's own dedup check ran (or is bypassed in a
    // direct-to-queue retry) - the appointment-engine idempotency key
    // derived from waMessageId must make the second run a safe no-op.
    await processInboundMessage(prisma, sendClient, { tenantId: fixture.tenant.id, message, holdTtlMinutes: 15 });
    await processInboundMessage(prisma, sendClient, { tenantId: fixture.tenant.id, message, holdTtlMinutes: 15 });

    const patient = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.patient.findUniqueOrThrow({ where: { tenantId_phone: { tenantId: fixture.tenant.id, phone } } }),
    );
    const appointments = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.findMany({ where: { patientId: patient.id } }),
    );
    expect(appointments).toHaveLength(1);
  });
});
