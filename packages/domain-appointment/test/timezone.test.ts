import { describe, expect, it } from "vitest";
import { utcToZonedParts, zonedTimeToUtc } from "../src/timezone.js";

describe("timezone conversion", () => {
  it("converts IST wall-clock time to the correct UTC instant (fixed +05:30, no DST)", () => {
    // 2026-01-15 09:00 IST == 2026-01-15 03:30 UTC
    const utc = zonedTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, "Asia/Kolkata");
    expect(utc.toISOString()).toBe("2026-01-15T03:30:00.000Z");
  });

  it("round-trips UTC -> IST -> UTC", () => {
    const original = new Date("2026-06-01T12:00:00.000Z");
    const local = utcToZonedParts(original, "Asia/Kolkata");
    const back = zonedTimeToUtc(local, "Asia/Kolkata");
    expect(back.getTime()).toBe(original.getTime());
  });

  it("computes the correct day-of-week in the target timezone even when it differs from UTC's day", () => {
    // 2026-01-01 00:15 UTC is still 2025-12-31 in US/Pacific (UTC-8).
    const instant = new Date("2026-01-01T00:15:00.000Z");
    const pacific = utcToZonedParts(instant, "America/Los_Angeles");
    expect(pacific.day).toBe(31);
    expect(pacific.month).toBe(12);
    expect(pacific.year).toBe(2025);
  });

  it("handles a DST transition correctly for a zone that observes it", () => {
    // US DST starts 2026-03-08 at 02:00 local, springing forward to 03:00.
    // 2026-03-08 09:00 UTC is 01:00 local (before the jump, UTC-8 / PST).
    const before = zonedTimeToUtc(
      { year: 2026, month: 3, day: 8, hour: 1, minute: 0 },
      "America/Los_Angeles",
    );
    // 2026-03-08 09:00 UTC exactly, since 01:00 PST = 09:00 UTC.
    expect(before.toISOString()).toBe("2026-03-08T09:00:00.000Z");

    // 2026-03-08 03:00 local (after the jump, PDT/UTC-7) == 10:00 UTC.
    const after = zonedTimeToUtc(
      { year: 2026, month: 3, day: 8, hour: 3, minute: 0 },
      "America/Los_Angeles",
    );
    expect(after.toISOString()).toBe("2026-03-08T10:00:00.000Z");
  });
});
