import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@app/db";
import { SlotUnavailableError } from "@app/shared";
import { computeAvailability } from "../src/availability.js";
import { holdSlot } from "../src/hold.js";
import { utcToZonedParts } from "../src/timezone.js";
import { createFixture, futureSlotTime, prisma, resetDb } from "./fixtures.js";

function hash(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** A UTC-midnight Date for the given clinic-local calendar date - matches how domain-tenant's addHoliday normalizes dates. */
function dateOnly(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

describe("holidays block availability and holds", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("excludes a clinic-wide holiday from computed availability", async () => {
    const fixture = await createFixture();
    const target = futureSlotTime(24 * 60);
    const { year: y, month: m, day: d } = utcToZonedParts(target, fixture.clinic.timezone);

    await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.holiday.create({
        data: {
          tenantId: fixture.tenant.id,
          clinicId: fixture.clinic.id,
          doctorId: null, // clinic-wide
          date: dateOnly(y, m, d),
          reason: "Test holiday",
        },
      }),
    );

    const from = new Date(target.getTime() - 60 * 60_000);
    const to = new Date(target.getTime() + 24 * 60 * 60_000);
    const slots = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      computeAvailability(tx, {
        tenantId: fixture.tenant.id,
        doctorId: fixture.doctor.id,
        serviceId: fixture.service.id,
        from,
        to,
      }),
    );

    // The target slot's whole day must be gone; slots on the following day remain.
    expect(slots.some((s) => s.startAt.getTime() === target.getTime())).toBe(false);
    expect(slots.length).toBeGreaterThan(0);
  });

  it("a doctor-specific holiday does not affect a different doctor at the same clinic", async () => {
    const fixture = await createFixture();
    const target = futureSlotTime(24 * 60);
    const { year: y, month: m, day: d } = utcToZonedParts(target, fixture.clinic.timezone);

    const otherDoctor = await withTenantContext(prisma, fixture.tenant.id, async (tx) => {
      const doctor = await tx.doctor.create({
        data: {
          tenantId: fixture.tenant.id,
          clinicId: fixture.clinic.id,
          displayName: "Dr. Other",
          consultationDurationMinutes: 30,
        },
      });
      for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek++) {
        await tx.doctorAvailability.create({
          data: {
            tenantId: fixture.tenant.id,
            doctorId: doctor.id,
            clinicId: fixture.clinic.id,
            dayOfWeek,
            startTime: "00:00",
            endTime: "23:30",
            slotDurationMinutes: 30,
            effectiveFrom: new Date("2000-01-01T00:00:00Z"),
          },
        });
      }
      // This holiday is scoped to the ORIGINAL fixture doctor only.
      await tx.holiday.create({
        data: {
          tenantId: fixture.tenant.id,
          clinicId: fixture.clinic.id,
          doctorId: fixture.doctor.id,
          date: dateOnly(y, m, d),
        },
      });
      return doctor;
    });

    const from = new Date(target.getTime() - 60 * 60_000);
    const to = new Date(target.getTime() + 60 * 60_000);

    const [fixtureDoctorSlots, otherDoctorSlots] = await withTenantContext(
      prisma,
      fixture.tenant.id,
      async (tx) => [
        await computeAvailability(tx, {
          tenantId: fixture.tenant.id,
          doctorId: fixture.doctor.id,
          serviceId: fixture.service.id,
          from,
          to,
        }),
        await computeAvailability(tx, {
          tenantId: fixture.tenant.id,
          doctorId: otherDoctor.id,
          serviceId: fixture.service.id,
          from,
          to,
        }),
      ],
    );

    expect(fixtureDoctorSlots.some((s) => s.startAt.getTime() === target.getTime())).toBe(false);
    expect(otherDoctorSlots.some((s) => s.startAt.getTime() === target.getTime())).toBe(true);
  });

  it("rejects a hold on a holiday date even if the caller never checked availability first", async () => {
    const fixture = await createFixture();
    const target = futureSlotTime(24 * 60);
    const { year: y, month: m, day: d } = utcToZonedParts(target, fixture.clinic.timezone);

    await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.holiday.create({
        data: {
          tenantId: fixture.tenant.id,
          clinicId: fixture.clinic.id,
          doctorId: null,
          date: dateOnly(y, m, d),
        },
      }),
    );

    await expect(
      holdSlot(prisma, {
        tenantId: fixture.tenant.id,
        clinicId: fixture.clinic.id,
        doctorId: fixture.doctor.id,
        serviceId: fixture.service.id,
        patientId: fixture.patient.id,
        startAt: target,
        channel: "WHATSAPP",
        actor: { type: "PATIENT" },
        holdTtlMinutes: 15,
        idempotencyKey: randomUUID(),
        requestHash: hash({ startAt: target.toISOString() }),
      }),
    ).rejects.toBeInstanceOf(SlotUnavailableError);
  });
});
