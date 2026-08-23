import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SlotUnavailableError } from "@app/shared";
import { withTenantContext } from "@app/db";
import { holdSlot } from "../src/hold.js";
import { createFixture, futureSlotTime, prisma, resetDb } from "./fixtures.js";

function hash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * This is the test that actually proves the claim in
 * docs/APPOINTMENT_ENGINE.md §4: fires many truly concurrent holdSlot()
 * calls at the identical doctor+time and asserts exactly one succeeds.
 * Not a unit test of the happy path - a real race against real Postgres,
 * with real row locks and a real partial unique index doing the work.
 */
describe("concurrency: no double booking", () => {
  it("allows exactly one winner out of 25 simultaneous hold attempts on the same slot", async () => {
    await resetDb();
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);

    const CONCURRENCY = 25;
    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      holdSlot(prisma, {
        tenantId: fixture.tenant.id,
        clinicId: fixture.clinic.id,
        doctorId: fixture.doctor.id,
        serviceId: fixture.service.id,
        patientId: fixture.patient.id,
        startAt,
        channel: "WHATSAPP",
        actor: { type: "PATIENT" },
        holdTtlMinutes: 15,
        idempotencyKey: randomUUID(), // distinct keys - these are genuinely different patients/requests, not replays
        requestHash: hash({ attempt: i }),
      }),
    );

    const settled = await Promise.allSettled(attempts);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(CONCURRENCY - 1);

    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason).toBeInstanceOf(SlotUnavailableError);
      }
    }

    // Prove it at the database level too, not just "the function returned
    // once": exactly one active (HELD/CONFIRMED) appointment on this slot.
    const activeCount = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.count({
        where: { doctorId: fixture.doctor.id, startAt, status: { in: ["HELD", "CONFIRMED"] } },
      }),
    );
    expect(activeCount).toBe(1);

    // And exactly one slot row total for this doctor+time (the
    // uq_slot_doctor_start guard) - not 25 separate slot rows.
    const slotCount = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.slot.count({ where: { doctorId: fixture.doctor.id, startAt } }),
    );
    expect(slotCount).toBe(1);
  }, 30_000);

  it("after the winning hold expires, a fresh race for the same slot again has exactly one winner", async () => {
    await resetDb();
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);

    const { appointment: firstWinner } = await holdSlot(prisma, {
      tenantId: fixture.tenant.id,
      clinicId: fixture.clinic.id,
      doctorId: fixture.doctor.id,
      serviceId: fixture.service.id,
      patientId: fixture.patient.id,
      startAt,
      channel: "WHATSAPP",
      actor: { type: "PATIENT" },
      holdTtlMinutes: 15,
      idempotencyKey: randomUUID(),
      requestHash: hash({ v: 0 }),
    });

    await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.update({ where: { id: firstWinner.id }, data: { status: "EXPIRED" } }),
    );

    const CONCURRENCY = 10;
    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      holdSlot(prisma, {
        tenantId: fixture.tenant.id,
        clinicId: fixture.clinic.id,
        doctorId: fixture.doctor.id,
        serviceId: fixture.service.id,
        patientId: fixture.patient.id,
        startAt,
        channel: "WORDPRESS",
        actor: { type: "PATIENT" },
        holdTtlMinutes: 15,
        idempotencyKey: randomUUID(),
        requestHash: hash({ round: 2, attempt: i }),
      }),
    );

    const settled = await Promise.allSettled(attempts);
    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    // Two rows now exist for this slot (the expired one + the new winner) -
    // that's expected (docs/APPOINTMENT_ENGINE.md §4: a slot accumulates
    // history) - but still only one ACTIVE.
    const activeCount = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.count({
        where: { doctorId: fixture.doctor.id, startAt, status: { in: ["HELD", "CONFIRMED"] } },
      }),
    );
    expect(activeCount).toBe(1);

    const totalCount = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.count({ where: { doctorId: fixture.doctor.id, startAt } }),
    );
    expect(totalCount).toBe(1 + 1); // the expired original + the new winner
  }, 30_000);
});
