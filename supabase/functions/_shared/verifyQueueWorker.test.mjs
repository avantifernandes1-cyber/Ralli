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

// ── Batch orchestration ──────────────────────────────────────────────────────
function makeDeps({ jobs = [], verify = async () => ({ status: "verified" }), clock } = {}) {
  const completed = [];
  const q = jobs.slice();
  const deps = {
    claimJob: async () => (q.length ? { claimed: true, session_id: q.shift() } : { claimed: false }),
    verifyOne: verify,
    completeJob: async (sid, ok, err) => { completed.push({ sid, ok, err }); },
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

test("one successful job → verified + completed(ok=true)", async () => {
  const { deps, completed } = makeDeps({ jobs: ["s1"] });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 1);
  assert.equal(s.verified, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: true, err: null }]);
});

test("multi-job batch processes each once, bounded by maxBatch", async () => {
  const { deps, completed } = makeDeps({ jobs: ["s1", "s2", "s3", "s4"] });
  const s = await runVerificationBatch(deps, { maxBatch: 3 });
  assert.equal(s.claimed, 3);          // stops at maxBatch even though 4 are queued
  assert.equal(completed.length, 3);
});

test("one failing job does not block later jobs", async () => {
  const verify = async (sid) => { if (sid === "s2") throw new Error("verification write failed"); return { status: "verified" }; };
  const { deps, completed } = makeDeps({ jobs: ["s1", "s2", "s3"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 3);
  assert.equal(s.verified, 2);
  assert.equal(s.retried, 1);
  const s2 = completed.find((c) => c.sid === "s2");
  assert.equal(s2.ok, false);
  assert.equal(s2.err, "verification write failed");
  assert.ok(completed.some((c) => c.sid === "s3" && c.ok === true)); // s3 still processed
});

test("ineligible/already-verified session is completed idempotently (ok=true)", async () => {
  const verify = async () => ({ status: "ineligible", reason: "demo_session" });
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.ineligible, 1);
  assert.deepEqual(completed, [{ sid: "s1", ok: true, err: null }]);
});

test("duplicate/concurrent safety: claim yielding nothing (skip-locked) → empty, no work", async () => {
  const deps = { claimJob: async () => ({ claimed: false }), verifyOne: async () => ({ status: "verified" }), completeJob: async () => { throw new Error("should not complete"); } };
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimed, 0);
  assert.equal(s.empty, true);
});

test("no secret/answer material leaks into the recorded failure", async () => {
  const secret = "SERVICE_ROLE_KEY=eyJsecretTOKEN; correct_answer=42; snapshot={...}";
  const verify = async () => { throw new Error(secret); };
  const { deps, completed } = makeDeps({ jobs: ["s1"], verify });
  await runVerificationBatch(deps, { maxBatch: 5 });
  const rec = completed[0].err;
  assert.equal(rec, "verification error");            // collapsed to generic
  assert.ok(!rec.includes("eyJ") && !rec.includes("correct_answer") && !rec.includes("snapshot"));
});

test("sanitizeError passes known transient codes but collapses unknowns", () => {
  assert.equal(sanitizeError(new Error("answers load failed")), "answers load failed");
  assert.equal(sanitizeError(new Error("Bearer sk_live_xyz leaked")), "verification error");
  assert.equal(sanitizeError({}), "verification error");
});

test("runtime cap stops the batch even with jobs remaining", async () => {
  let t = 0;
  const clock = () => (t += 10_000); // each now() call advances 10s
  const { deps, completed } = makeDeps({ jobs: ["s1", "s2", "s3", "s4", "s5"], clock });
  const s = await runVerificationBatch(deps, { maxBatch: 50, maxRuntimeMs: 25_000 });
  assert.equal(s.stoppedForTime, true);
  assert.ok(s.claimed < 5); // stopped early on the runtime budget
});

test("claim failure stops the batch cleanly (claimError)", async () => {
  const deps = { claimJob: async () => { throw new Error("db down"); }, verifyOne: async () => ({ status: "verified" }), completeJob: async () => {} };
  const s = await runVerificationBatch(deps, { maxBatch: 5 });
  assert.equal(s.claimError, true);
  assert.equal(s.claimed, 0);
});
