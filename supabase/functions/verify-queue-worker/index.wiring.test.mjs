// Executable wiring test for verify-queue-worker/index.ts. The handler uses Deno-only APIs
// (Deno.serve/env) so it can't be imported in Node; this asserts the exact source wiring instead
// (same idiom as verify-game-session/index.cors.test.mjs and the repo's app*.test.mjs).
// Run: node supabase/functions/verify-queue-worker/index.wiring.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");

test("reuses the shared canonical verification path and the pure orchestrator (no duplicated grader)", () => {
  assert.match(src, /from "\.\.\/_shared\/verifySession\.js"/);
  assert.match(src, /verifyCompletedSession/);
  assert.match(src, /from "\.\.\/_shared\/verifyQueueWorker\.js"/);
  assert.match(src, /runVerificationBatch/);
});

test("service-role-only gate runs before any admin client or DB work", () => {
  const gateIdx = src.indexOf("isAuthorizedWorkerRequest");
  const adminIdx = src.indexOf("createClient(SUPABASE_URL, SERVICE_ROLE_KEY");
  const claimIdx = src.indexOf("rpc_claim_verification_job");
  assert.ok(gateIdx > 0, "gate present");
  assert.ok(gateIdx < adminIdx, "gate before service-role client");
  assert.ok(gateIdx < claimIdx, "gate before any claim");
  assert.match(src, /return json\(\{ error: "unauthorized" \}, 401\)/);
});

test("uses the migration-085 claim + complete RPCs", () => {
  assert.match(src, /rpc\("rpc_claim_verification_job"\)/);
  assert.match(src, /rpc\("rpc_complete_verification_job"/);
});

test("bounded batch and wall-clock budget are set (< the processing lease window)", () => {
  assert.match(src, /MAX_BATCH\s*=\s*\d+/);
  assert.match(src, /MAX_RUNTIME_MS\s*=\s*\d[\d_]*/);
  const m = src.match(/MAX_RUNTIME_MS\s*=\s*([\d_]+)/);
  const ms = Number(m[1].replace(/_/g, ""));
  assert.ok(ms > 0 && ms < 5 * 60 * 1000, "runtime budget below the 5-minute lease window");
});

test("service-role key comes from function env and is never logged; no console.* leaks", () => {
  assert.match(src, /Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/);
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(src), "no console logging in the worker");
});

test("only counts are returned (no answer/snapshot/secret material in the response)", () => {
  assert.match(src, /ok: true, \.\.\.summary/);
  assert.ok(!/question_snapshot|answer_text|verdicts/.test(src), "worker response builds from summary counts only");
});

test("method gate rejects non-POST", () => {
  assert.match(src, /req\.method !== "POST"/);
});
