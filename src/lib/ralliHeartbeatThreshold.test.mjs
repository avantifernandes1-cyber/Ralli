// Guard: the durable-active freshness threshold must stay IDENTICAL across the frontend and the
// database (migration 085 exposure), and the comparison must be STRICT ("<"). This catches a future
// edit that changes one side (e.g. back to a 25s or an inclusive rule) without the other.
// Static-source assertions (same idiom as the app*/cors wiring tests).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const mig = readFileSync(join(here, "..", "..", "supabase", "migrations", "085_ralli_live_leaderboard_foundation.sql"), "utf8");

test("frontend defines HEARTBEAT_FRESH_MS = 40000", () => {
  const m = app.match(/HEARTBEAT_FRESH_MS\s*=\s*(\d+)/);
  assert.ok(m, "HEARTBEAT_FRESH_MS constant present");
  assert.equal(Number(m[1]), 40000);
});

test("migration 085 freshness window = interval '40 seconds'", () => {
  const m = mig.match(/ralli_heartbeat_fresh_window\(\)[\s\S]{0,120}?SELECT interval '(\d+) seconds'/);
  assert.ok(m, "ralli_heartbeat_fresh_window helper present");
  assert.equal(Number(m[1]), 40);
});

test("frontend ms and database seconds describe the SAME window", () => {
  const feMs = Number(app.match(/HEARTBEAT_FRESH_MS\s*=\s*(\d+)/)[1]);
  const dbS = Number(mig.match(/SELECT interval '(\d+) seconds'\s*\$\$/)[1]);
  assert.equal(feMs, dbS * 1000, "40000ms must equal 40s");
});

test("085 exposure freshness comparison is STRICT (<) — matches the frontend's strict `<`", () => {
  assert.match(mig, /\(now\(\) - gsp\.last_seen_at\)\s*<\s*public\.ralli_heartbeat_fresh_window\(\)/);
  assert.ok(!/last_seen_at\)\s*<=\s*public\.ralli_heartbeat_fresh_window/.test(mig), "must not be inclusive (<=)");
});

test("frontend freshness checks use strict `< HEARTBEAT_FRESH_MS` (never <=)", () => {
  assert.ok(!/<=\s*HEARTBEAT_FRESH_MS/.test(app), "no inclusive <= against HEARTBEAT_FRESH_MS");
  assert.match(app, /<\s*HEARTBEAT_FRESH_MS/);
});

test("no stale ~25s heartbeat/freshness documentation remains", () => {
  // Allow unrelated '25' (e.g. CSS 0.25s); forbid it next to heartbeat/freshness/stale wording.
  const bad = app.match(/[^.]\b25s?\b[^%]{0,30}(freshness|heartbeat|stale)/i) ||
              app.match(/(freshness|heartbeat|stale)[^%]{0,30}\b25s?\b/i);
  assert.equal(bad, null, bad ? `stale 25s reference: ${bad[0]}` : "");
});
