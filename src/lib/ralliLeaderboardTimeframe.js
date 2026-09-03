/**
 * Ralli Live Leaderboard — timeframe / timezone math (pure, dependency-free).
 *
 * Boundaries are half-open [from, to) evaluated in the ORG timezone against the
 * authoritative session-completion timestamp. Kept import-free so it is unit-testable
 * under `node --test` (no Vite / supabase client in the import chain).
 */

// Current month is the default. "Last N months" is the trailing window of N calendar
// months INCLUDING the current month (Last 2 = previous month + current month).
// "Current calendar year" is Jan 1 → next Jan 1.
export const TIMEFRAMES = [
  { id: "current_month", label: "Current month", months: 1 },
  { id: "last_2_months", label: "Last 2 months", months: 2 },
  { id: "last_3_months", label: "Last 3 months", months: 3 },
  { id: "last_4_months", label: "Last 4 months", months: 4 },
  { id: "current_year", label: "Current calendar year", year: true },
];
export const DEFAULT_TIMEFRAME = "current_month";

// Offset (localWall − UTC) in ms that timezone `tz` had at the instant `utcMs`.
function tzOffsetMs(tz, utcMs) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) map[p.type] = p.value;
  const asUTC = Date.UTC(
    +map.year, +map.month - 1, +map.day,
    +map.hour % 24, +map.minute, +map.second
  );
  return asUTC - utcMs;
}

// The UTC instant of a wall-clock time (y, monthIndex, day, …) in timezone `tz`.
// Two-pass to resolve DST transitions correctly at month/year boundaries.
export function zonedWallToUtc(tz, y, monthIndex, day, h = 0, mi = 0, s = 0) {
  const naive = Date.UTC(y, monthIndex, day, h, mi, s); // wall clock read as if UTC
  let off = tzOffsetMs(tz, naive);
  const utc = naive - off;
  off = tzOffsetMs(tz, utc);
  return new Date(naive - off);
}

// The org-local calendar year/month/day of the instant `now` in timezone `tz`.
function nowPartsInTz(tz, now) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const map = {};
  for (const p of dtf.formatToParts(now)) map[p.type] = p.value;
  return { y: +map.year, mo: +map.month - 1, d: +map.day };
}

// Resolve a timeframe id + org timezone into half-open [fromISO, toISO) UTC instants.
export function computeTimeframeRange(timeframeId, tz = "UTC", now = new Date()) {
  const tf = TIMEFRAMES.find((t) => t.id === timeframeId) || TIMEFRAMES[0];
  const { y, mo } = nowPartsInTz(tz, now);
  let from, to;
  if (tf.year) {
    from = zonedWallToUtc(tz, y, 0, 1);      // Jan 1, this year (org tz)
    to = zonedWallToUtc(tz, y + 1, 0, 1);    // Jan 1, next year
  } else {
    const n = tf.months || 1;
    from = zonedWallToUtc(tz, y, mo - (n - 1), 1); // start of the first month in the window
    to = zonedWallToUtc(tz, y, mo + 1, 1);         // start of next month (exclusive)
  }
  return { fromISO: from.toISOString(), toISO: to.toISOString() };
}
