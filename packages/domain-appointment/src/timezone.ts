/**
 * doctor_availability stores wall-clock time-of-day ("HH:mm") in the
 * clinic's local timezone; appointments/slots store UTC instants
 * (docs/DATABASE.md §3). Converting between the two correctly - including
 * across a DST transition, for any IANA zone, not just a fixed IST
 * offset - is exactly the "clock/timezone correctness" risk flagged in
 * docs/ARCHITECTURE.md §11, so it gets a real, tested implementation
 * rather than a hardcoded +05:30.
 *
 * Node ships full ICU data by default, so Intl.DateTimeFormat works
 * correctly for any IANA timeZone without an extra dependency.
 */

export interface ZonedDateParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
}

/**
 * Interprets the given Y/M/D H:M as wall-clock time in `timeZone` and
 * returns the equivalent UTC instant.
 *
 * A single guess-then-correct pass (compute the offset at the guessed UTC
 * instant, then subtract it) is wrong right around a DST transition: the
 * offset AT the guess can differ from the offset that actually applies to
 * the intended local time, silently landing an hour off. A second
 * correction pass, using the offset at the first-pass result instead of
 * at the raw guess, converges correctly - this is the standard fixed-point
 * approach (what libraries like luxon/date-fns-tz do internally) and is
 * covered by the DST-transition test in timezone.test.ts.
 */
export function zonedTimeToUtc(parts: ZonedDateParts, timeZone: string): Date {
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  const firstPass = utcGuess - getOffsetMs(new Date(utcGuess), timeZone);
  const secondPass = utcGuess - getOffsetMs(new Date(firstPass), timeZone);
  return new Date(secondPass);
}

/** Inverse: what does this UTC instant read as on a wall clock in `timeZone`? */
export function utcToZonedParts(instant: Date, timeZone: string): ZonedDateParts & { dayOfWeek: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
  const map = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const weekdayIndex = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(
    map["weekday"] ?? "",
  );
  return {
    year: Number(map["year"]),
    month: Number(map["month"]),
    day: Number(map["day"]),
    hour: Number(map["hour"]),
    minute: Number(map["minute"]),
    dayOfWeek: weekdayIndex,
  };
}

/**
 * How far `timeZone`'s wall clock is ahead of UTC at `instant`, in
 * milliseconds (e.g. +19800000 for IST's fixed UTC+05:30).
 */
function getOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const map = Object.fromEntries(dtf.formatToParts(instant).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(map["year"]),
    Number(map["month"]) - 1,
    Number(map["day"]),
    Number(map["hour"]),
    Number(map["minute"]),
    Number(map["second"]),
  );
  return asUtc - instant.getTime();
}

export function parseHHmm(value: string): { hour: number; minute: number } {
  const match = /^([0-1]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid HH:mm value: ${value}`);
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function addDaysUtc(date: Date, days: number): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
