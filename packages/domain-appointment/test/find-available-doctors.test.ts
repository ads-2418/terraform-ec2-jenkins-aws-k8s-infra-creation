import { beforeEach, describe, expect, it } from "vitest";
import { withTenantContext } from "@app/db";
import { findAvailableDoctors } from "../src/find-available-doctors.js";
import { holdSlot } from "../src/hold.js";
import { utcToZonedParts, zonedTimeToUtc } from "../src/timezone.js";
import { createFixture, futureSlotTime, prisma, resetDb } from "./fixtures.js";

describe("findAvailableDoctors", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("returns a working doctor with free ranges, and excludes one with no windows at all", async () => {
    const fixture = await createFixture();

    const idleDoctor = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.doctor.create({
        data: {
          tenantId: fixture.tenant.id,
          clinicId: fixture.clinic.id,
          displayName: "Dr. No Hours",
          specialty: "Nobody sees this",
        },
      }),
    );

    const from = futureSlotTime(0);
    const to = new Date(from.getTime() + 4 * 60 * 60_000);

    const results = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      findAvailableDoctors(tx, { tenantId: fixture.tenant.id, clinicId: fixture.clinic.id, from, to }),
    );

    const ids = results.map((r) => r.doctorId);
    expect(ids).toContain(fixture.doctor.id);
    expect(ids).not.toContain(idleDoctor.id);

    const found = results.find((r) => r.doctorId === fixture.doctor.id);
    expect(found?.specialty).toBeNull();
    expect(found?.freeRanges.length).toBeGreaterThan(0);
  });

  it("excludes a doctor whose entire queried window is already booked", async () => {
    const fixture = await createFixture();
    const startAt = futureSlotTime(60);
    const endAt = new Date(startAt.getTime() + fixture.service.durationMinutes * 60_000);

    await holdSlot(prisma, {
      tenantId: fixture.tenant.id,
      clinicId: fixture.clinic.id,
      doctorId: fixture.doctor.id,
      serviceId: fixture.service.id,
      patientId: fixture.patient.id,
      startAt,
      channel: "DASHBOARD",
      actor: { type: "USER" },
      holdTtlMinutes: 15,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "x",
    });

    const results = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      findAvailableDoctors(tx, {
        tenantId: fixture.tenant.id,
        clinicId: fixture.clinic.id,
        from: startAt,
        to: endAt,
      }),
    );

    expect(results.map((r) => r.doctorId)).not.toContain(fixture.doctor.id);
  });

  it("reports a free range around a booked appointment, not through it", async () => {
    const fixture = await createFixture();
    const busyStart = futureSlotTime(60);
    const busyEnd = new Date(busyStart.getTime() + fixture.service.durationMinutes * 60_000);

    await holdSlot(prisma, {
      tenantId: fixture.tenant.id,
      clinicId: fixture.clinic.id,
      doctorId: fixture.doctor.id,
      serviceId: fixture.service.id,
      patientId: fixture.patient.id,
      startAt: busyStart,
      channel: "DASHBOARD",
      actor: { type: "USER" },
      holdTtlMinutes: 15,
      idempotencyKey: crypto.randomUUID(),
      requestHash: "y",
    });

    const from = futureSlotTime(0);
    const to = new Date(busyEnd.getTime() + 60 * 60_000);

    const results = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      findAvailableDoctors(tx, { tenantId: fixture.tenant.id, clinicId: fixture.clinic.id, from, to }),
    );

    const found = results.find((r) => r.doctorId === fixture.doctor.id);
    expect(found).toBeTruthy();
    // No free range should overlap the busy interval.
    for (const range of found?.freeRanges ?? []) {
      const overlapsBusy = range.startAt < busyEnd && busyStart < range.endAt;
      expect(overlapsBusy).toBe(false);
    }
    // But there should be free time both before and after it.
    expect(found?.freeRanges.some((r) => r.endAt <= busyStart)).toBe(true);
    expect(found?.freeRanges.some((r) => r.startAt >= busyEnd)).toBe(true);
  });

  it("still shows free time later today for a window whose effectiveFrom falls partway through the day", async () => {
    // Reproduces the exact real-world case: addAvailabilityWindow defaults
    // effectiveFrom to the moment a window is created (schema.prisma
    // `@default(now())`), which is normally partway through the calendar
    // day, not midnight. A doctor added at 3pm must still show free time
    // from 3pm onward today, not be excluded from the whole day.
    const fixture = await createFixture();
    const now = new Date();
    const clinicTz = fixture.clinic.timezone;
    const today = utcToZonedParts(now, clinicTz);
    const effectiveFrom = new Date(now.getTime() + 60 * 60_000);

    const justAddedDoctor = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.doctor.create({
        data: { tenantId: fixture.tenant.id, clinicId: fixture.clinic.id, displayName: "Dr. Just Added" },
      }),
    );
    await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      tx.doctorAvailability.create({
        data: {
          tenantId: fixture.tenant.id,
          doctorId: justAddedDoctor.id,
          clinicId: fixture.clinic.id,
          dayOfWeek: today.dayOfWeek,
          startTime: "00:00",
          endTime: "23:30",
          slotDurationMinutes: 30,
          effectiveFrom,
        },
      }),
    );

    const dayStart = zonedTimeToUtc(
      { year: today.year, month: today.month, day: today.day, hour: 0, minute: 0 },
      clinicTz,
    );
    const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);

    const results = await withTenantContext(prisma, fixture.tenant.id, (tx) =>
      findAvailableDoctors(tx, { tenantId: fixture.tenant.id, clinicId: fixture.clinic.id, from: dayStart, to: dayEnd }),
    );

    const found = results.find((r) => r.doctorId === justAddedDoctor.id);
    expect(found).toBeTruthy();
    expect(found?.freeRanges.some((r) => r.startAt.getTime() === effectiveFrom.getTime())).toBe(true);
  });
});
