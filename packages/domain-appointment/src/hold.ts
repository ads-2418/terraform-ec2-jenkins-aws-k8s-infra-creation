import { randomUUID } from "node:crypto";
import type { Appointment, AppointmentChannel, Prisma, PrismaClient } from "@app/db";
import { withTenantContext } from "@app/db";
import { NotFoundError, SlotUnavailableError, domainEventBus } from "@app/shared";
import { isWithinDoctorAvailability } from "./availability.js";
import { withIdempotency } from "./idempotency.js";
import { isUniqueConstraintViolation } from "./prisma-errors.js";
import type { Actor, IdempotentRequest } from "./types.js";

export interface HoldSlotInput extends IdempotentRequest {
  clinicId: string;
  doctorId: string;
  serviceId: string;
  patientId: string;
  startAt: Date;
  channel: AppointmentChannel;
  actor: Actor;
  holdTtlMinutes: number;
  /** Set internally by rescheduleAppointment - never accepted from a caller directly. */
  rescheduledFromId?: string;
  /** Set internally by rescheduleAppointment, which emits its own "appointment.rescheduled" event instead. */
  suppressEvent?: boolean;
}

export interface HoldSlotOutput {
  appointment: Appointment;
  replayed: boolean;
}

const HOLD_ENDPOINT = "appointments.hold";

/**
 * The core double-booking guard. See docs/APPOINTMENT_ENGINE.md §3-4 for
 * the full rationale - in short: a row lock on the slot serializes
 * concurrent attempts, a partial unique index is the database-level
 * backstop if that's ever bypassed, and every check re-reads live state
 * inside this same transaction rather than trusting anything the caller
 * computed earlier (an availability listing can be seconds stale).
 */
export async function holdSlot(prisma: PrismaClient, input: HoldSlotInput): Promise<HoldSlotOutput> {
  return withTenantContext(prisma, input.tenantId, (tx) => holdSlotTx(tx, input));
}

/**
 * Same logic, for callers that already hold an open tenant-context
 * transaction (rescheduleAppointment composes with this directly so the
 * old-appointment transition and the new hold commit atomically).
 */
export async function holdSlotTx(
  tx: Prisma.TransactionClient,
  input: HoldSlotInput,
): Promise<HoldSlotOutput> {
  const { result, replayed } = await withIdempotency(
    tx,
    {
      tenantId: input.tenantId,
      key: input.idempotencyKey,
      endpoint: HOLD_ENDPOINT,
      requestHash: input.requestHash,
    },
    async () => {
      const appointmentId = await createHeldAppointment(tx, input);
      return {
        result: { appointmentId },
        responseBody: { appointmentId },
        responseStatus: 201,
      };
    },
  );

  const appointment = await tx.appointment.findUniqueOrThrow({
    where: { id: result.appointmentId },
  });

  if (!replayed && !input.suppressEvent) {
    domainEventBus.emit("appointment.held", {
      tenantId: input.tenantId,
      appointmentId: appointment.id,
      doctorId: appointment.doctorId,
      patientId: appointment.patientId,
      slotId: appointment.slotId,
      startAt: appointment.startAt.toISOString(),
      occurredAt: new Date().toISOString(),
    });
  }

  return { appointment, replayed };
}

async function createHeldAppointment(
  tx: Prisma.TransactionClient,
  input: HoldSlotInput,
): Promise<string> {
  const [service, doctor] = await Promise.all([
    tx.service.findUnique({ where: { id: input.serviceId } }),
    tx.doctor.findUnique({ where: { id: input.doctorId }, include: { clinic: true } }),
  ]);
  if (!service) throw new NotFoundError("Service");
  if (!doctor) throw new NotFoundError("Doctor");
  if (doctor.status !== "ACTIVE") throw new SlotUnavailableError();

  const endAt = new Date(input.startAt.getTime() + service.durationMinutes * 60_000);

  // Ensure the slot row exists via a real atomic INSERT ... ON CONFLICT DO
  // NOTHING (raw SQL, not Prisma's upsert()): Prisma's upsert on this
  // provider/version is NOT a single atomic statement - under real
  // concurrency it does a read-then-write that itself raced and threw a
  // raw unique-constraint error instead of behaving as a clean upsert
  // (caught by the concurrency test in test/concurrency.test.ts). ON
  // CONFLICT DO NOTHING is atomic at the database level regardless of
  // ORM behavior, and Postgres blocks a conflicting insert here until the
  // other transaction that's inserting the same row commits or rolls
  // back, so this already gives us most of the serialization docs/
  // APPOINTMENT_ENGINE.md §3 describes before we even reach the explicit
  // lock below.
  await tx.$executeRaw`
    INSERT INTO slots (id, tenant_id, doctor_id, clinic_id, service_id, start_at, end_at)
    VALUES (${randomUUID()}, ${input.tenantId}, ${input.doctorId}, ${input.clinicId}, ${input.serviceId}, ${input.startAt}, ${endAt})
    ON CONFLICT (tenant_id, doctor_id, start_at) DO NOTHING
  `;
  const slotRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM slots
    WHERE tenant_id = ${input.tenantId} AND doctor_id = ${input.doctorId} AND start_at = ${input.startAt}
    FOR UPDATE
  `;
  const slotId = slotRows[0]?.id;
  if (!slotId) {
    // Should be unreachable: the insert above guarantees a row exists.
    throw new Error("Slot row missing unexpectedly after insert-or-conflict");
  }

  // Re-check under the lock: another transaction could have committed an
  // active appointment on this slot between the insert-or-conflict above
  // and the lock being granted (if it went first) - or blocked behind us
  // and be about to.
  const active = await tx.appointment.findFirst({
    where: { slotId, status: { in: ["HELD", "CONFIRMED"] } },
  });
  if (active) throw new SlotUnavailableError();

  // Never trust that the client's availability listing is still accurate -
  // re-verify against live doctor_availability inside this same
  // transaction. docs/APPOINTMENT_ENGINE.md §3 step 6.
  const withinHours = await isWithinDoctorAvailability(tx, {
    doctorId: input.doctorId,
    serviceId: input.serviceId,
    startAt: input.startAt,
    endAt,
    clinicTimezone: doctor.clinic.timezone,
  });
  if (!withinHours) throw new SlotUnavailableError();

  let appointment;
  try {
    appointment = await tx.appointment.create({
      data: {
        tenantId: input.tenantId,
        clinicId: input.clinicId,
        doctorId: input.doctorId,
        patientId: input.patientId,
        serviceId: input.serviceId,
        slotId,
        status: "HELD",
        startAt: input.startAt,
        endAt,
        channel: input.channel,
        holdExpiresAt: new Date(Date.now() + input.holdTtlMinutes * 60_000),
        rescheduledFromId: input.rescheduledFromId,
      },
    });
  } catch (err) {
    // The database-level backstop (docs/APPOINTMENT_ENGINE.md §4): if the
    // slot lock above somehow didn't prevent a race, the partial unique
    // index (uq_appointment_active_slot) rejects the insert instead of
    // allowing a double booking.
    if (isUniqueConstraintViolation(err)) throw new SlotUnavailableError();
    throw err;
  }

  await tx.appointmentEvent.create({
    data: {
      tenantId: input.tenantId,
      appointmentId: appointment.id,
      fromStatus: null,
      toStatus: "HELD",
      actorType: input.actor.type,
      actorId: input.actor.id ?? null,
    },
  });

  return appointment.id;
}
