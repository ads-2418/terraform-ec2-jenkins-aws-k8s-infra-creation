import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { HoldExpiredError, IdempotencyKeyReusedError, InvalidTransitionError, SlotUnavailableError } from "@app/shared";
import { withTenantContext } from "@app/db";
import { holdSlot } from "../src/hold.js";
import { confirmAppointment } from "../src/confirm.js";
import { cancelAppointment } from "../src/cancel.js";
import { expireHold, expireHoldTx } from "../src/expire.js";
import { rescheduleAppointment } from "../src/reschedule.js";
import { createFixture, futureSlotTime, prisma, resetDb, type Fixture } from "./fixtures.js";

function hash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function newKey(): string {
  return crypto.randomUUID();
}

async function hold(fixture: Fixture, startAt: Date, key = newKey()) {
  return holdSlot(prisma, {
    tenantId: fixture.tenant.id,
    clinicId: fixture.clinic.id,
    doctorId: fixture.doctor.id,
    serviceId: fixture.service.id,
    patientId: fixture.patient.id,
    startAt,
    channel: "WHATSAPP",
    actor: { type: "PATIENT", id: fixture.patient.id },
    holdTtlMinutes: 15,
    idempotencyKey: key,
    requestHash: hash({ doctorId: fixture.doctor.id, startAt: startAt.toISOString() }),
  });
}

