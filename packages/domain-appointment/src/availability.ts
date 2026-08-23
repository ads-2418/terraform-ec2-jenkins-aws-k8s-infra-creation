import type { Prisma } from "@app/db";
import { NotFoundError } from "@app/shared";
import { addDaysUtc, parseHHmm, utcToZonedParts, zonedTimeToUtc } from "./timezone.js";

export interface CandidateSlot {
  startAt: Date;
  endAt: Date;
}

interface AvailabilityWindowLike {
  doctorId: string;
  serviceId: string | null;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  slotDurationMinutes: number;
  effectiveFrom: Date;
  effectiveUntil: Date | null;
}

function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Projects recurring weekly availability windows into candidate start
 * times over [from, to) - docs/APPOINTMENT_ENGINE.md §7. Pure function
 * (no I/O) so it's exercised directly by unit tests without a database.
 */
export function generateCandidateSlots(params: {
  windows: AvailabilityWindowLike[];
  serviceId: string;
  serviceDurationMinutes: number;
  clinicTimezone: string;
  from: Date;
  to: Date;
  now?: Date;
}): CandidateSlot[] {
  const { windows, serviceId, serviceDurationMinutes, clinicTimezone, from, to } = params;
  const now = params.now ?? new Date();
  const candidates: CandidateSlot[] = [];

  const relevantWindows = windows.filter(
    (w) => w.serviceId === null || w.serviceId === serviceId,
  );
  if (relevantWindows.length === 0) return [];

  const fromLocal = utcToZonedParts(from, clinicTimezone);
  let cursor = zonedTimeToUtc(
    { year: fromLocal.year, month: fromLocal.month, day: fromLocal.day, hour: 0, minute: 0 },
    clinicTimezone,
  );

  // Bounded loop: one iteration per local calendar day in [from, to].
  // `to` is a caller-supplied query range end, not user input directly,
  // but we still cap iterations defensively against a pathological range.
  for (let i = 0; i < 370 && cursor < to; i++, cursor = addDaysUtc(cursor, 1)) {
    const local = utcToZonedParts(cursor, clinicTimezone);
    const windowsForDay = relevantWindows.filter((w) => w.dayOfWeek === local.dayOfWeek);

    for (const window of windowsForDay) {
      const start = parseHHmm(window.startTime);
      const end = parseHHmm(window.endTime);
      const dayStartMinutes = start.hour * 60 + start.minute;
      const dayEndMinutes = end.hour * 60 + end.minute;

      for (
        let minuteOfDay = dayStartMinutes;
        minuteOfDay + serviceDurationMinutes <= dayEndMinutes;
        minuteOfDay += window.slotDurationMinutes
      ) {
        const slotStart = zonedTimeToUtc(
          {
            year: local.year,
            month: local.month,
            day: local.day,
            hour: Math.floor(minuteOfDay / 60),
            minute: minuteOfDay % 60,
          },
          clinicTimezone,
        );
        const slotEnd = new Date(slotStart.getTime() + serviceDurationMinutes * 60_000);

        if (slotStart < window.effectiveFrom) continue;
        if (window.effectiveUntil && slotStart > window.effectiveUntil) continue;
        if (slotStart < from || slotStart >= to) continue;
        if (slotStart <= now) continue;

        candidates.push({ startAt: slotStart, endAt: slotEnd });
      }
    }
  }

  candidates.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
  return candidates;
}

export interface ComputeAvailabilityInput {
  tenantId: string;
  doctorId: string;
  serviceId: string;
  from: Date;
  to: Date;
  now?: Date;
}

/**
 * The read path: computed live from doctor_availability minus active
 * appointments minus synced calendar busy blocks. Never cached at the
 * layer that feeds holdSlot's re-verification - see
 * docs/APPOINTMENT_ENGINE.md §7 on why a stale read here would violate
 * "availability must never rely only on cached information."
 */
export async function computeAvailability(
  tx: Prisma.TransactionClient,
  input: ComputeAvailabilityInput,
): Promise<CandidateSlot[]> {
  const [doctor, service] = await Promise.all([
    tx.doctor.findUnique({ where: { id: input.doctorId }, include: { clinic: true } }),
    tx.service.findUnique({ where: { id: input.serviceId } }),
  ]);
  if (!doctor) throw new NotFoundError("Doctor");
  if (!service) throw new NotFoundError("Service");

  const windows = await tx.doctorAvailability.findMany({
    where: {
      doctorId: input.doctorId,
      effectiveFrom: { lte: input.to },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: input.from } }],
    },
  });

  const candidates = generateCandidateSlots({
    windows,
    serviceId: input.serviceId,
    serviceDurationMinutes: service.durationMinutes,
    clinicTimezone: doctor.clinic.timezone,
    from: input.from,
    to: input.to,
    now: input.now,
  });

  if (candidates.length === 0) return [];

  const [activeAppointments, busyBlocks] = await Promise.all([
    tx.appointment.findMany({
      where: {
        doctorId: input.doctorId,
        status: { in: ["HELD", "CONFIRMED"] },
        startAt: { lt: input.to },
        endAt: { gt: input.from },
      },
      select: { startAt: true, endAt: true },
    }),
    tx.calendarBusyBlock.findMany({
      where: {
        doctorId: input.doctorId,
        startAt: { lt: input.to },
        endAt: { gt: input.from },
      },
      select: { startAt: true, endAt: true },
    }),
  ]);

  const occupied = [...activeAppointments, ...busyBlocks];

  return candidates.filter(
    (candidate) =>
      !occupied.some((block) =>
        overlaps(candidate.startAt, candidate.endAt, block.startAt, block.endAt),
      ),
  );
}

/**
 * Re-verification used inside holdSlot (docs/APPOINTMENT_ENGINE.md §3 step
 * 6) - is this exact [startAt, endAt) still within the doctor's working
 * hours? Deliberately narrower than computeAvailability: it does not
 * re-check appointment/busy-block conflicts, because holdSlot's own
 * row-lock + partial-unique-index path (§4) is what handles those - this
 * only guards against the doctor's hours themselves having changed since
 * the client last fetched availability.
 */
export async function isWithinDoctorAvailability(
  tx: Prisma.TransactionClient,
  args: { doctorId: string; serviceId: string; startAt: Date; endAt: Date; clinicTimezone: string },
): Promise<boolean> {
  const windows = await tx.doctorAvailability.findMany({
    where: {
      doctorId: args.doctorId,
      effectiveFrom: { lte: args.startAt },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: args.startAt } }],
    },
  });

  const durationMinutes = (args.endAt.getTime() - args.startAt.getTime()) / 60_000;
  const candidates = generateCandidateSlots({
    windows,
    serviceId: args.serviceId,
    serviceDurationMinutes: durationMinutes,
    clinicTimezone: args.clinicTimezone,
    from: args.startAt,
    to: new Date(args.startAt.getTime() + 1),
    now: new Date(0), // don't reject on the "must be in the future" check here - a hold in flight for a startAt a few ms out is still valid
  });

  return candidates.some((c) => c.startAt.getTime() === args.startAt.getTime());
}
