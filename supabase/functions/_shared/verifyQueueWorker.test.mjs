import test from "node:test";
import assert from "node:assert/strict";
import { runVerificationBatch, isAuthorizedWorkerRequest, safeEqual, sanitizeError } from "./verifyQueueWorker.js";

// ── Auth gate ────────────────────────────────────────────────────────────────
test("worker auth: only the exact service-role bearer is accepted", () => {
  const key = "svc_role_key_ABC123";
  assert.equal(isAuthorizedWorkerRequest(`Bearer ${key}`, key), true);
});
test("worker auth: anonymous / ordinary / malformed callers denied", () => {
  const key = "svc_role_key_ABC123";
  assert.equal(isAuthorizedWorkerRequest("", key), false);                 // no header
  assert.equal(isAuthorizedWorkerRequest("Bearer ", key), false);          // empty token
  assert.equal(isAuthorizedWorkerRequest("Bearer user.jwt.token", key), false); // ordinary user
  assert.equal(isAuthorizedWorkerRequest(`Bearer ${key}x`, key), false);   // wrong length
  assert.equal(isAuthorizedWorkerRequest(`Basic ${key}`, key), false);     // wrong scheme
  assert.equal(isAuthorizedWorkerRequest(`Bearer ${key}`, ""), false);     // no configured key ⇒ deny
});
test("safeEqual is length-checked and value-correct", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
});

// ── Batch orchestration (verifyOne returns a typed { outcome }) ───────────────
function makeDeps({ jobs = [], verify = async () => ({ outcome: "verified" }), clock } = {}) {
  const completed = [];
  const q = jobs.slice();
  const deps = {
    claimJob: async () => (q.length ? { claimed: true, session_id: q.shift() } : { claimed: false }),
    verifyOne: verify,
    completeJob: async (sid, ok, terminal, err) => { completed.push({ sid, ok, terminal, err }); },
    now: clock,
  };
  return { deps, completed };
}

test("empty queue → nothing claimed, empty=true", async () => {
  const { deps, completed } = makeDeps({ jobs: [] });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 0);
  assert.equal(s.empty, true);
  assert.equal(completed.length, 0);
});

test("verified → completed ok=true (not terminal)", async () => {
  const { deps, completed } = makeDeps({ jobs: ["s1"] });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.verified, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: true, terminal: false, err: null }]);
});

test("already-verified (idempotent) is counted and completed ok=true", async () => {
  const verify = async () => ({ outcome: "verified", idempotent: true });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.verified, 1);
  assert.equal(s.idempotent, 1);
  assert.equal(completed[0].ok, true);
});

test("ineligible (demo/no_snapshot/terminal/not_found) → completed ok=true, no retry", async () => {
  const verify = async () => ({ outcome: "ineligible", reason: "demo_session" });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.ineligible, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: true, terminal: false, err: null }]);
});

test("not_ready → retry (ok=false, not terminal)", async () => {
  const verify = async () => ({ outcome: "not_ready" });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.retried, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: false, terminal: false, err: "not_ready" }]);
});

test("transient → retry (ok=false, not terminal, safe code)", async () => {
  const verify = async () => ({ outcome: "transient", code: "answers_load_failed" });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  await runVerificationBatch(deps, { maxBatch: 5 });
  assert.deepEqual(completed, [{ sid: "s1", ok: false, terminal: false, err: "answers_load_failed" }]);
});

test("integrity (snapshot hash mismatch) → TERMINAL fail-fast (ok=false, terminal=true)", async () => {
  const verify = async () => ({ outcome: "integrity", code: "snapshot_hash_mismatch" });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.terminal, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: false, terminal: true, err: "snapshot_hash_mismatch" }]);
});

test("bad_request / unauthorized → terminal fail-fast", async () => {
  for (const outcome of ["bad_request", "unauthorized"]) {
    const { deps, completed } = makeDeps({ jobs: ["s1"], verify: async () => ({ outcome }) });
    await runVerificationBatch(deps, { maxBatch: 5 });
    assert.equal(completed[0].ok, false);
    assert.equal(completed[0].terminal, true);
  }
});

test("one failing job does not block later jobs", async () => {
  const verify = async (sid) => (sid === "s2" ? { outcome: "transient", code: "verification_write_failed" } : { outcome: "verified" });
  const { deps, completed } = makeDeps({ jobs: ["s1", "s2", "s3"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 3);
  assert.equal(s.verified, 2);
  assert.equal(s.retried, 1);
  assert.ok(completed.some((c) => c.sid === "s3" && c.ok === true)); // s3 still processed
});

test("verifyOne throwing (unexpected) is contained → retry with sanitized code, batch continues", async () => {
  const secret = "SERVICE_ROLE_KEY=eyJsecretTOKEN; correct_answer=42; snapshot={...}";
  const verify = async (sid) => { if (sid === "s1") throw new Error(secret); return { outcome: "verified" }; };
  const { deps, completed } = makeDeps({ jobs: ["s1", "s2"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(completed[0].ok, false);
  assert.equal(completed[0].err, "verification error");          // collapsed to generic — no secret
  assert.ok(!completed[0].err.includes("eyJ") && !completed[0].err.includes("correct_answer"));
  assert.ok(completed.some((c) => c.sid === "s2" && c.ok === true));
});

test("duplicate/concurrent safety: claim yielding nothing (skip-locked) → empty, no work", async () => {
  const deps = { claimJob: async () => ({ claimed: false }), verifyOne: async () => ({ outcome: "verified" }), completeJob: async () => { throw new Error("should not complete"); } };
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 0);
  assert.equal(s.empty, true);
});

test("completeJob failure does not abort the batch (lease will recover the job)", async () => {
  const q = ["s1", "s2"];
  let calls = 0;
  const deps = {
    claimJob: async () => (q.length ? { claimed: true, session_id: q.shift() } : { claimed: false }),
    verifyOne: async () => ({ outcome: "verified" }),
    completeJob: async () => { calls++; throw new Error("complete failed"); },
    now: undefined,
  };
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 2);   // both still attempted despite completeJob throwing
  assert.equal(calls, 2);
});

test("runtime cap stops the batch even with jobs remaining", async () => {
  let t = 0;
  const clock = () => (t += 10_000);
  const { deps } = makeDeps({ jobs: ["s1", "s2", "s3", "s4", "s5"], clock });
  const s = await runVerificationBatch(deps, { maxBatch: 50, maxRuntimeMs: 25_000 });
  assert.equal(s.stoppedForTime, true);
  assert.ok(s.claimed < 5);
});

test("claim failure stops the batch cleanly (claimError)", async () => {
  const deps = { claimJob: async () => { throw new Error("db down"); }, verifyOne: async () => ({ outcome: "verified" }), completeJob: async () => {} };
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimError, true);
  assert.equal(s.claimed, 0);
});

test("sanitizeError passes known safe codes but collapses unknowns", () => {
  assert.equal(sanitizeError(new Error("answers_load_failed")), "answers_load_failed");
  assert.equal(sanitizeError(new Error("snapshot_hash_mismatch")), "snapshot_hash_mismatch");
  assert.equal(sanitizeError(new Error("Bearer sk_live_xyz leaked")), "verification error");
  assert.equal(sanitizeError({}), "verification error");
});
