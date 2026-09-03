import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runVerificationBatch, isAuthorizedWorkerRequest, decodeSignedJwt, sanitizeError, WORKER_TRUSTED_ROLE } from "./verifyQueueWorker.js";

// ── Worker authorization (claim-based, post-gateway) ─────────────────────────
// DISTINCTION these tests make explicit:
//   • CRYPTO ENFORCEMENT (signature, project binding, expiry) is done by the Supabase platform
//     gateway (verify_jwt=true) BEFORE the worker runs. These unit tests exercise the POST-GATEWAY
//     authorization logic; test tokens carry an arbitrary (fake) signature segment because the worker
//     correctly does NOT re-verify the signature — that would require the project JWT secret.
//   • WORKER CODE additionally admits only role==="service_role", re-checks expiry, optionally pins the
//     project ref when present, and structurally rejects unsigned/alg:none/malformed tokens so it is
//     not a forgeable claim reader if ever run without the gateway.
const NOW = 1_700_000_000;                    // fixed test clock (seconds)
const REF = "jdwqaypjxnnvxbqnxpet";
const b64url = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v), "utf8").toString("base64url");
// Build a compact JWS test token. A non-empty `sig` stands in for "gateway-verified".
function jwt({ header = { alg: "HS256", typ: "JWT" }, payload = {}, sig = "gateway_verified_sig" } = {}) {
  return `${b64url(header)}.${b64url(payload)}.${sig}`;
}
const svc = (over = {}) => jwt({ payload: { role: "service_role", ref: REF, iat: NOW - 10, exp: NOW + 3600, ...over } });
const auth = (h, o = { now: NOW, projectRef: REF }) => isAuthorizedWorkerRequest(h, o);

test("1) a gateway-verified service_role JWT is accepted", () => {
  assert.equal(auth(`Bearer ${svc()}`), true);
});

test("2) a DIFFERENT service_role JWT string (same identity) is also accepted — string-equality is gone", () => {
  const t1 = jwt({ payload: { role: "service_role", ref: REF, iat: 1, exp: NOW + 3600 }, sig: "sigAAAA" });
  const t2 = jwt({ payload: { role: "service_role", ref: REF, iat: 2, exp: NOW + 7200 }, sig: "sigZZZZ" });
  assert.notEqual(t1, t2);
  assert.equal(auth(`Bearer ${t1}`), true);
  assert.equal(auth(`Bearer ${t2}`), true);
});

test("3) authenticated JWT denied", () => {
  assert.equal(auth(`Bearer ${jwt({ payload: { role: "authenticated", ref: REF, exp: NOW + 3600 } })}`), false);
});

test("4-6) learner / manager / org-admin (app roles under role=authenticated) denied", () => {
  for (const appRole of ["learner", "manager", "org_admin"]) {
    const t = jwt({ payload: { role: "authenticated", ref: REF, exp: NOW + 3600, app_metadata: { role: appRole } } });
    assert.equal(auth(`Bearer ${t}`), false, `${appRole} must be denied`);
  }
});

test("7) anon JWT denied", () => {
  assert.equal(auth(`Bearer ${jwt({ payload: { role: "anon", ref: REF, exp: NOW + 3600 } })}`), false);
});

test("8) publishable key denied (not a JWT)", () => {
  assert.equal(auth("Bearer sb_publishable_23QmHMDguaI4sVgkSXdGZQ_6-zV9KCF"), false);
});

test("9) sb_secret_ key denied as a JWT bearer (not a JWT)", () => {
  assert.equal(auth("Bearer sb_secret_ABCDEFghijklmnop0123456789"), false);
});

test("10) malformed tokens denied", () => {
  assert.equal(auth("Bearer abc"), false);       // no dots
  assert.equal(auth("Bearer a.b"), false);       // 2 segments
  assert.equal(auth("Bearer a.b.c.d"), false);   // 4 segments
  assert.equal(auth("Bearer !.!.!"), false);     // not base64url / JSON
  assert.equal(auth(""), false);                  // no header
  assert.equal(auth("Bearer "), false);           // empty token
  assert.equal(auth(`Basic ${svc()}`), false);    // wrong scheme
});

test("11) unsigned / alg:none tokens denied (structural, defense-in-depth)", () => {
  assert.equal(auth(`Bearer ${jwt({ header: { alg: "none" }, payload: { role: "service_role", ref: REF, exp: NOW + 3600 }, sig: "" })}`), false);
  assert.equal(auth(`Bearer ${jwt({ header: { alg: "none" }, payload: { role: "service_role", ref: REF, exp: NOW + 3600 }, sig: "x" })}`), false);
  assert.equal(auth(`Bearer ${jwt({ payload: { role: "service_role", ref: REF, exp: NOW + 3600 }, sig: "" })}`), false);
});

test("12) expired service_role JWT denied", () => {
  assert.equal(auth(`Bearer ${svc({ exp: NOW - 10 })}`), false);
});

test("13) wrong-project denied via optional ref pin; a token WITHOUT ref is NOT rejected (gateway is the project boundary)", () => {
  assert.equal(auth(`Bearer ${svc({ ref: "someotherproject" })}`), false);
  const noRef = jwt({ payload: { role: "service_role", exp: NOW + 3600 } });
  assert.equal(auth(`Bearer ${noRef}`), true);
});

test("14) missing role claim denied", () => {
  assert.equal(auth(`Bearer ${jwt({ payload: { ref: REF, exp: NOW + 3600 } })}`), false);
});

test("15) a spoofed role in a NON-gateway-verified (unsigned/alg:none) token cannot be accepted", () => {
  assert.equal(auth(`Bearer ${jwt({ header: { alg: "none" }, payload: { role: "service_role", ref: REF, exp: NOW + 3600 }, sig: "" })}`), false);
  assert.equal(decodeSignedJwt(jwt({ header: { alg: "none" }, payload: { role: "service_role" }, sig: "" })), null);
});

test("16) authorization returns a boolean only (no token/claims returned); shared module has no logging", () => {
  assert.equal(typeof auth(`Bearer ${svc()}`), "boolean");
  assert.equal(typeof auth("Bearer nope"), "boolean");
  const modSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "verifyQueueWorker.js"), "utf8");
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(modSrc), "no console.* in the shared worker module");
  assert.equal(WORKER_TRUSTED_ROLE, "service_role");
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