describe("appointment lifecycle", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("holds a slot and then confirms it", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);

    const { appointment: held } = await hold(fixture, startAt);
    expect(held.status).toBe("HELD");
    expect(held.holdExpiresAt).not.toBeNull();

    const { appointment: confirmed } = await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: held.id,
      idempotencyKey: newKey(),
      requestHash: hash({ appointmentId: held.id }),
      actor: { type: "PATIENT", id: fixture.patient.id },
    });
    expect(confirmed.status).toBe("CONFIRMED");
    expect(confirmed.confirmedAt).not.toBeNull();
  });

  it("rejects confirming an already-confirmed appointment (invalid transition)", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: held } = await hold(fixture, startAt);

    await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: held.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      actor: { type: "PATIENT" },
    });

    await expect(
      confirmAppointment(prisma, {
        tenantId: fixture.tenant.id,
        appointmentId: held.id,
        idempotencyKey: newKey(),
        requestHash: hash({ a: 2 }),
        actor: { type: "PATIENT" },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it("cancels a held appointment, freeing the slot for a new hold", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: held } = await hold(fixture, startAt);

    const { appointment: cancelled } = await cancelAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: held.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      cancelledBy: "PATIENT",
      actor: { type: "PATIENT" },
    });
    expect(cancelled.status).toBe("CANCELLED");

    // Same slot, new hold attempt - must succeed since the prior one is terminal.
    const { appointment: reheld } = await hold(fixture, startAt);
    expect(reheld.status).toBe("HELD");
    expect(reheld.id).not.toBe(held.id);
    expect(reheld.slotId).toBe(held.slotId);
  });

  it("expires a hold past its TTL via a re-check, not a blind flip", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: held } = await hold(fixture, startAt);

    // Simulate the hold-expiry job firing before TTL: must be a no-op.
    const notYet = await expireHold(prisma, { tenantId: fixture.tenant.id, appointmentId: held.id });
    expect(notYet.expired).toBe(false);
    expect(notYet.appointment.status).toBe("HELD");

    // Backdate hold_expires_at directly (simulating real time passing)
    // inside a tenant-context transaction, since the table is RLS-forced.
    await withTenantContext(prisma, fixture.tenant.id, async (tx) => {
      await tx.appointment.update({
        where: { id: held.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
    });

    const expired = await expireHold(prisma, { tenantId: fixture.tenant.id, appointmentId: held.id });
    expect(expired.expired).toBe(true);
    expect(expired.appointment.status).toBe("EXPIRED");

    // Confirming after expiry must fail cleanly.
    await expect(
      confirmAppointment(prisma, {
        tenantId: fixture.tenant.id,
        appointmentId: held.id,
        idempotencyKey: newKey(),
        requestHash: hash({ a: 1 }),
        actor: { type: "PATIENT" },
      }),
    ).rejects.toBeInstanceOf(InvalidTransitionError); // status is no longer HELD

    // Running expiry again is a safe no-op (idempotent).
    const again = await expireHold(prisma, { tenantId: fixture.tenant.id, appointmentId: held.id });
    expect(again.expired).toBe(false);
  });

  it("does not confirm a hold that is still HELD but past its TTL (expiry job hasn't run yet)", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: held } = await hold(fixture, startAt);

    await withTenantContext(prisma, fixture.tenant.id, async (tx) => {
      await tx.appointment.update({
        where: { id: held.id },
        data: { holdExpiresAt: new Date(Date.now() - 1000) },
      });
    });

    await expect(
      confirmAppointment(prisma, {
        tenantId: fixture.tenant.id,
        appointmentId: held.id,
        idempotencyKey: newKey(),
        requestHash: hash({ a: 1 }),
        actor: { type: "PATIENT" },
      }),
    ).rejects.toBeInstanceOf(HoldExpiredError);
  });

  it("replays an idempotent hold request instead of creating a duplicate", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const key = newKey();

    const first = await hold(fixture, startAt, key);
    const second = await hold(fixture, startAt, key);

    expect(second.replayed).toBe(true);
    expect(second.appointment.id).toBe(first.appointment.id);

    const count = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.appointment.count({ where: { slotId: first.appointment.slotId } }),
    );
    expect(count).toBe(1);
  });

  it("rejects a replayed idempotency key with a different request body", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const key = newKey();

    await holdSlot(prisma, {
      tenantId: fixture.tenant.id,
      clinicId: fixture.clinic.id,
      doctorId: fixture.doctor.id,
      serviceId: fixture.service.id,
      patientId: fixture.patient.id,
      startAt,
      channel: "WHATSAPP",
      actor: { type: "PATIENT" },
      holdTtlMinutes: 15,
      idempotencyKey: key,
      requestHash: hash({ v: 1 }),
    });

    await expect(
      holdSlot(prisma, {
        tenantId: fixture.tenant.id,
        clinicId: fixture.clinic.id,
        doctorId: fixture.doctor.id,
        serviceId: fixture.service.id,
        patientId: fixture.patient.id,
        startAt: futureSlotTime(48 * 60),
        channel: "WHATSAPP",
        actor: { type: "PATIENT" },
        holdTtlMinutes: 15,
        idempotencyKey: key,
        requestHash: hash({ v: 2 }),
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReusedError);
  });

  it("rejects holding an already-active slot", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    await hold(fixture, startAt);

    await expect(hold(fixture, startAt)).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("rejects a hold time that isn't on the doctor's availability grid", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const misaligned = new Date(startAt.getTime() + 5 * 60_000); // 5 minutes off-grid

    await expect(hold(fixture, misaligned)).rejects.toBeInstanceOf(SlotUnavailableError);
  });

  it("patient-initiated reschedule: old appointment terminal, new one starts HELD", async () => {
    const fixture = await createFixture();
    const originalStart = futureSlotTime(24 * 60);
    const { appointment: original } = await hold(fixture, originalStart);
    await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: original.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      actor: { type: "PATIENT" },
    });

    const newStart = futureSlotTime(48 * 60);
    const { oldAppointment, newAppointment } = await rescheduleAppointment(prisma, {
      tenantId: fixture.tenant.id,
      existingAppointmentId: original.id,
      newStartAt: newStart,
      channel: "WHATSAPP",
      actor: { type: "PATIENT" },
      holdTtlMinutes: 15,
      staffInitiated: false,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
    });

    expect(oldAppointment.status).toBe("RESCHEDULED");
    expect(newAppointment.status).toBe("HELD");
    expect(newAppointment.rescheduledFromId).toBe(original.id);
    expect(newAppointment.startAt.toISOString()).toBe(newStart.toISOString());
  });

  it("staff-initiated reschedule auto-confirms the new appointment", async () => {
    const fixture = await createFixture();
    const originalStart = futureSlotTime(24 * 60);
    const { appointment: original } = await hold(fixture, originalStart);
    await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: original.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      actor: { type: "PATIENT" },
    });

    const newStart = futureSlotTime(48 * 60);
    const { newAppointment } = await rescheduleAppointment(prisma, {
      tenantId: fixture.tenant.id,
      existingAppointmentId: original.id,
      newStartAt: newStart,
      channel: "DASHBOARD",
      actor: { type: "USER" },
      holdTtlMinutes: 15,
      staffInitiated: true,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
    });

    expect(newAppointment.status).toBe("CONFIRMED");
  });

  it("rolls back the old appointment's transition if the new slot is unavailable", async () => {
    const fixture = await createFixture();
    const originalStart = futureSlotTime(24 * 60);
    const { appointment: original } = await hold(fixture, originalStart);
    await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: original.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      actor: { type: "PATIENT" },
    });

    // Someone else already holds the target slot.
    const conflictStart = futureSlotTime(48 * 60);
    await hold(fixture, conflictStart);

    await expect(
      rescheduleAppointment(prisma, {
        tenantId: fixture.tenant.id,
        existingAppointmentId: original.id,
        newStartAt: conflictStart,
        channel: "WHATSAPP",
        actor: { type: "PATIENT" },
        holdTtlMinutes: 15,
        staffInitiated: false,
        idempotencyKey: newKey(),
        requestHash: hash({ a: 1 }),
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);

    const stillConfirmed = await withTenantContext(
      prisma,
      fixture.tenant.id,
      (tx) => tx.appointment.findUniqueOrThrow({ where: { id: original.id } }),
    );
    expect(stillConfirmed.status).toBe("CONFIRMED");
  });

  it("enforces tenant isolation: tenant A cannot see or act on tenant B's appointment", async () => {
    const fixtureA = await createFixture();
    const fixtureB = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: appointmentB } = await hold(fixtureB, startAt);

    await expect(
      confirmAppointment(prisma, {
        tenantId: fixtureA.tenant.id, // wrong tenant context
        appointmentId: appointmentB.id,
        idempotencyKey: newKey(),
        requestHash: hash({ a: 1 }),
        actor: { type: "PATIENT" },
      }),
    ).rejects.toThrow(); // NotFoundError - RLS hides the row entirely under tenant A's context
  });

  it("expireHoldTx no-ops cleanly on a CONFIRMED appointment (not still HELD)", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(24 * 60);
    const { appointment: held } = await hold(fixture, startAt);
    await confirmAppointment(prisma, {
      tenantId: fixture.tenant.id,
      appointmentId: held.id,
      idempotencyKey: newKey(),
      requestHash: hash({ a: 1 }),
      actor: { type: "PATIENT" },
    });

    const result = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      expireHoldTx(tx, { tenantId: fixture.tenant.id, appointmentId: held.id }),
    );
    expect(result.expired).toBe(false);
    expect(result.appointment.status).toBe("CONFIRMED");
  });
});
