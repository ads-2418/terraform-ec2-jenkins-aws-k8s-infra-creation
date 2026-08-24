import type { Prisma } from "@app/db";
import { addDaysUtc, parseHHmm, utcToZonedParts, zonedTimeToUtc } from "./timezone.js";

export interface FreeInterval {
  startAt: Date;
  endAt: Date;
}

export interface AvailableDoctor {
  doctorId: string;
  displayName: string;
  specialty: string | null;
  photoUrl: string | null;
  freeRanges: FreeInterval[];
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Same convention as availability.ts: a holiday's `date` is a calendar day written as UTC midnight, read back with UTC getters. */
function holidayDateKey(date: Date): string {
  return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

interface WindowLike {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

/**
 * Raw working-hour intervals (not discretized into fixed-size slots like
 * generateCandidateSlots) for one doctor over [from, to) - unioned across
 * every one of their windows regardless of service scoping, since "is this
 * doctor working at all right now" doesn't care which service a window is
 * restricted to.
 */
function projectWorkingIntervals(args: {
  windows: WindowLike[];
  clinicTimezone: string;
  from: Date;
  to: Date;
  holidayDates: Set<string>;
}): FreeInterval[] {
  const intervals: FreeInterval[] = [];
  const fromLocal = utcToZonedParts(args.from, args.clinicTimezone);
  let cursor = zonedTimeToUtc(
    { year: fromLocal.year, month: fromLocal.month, day: fromLocal.day, hour: 0, minute: 0 },
    args.clinicTimezone,
  );

  // Bounded loop, same rationale as generateCandidateSlots.
  for (let i = 0; i < 370 && cursor < args.to; i++, cursor = addDaysUtc(cursor, 1)) {
    const local = utcToZonedParts(cursor, args.clinicTimezone);
    if (args.holidayDates.has(dateKey(local.year, local.month, local.day))) continue;

    for (const w of args.windows) {
      if (w.dayOfWeek !== local.dayOfWeek) continue;
      const start = parseHHmm(w.startTime);
      const end = parseHHmm(w.endTime);
      const windowStart = zonedTimeToUtc(
        { year: local.year, month: local.month, day: local.day, hour: start.hour, minute: start.minute },
        args.clinicTimezone,
      );
      const windowEnd = zonedTimeToUtc(
        { year: local.year, month: local.month, day: local.day, hour: end.hour, minute: end.minute },
        args.clinicTimezone,
      );
      // Clip to effectiveFrom/effectiveUntil rather than dropping the whole
      // day when the boundary falls partway through it - a window created
      // mid-afternoon must still show the rest of that same day as free
      // (matching generateCandidateSlots' per-slot check in availability.ts,
      // which is exactly why a doctor whose window was just added showed
      // real bookable slots there but nothing here before this fix).
      const effectiveStart = w.effectiveFrom > windowStart ? w.effectiveFrom : windowStart;
      const effectiveEnd = w.effectiveUntil && w.effectiveUntil < windowEnd ? w.effectiveUntil : windowEnd;

      const clippedStart = effectiveStart < args.from ? args.from : effectiveStart;
      const clippedEnd = effectiveEnd > args.to ? args.to : effectiveEnd;
      if (clippedStart < clippedEnd) intervals.push({ startAt: clippedStart, endAt: clippedEnd });
    }
  }

  return intervals;
}

/** Subtracts busy intervals from one working interval, returning the free remainder(s) in chronological order. */
function subtractBusy(working: FreeInterval, busy: FreeInterval[]): FreeInterval[] {
  const relevant = busy
    .filter((b) => b.startAt < working.endAt && b.endAt > working.startAt)
    .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

  const free: FreeInterval[] = [];
  let cursor = working.startAt;
  for (const b of relevant) {
    if (b.startAt > cursor) free.push({ startAt: cursor, endAt: b.startAt });
    if (b.endAt > cursor) cursor = b.endAt;
  }
  if (cursor < working.endAt) free.push({ startAt: cursor, endAt: working.endAt });
  return free;
}

/**
 * "Who's free, and for how long?" - the reverse of computeAvailability's
 * "is doctor X free": given a clinic and a time window, returns every
 * ACTIVE doctor with at least one open (working-hours minus
 * appointments/busy-blocks minus holidays) stretch of time inside that
 * window, along with their free ranges. Powers the receptionist/patient
 * "which doctors can I see right now" lookup - docs/API.md.
 */
export async function findAvailableDoctors(
  tx: Prisma.TransactionClient,
  input: { tenantId: string; clinicId: string; from: Date; to: Date },
): Promise<AvailableDoctor[]> {
  const [clinic, doctors] = await Promise.all([
    tx.clinic.findUniqueOrThrow({ where: { id: input.clinicId } }),
    tx.doctor.findMany({ where: { clinicId: input.clinicId, status: "ACTIVE" }, orderBy: { displayName: "asc" } }),
  ]);
  if (doctors.length === 0) return [];

  const doctorIds = doctors.map((d) => d.id);
  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  const [allWindows, holidays, appointments, busyBlocks] = await Promise.all([
    tx.doctorAvailability.findMany({
      where: {
        doctorId: { in: doctorIds },
        effectiveFrom: { lte: input.to },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: input.from } }],
      },
    }),
    tx.holiday.findMany({
      where: {
        clinicId: input.clinicId,
        OR: [{ doctorId: null }, { doctorId: { in: doctorIds } }],
        date: { gte: new Date(input.from.getTime() - ONE_DAY_MS), lte: new Date(input.to.getTime() + ONE_DAY_MS) },
      },
      select: { doctorId: true, date: true },
    }),
    tx.appointment.findMany({
      where: {
        doctorId: { in: doctorIds },
        status: { in: ["HELD", "CONFIRMED"] },
        startAt: { lt: input.to },
        endAt: { gt: input.from },
      },
      select: { doctorId: true, startAt: true, endAt: true },
    }),
    tx.calendarBusyBlock.findMany({
      where: { doctorId: { in: doctorIds }, startAt: { lt: input.to }, endAt: { gt: input.from } },
      select: { doctorId: true, startAt: true, endAt: true },
    }),
  ]);

  const results: AvailableDoctor[] = [];

  for (const doctor of doctors) {
    const windows = allWindows.filter((w) => w.doctorId === doctor.id);
    if (windows.length === 0) continue;

    const holidayDates = new Set(
      holidays.filter((h) => h.doctorId === null || h.doctorId === doctor.id).map((h) => holidayDateKey(h.date)),
    );

    const working = projectWorkingIntervals({
      windows,
      clinicTimezone: clinic.timezone,
      from: input.from,
      to: input.to,
      holidayDates,
    });
    if (working.length === 0) continue;

    const busy = [
      ...appointments.filter((a) => a.doctorId === doctor.id),
      ...busyBlocks.filter((b) => b.doctorId === doctor.id),
    ];

    const freeRanges = working
      .flatMap((w) => subtractBusy(w, busy))
      .filter((r) => r.endAt > r.startAt)
      .sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
    if (freeRanges.length === 0) continue;

    results.push({
      doctorId: doctor.id,
      displayName: doctor.displayName,
      specialty: doctor.specialty,
      photoUrl: doctor.photoUrl,
      freeRanges,
    });
  }

  return results;
}
