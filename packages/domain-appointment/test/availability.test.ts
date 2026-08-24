import { describe, expect, it } from "vitest";
import { generateCandidateSlots } from "../src/availability.js";

const DOCTOR_ID = "doctor-1";
const SERVICE_ID = "service-1";

describe("generateCandidateSlots", () => {
  it("generates 30-minute slots within a single day's window, respecting the grid", () => {
    // Wednesday = dayOfWeek 3. 2026-01-14 is a Wednesday.
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "10:30",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
    ];

    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-15T00:00:00Z"),
      now: new Date("2000-01-01T00:00:00Z"),
    });

    // 09:00-10:30 IST window, 30-min slots: 09:00, 09:30, 10:00 (10:30 would
    // end at 11:00, past the window - correctly excluded).
    expect(slots.map((s) => s.startAt.toISOString())).toEqual([
      "2026-01-14T03:30:00.000Z",
      "2026-01-14T04:00:00.000Z",
      "2026-01-14T04:30:00.000Z",
    ]);
  });

  it("excludes a candidate whose service duration would overrun the window end", () => {
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "09:45",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
    ];

    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-15T00:00:00Z"),
      now: new Date("2000-01-01T00:00:00Z"),
    });

    // Only 09:00 fits (09:00-09:30 <= 09:45); 09:30 would end at 10:00, past 09:45.
    expect(slots).toHaveLength(1);
    expect(slots[0]?.startAt.toISOString()).toBe("2026-01-14T03:30:00.000Z");
  });

  it("ignores a window scoped to a different service", () => {
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: "some-other-service",
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
    ];

    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-15T00:00:00Z"),
    });

    expect(slots).toHaveLength(0);
  });

  it("respects effectiveFrom/effectiveUntil bounds", () => {
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2026-01-14T04:00:00.000Z"), // after the 09:00 IST (03:30Z) slot
        effectiveUntil: null,
      },
    ];

    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-15T00:00:00Z"),
      now: new Date("2000-01-01T00:00:00Z"),
    });

    // 09:00 IST (03:30Z) is before effectiveFrom, excluded; 09:30 IST (04:00Z) is not.
    expect(slots.map((s) => s.startAt.toISOString())).toEqual(["2026-01-14T04:00:00.000Z"]);
  });

  it("excludes every slot on a holiday date, but not adjacent days", () => {
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 3, // Wednesday
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 4, // Thursday
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
    ];

    // 2026-01-14 is Wednesday, 2026-01-15 is Thursday (both IST).
    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-16T00:00:00Z"),
      now: new Date("2000-01-01T00:00:00Z"),
      holidayDates: new Set(["2026-01-14"]),
    });

    // Wednesday fully excluded; Thursday's slots still generated.
    expect(slots.every((s) => !s.startAt.toISOString().startsWith("2026-01-14"))).toBe(true);
    expect(slots.some((s) => s.startAt.toISOString().startsWith("2026-01-15"))).toBe(true);
  });

  it("excludes slots at or before `now`", () => {
    const windows = [
      {
        doctorId: DOCTOR_ID,
        serviceId: null,
        dayOfWeek: 3,
        startTime: "09:00",
        endTime: "10:00",
        slotDurationMinutes: 30,
        effectiveFrom: new Date("2000-01-01T00:00:00Z"),
        effectiveUntil: null,
      },
    ];

    const slots = generateCandidateSlots({
      windows,
      serviceId: SERVICE_ID,
      serviceDurationMinutes: 30,
      clinicTimezone: "Asia/Kolkata",
      from: new Date("2026-01-14T00:00:00Z"),
      to: new Date("2026-01-15T00:00:00Z"),
      now: new Date("2026-01-14T03:30:00.000Z"), // exactly the first candidate's start
    });

    expect(slots.map((s) => s.startAt.toISOString())).toEqual(["2026-01-14T04:00:00.000Z"]);
  });
});
