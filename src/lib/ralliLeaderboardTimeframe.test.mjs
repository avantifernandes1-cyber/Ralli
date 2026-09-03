import test from "node:test";
import assert from "node:assert/strict";
import { TIMEFRAMES, DEFAULT_TIMEFRAME, computeTimeframeRange, zonedWallToUtc } from "./ralliLeaderboardTimeframe.js";

// Boundaries are half-open [from, to) in the ORG timezone, by authoritative completion timestamp.

test("default timeframe is current month", () => {
  assert.equal(DEFAULT_TIMEFRAME, "current_month");
});

test("UTC current month: from=1st 00:00Z, to=1st of next month 00:00Z (half-open)", () => {
  const now = new Date("2026-08-31T23:30:00Z"); // still August in UTC
  const { fromISO, toISO } = computeTimeframeRange("current_month", "UTC", now);
  assert.equal(fromISO, "2026-08-01T00:00:00.000Z");
  assert.equal(toISO, "2026-09-01T00:00:00.000Z");
});

test("UTC last 2 months = previous + current month", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("last_2_months", "UTC", now);
  assert.equal(fromISO, "2026-07-01T00:00:00.000Z");
  assert.equal(toISO, "2026-09-01T00:00:00.000Z");
});

test("UTC last 4 months spans a year boundary correctly", () => {
  const now = new Date("2026-02-10T12:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("last_4_months", "UTC", now);
  assert.equal(fromISO, "2025-11-01T00:00:00.000Z"); // Nov, Dec, Jan, Feb
  assert.equal(toISO, "2026-03-01T00:00:00.000Z");
});

test("UTC current calendar year", () => {
  const now = new Date("2026-06-06T00:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("current_year", "UTC", now);
  assert.equal(fromISO, "2026-01-01T00:00:00.000Z");
  assert.equal(toISO, "2027-01-01T00:00:00.000Z");
});

// America/New_York: EDT is UTC-4 (summer), EST is UTC-5 (winter). Month starts are local midnight.
test("America/New_York current month: local midnight Aug 1 = 04:00Z (EDT)", () => {
  const now = new Date("2026-08-20T12:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("current_month", "America/New_York", now);
  assert.equal(fromISO, "2026-08-01T04:00:00.000Z"); // EDT (UTC-4)
  assert.equal(toISO, "2026-09-01T04:00:00.000Z");
});

test("America/New_York timezone drives which calendar month 'now' falls in", () => {
  // 2026-09-01T02:00:00Z is still Aug 31 21:00 in New York → current month must be August.
  const now = new Date("2026-09-01T02:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("current_month", "America/New_York", now);
  assert.equal(fromISO, "2026-08-01T04:00:00.000Z");
  assert.equal(toISO, "2026-09-01T04:00:00.000Z");
});

test("America/New_York window crossing the DST fall-back (Nov 1 2026): each boundary uses its own offset", () => {
  // Spring→Fall: Oct is EDT (UTC-4), Nov 1 onward the offset shifts to EST (UTC-5) on Nov 1 2026 (DST ends Nov 1).
  const now = new Date("2026-11-15T12:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("last_2_months", "America/New_York", now);
  // Oct 1 local midnight is EDT → 04:00Z; Dec 1 local midnight is EST → 05:00Z.
  assert.equal(fromISO, "2026-10-01T04:00:00.000Z");
  assert.equal(toISO, "2026-12-01T05:00:00.000Z");
});

test("America/New_York current-year boundaries are EST (winter, UTC-5) on both ends", () => {
  const now = new Date("2026-07-01T12:00:00Z");
  const { fromISO, toISO } = computeTimeframeRange("current_year", "America/New_York", now);
  assert.equal(fromISO, "2026-01-01T05:00:00.000Z");
  assert.equal(toISO, "2027-01-01T05:00:00.000Z");
});

test("zonedWallToUtc resolves a spring-forward gap without crashing (DST begins Mar 8 2026)", () => {
  // 02:30 local does not exist on the spring-forward day; the helper still yields a valid instant.
  const d = zonedWallToUtc("America/New_York", 2026, 2, 8, 2, 30, 0);
  assert.ok(d instanceof Date && !Number.isNaN(d.getTime()));
});

test("unknown timeframe id falls back to current month", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  const a = computeTimeframeRange("bogus", "UTC", now);
  const b = computeTimeframeRange("current_month", "UTC", now);
  assert.deepEqual(a, b);
});

test("ranges are strictly half-open and ascending for every timeframe", () => {
  const now = new Date("2026-08-15T12:00:00Z");
  for (const tf of TIMEFRAMES) {
    const { fromISO, toISO } = computeTimeframeRange(tf.id, "UTC", now);
    assert.ok(new Date(fromISO) < new Date(toISO), `${tf.id} from<to`);
  }
});
