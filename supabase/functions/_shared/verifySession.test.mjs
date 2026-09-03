import test from "node:test";
import assert from "node:assert/strict";
import { verifyLoadedSession, verifyCompletedSession, VERIFICATION_SOURCE_EDGE, VERIFICATION_SOURCE_WORKER } from "./verifySession.js";
import { buildSessionVerdicts, GRADER_VERSION } from "./gameGrading.js";

// ── Fake service-role client (records rpc calls; returns configured reads/writes) ───
function fakeAdmin({ session = null, sessionError = null, answers = [], answersError = null, rpc } = {}) {
  const calls = { rpc: [], sessionSelects: 0, answerSelects: 0 };
  const client = {
    from(table) {
      return {
        select() {
          return {
            eq() {
              if (table === "game_answers") {
                calls.answerSelects++;
                const result = { data: answersError ? null : answers, error: answersError };
                return { then: (r) => r(result), maybeSingle: async () => result };
              }
              calls.sessionSelects++;
              const result = { data: sessionError ? null : session, error: sessionError };
              return { maybeSingle: async () => result, then: (r) => r(result) };
            },
          };
        },
      };
    },
    async rpc(name, args) { calls.rpc.push({ name, args }); return rpc ? rpc(name, args) : { data: { status: "verified" }, error: null }; },
  };
  return { client, calls };
}

// A mixed snapshot exercising every auto-gradable type + open-ended (pending manual).
const SNAP = [
  { id: "q0", type: "mc", correct: 1, options: ["a", "b", "c"] },
  { id: "q1", type: "tf", correct: 0, options: ["True", "False"] },
  { id: "q2", type: "type", acceptedAnswers: ["HubSpot"] },
  { id: "q3", type: "slider", correct: 50, tolerance: 5 },
  { id: "q4", type: "match", pairs: [{ left: "L1", right: "R1" }, { left: "L2", right: "R2" }] },
  { id: "q5", type: "open" },
];
const ANSWERS = [
  { id: "a0", player_id: "p1", question_idx: 0, option_idx: 1, answered_at: "2026-09-01T00:00:00Z" },                 // mc correct
  { id: "a1", player_id: "p1", question_idx: 1, option_idx: 1, answered_at: "2026-09-01T00:00:01Z" },                 // tf wrong
  { id: "a2", player_id: "p1", question_idx: 2, answer_text: "  hubspot ", answered_at: "2026-09-01T00:00:02Z" },     // type: trim + case → correct
  { id: "a3", player_id: "p1", question_idx: 3, numeric_value: 0, answered_at: "2026-09-01T00:00:03Z" },              // slider zero → wrong
  { id: "a4", player_id: "p1", question_idx: 4, answer_json: [{ leftIdx: 0, rightText: "R1" }, { leftIdx: 1, rightText: "R2" }], answered_at: "2026-09-01T00:00:04Z" }, // match correct
  { id: "a5", player_id: "p1", question_idx: 5, answer_text: "free text", answered_at: "2026-09-01T00:00:05Z" },      // open → pending manual
];

const completedSession = { id: "S1", tenant_id: "T1", host_id: "H1", status: "completed", demo_mode: false, question_snapshot: SNAP };

test("verifyLoadedSession forwards EXACTLY the shared grader's verdicts across all types (parity)", async () => {
  const expected = buildSessionVerdicts(SNAP, ANSWERS);
  const { client, calls } = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: { status: "verified", idempotent: false }, error: null }) });
  const r = await verifyLoadedSession(client, completedSession, { source: VERIFICATION_SOURCE_EDGE });
  assert.equal(r.outcome, "verified");
  assert.equal(calls.rpc.length, 1);
  assert.equal(calls.rpc[0].name, "record_game_verification");
  assert.equal(calls.rpc[0].args.p_grader_version, GRADER_VERSION);
  assert.equal(calls.rpc[0].args.p_source, VERIFICATION_SOURCE_EDGE);
  assert.deepEqual(calls.rpc[0].args.p_verdicts, expected);                 // one canonical grader, faithfully forwarded
  assert.equal(expected.length, 6);                                         // mc/tf/type/slider/match/open all present
  // open-ended is pending manual (not auto-verifiable): verified_correct null
  const open = expected.find((v) => v.question_idx === 5);
  assert.equal(open.verified_correct, null);
});

test("manual (verifyLoadedSession) and worker (verifyCompletedSession) produce IDENTICAL verdicts + outcome", async () => {
  const mk = () => fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: { status: "verified", idempotent: false }, error: null }) });
  const a = mk(); const rA = await verifyLoadedSession(a.client, completedSession, { source: VERIFICATION_SOURCE_EDGE });
  const b = mk(); const rB = await verifyCompletedSession(b.client, "S1", { source: VERIFICATION_SOURCE_WORKER });
  assert.equal(rA.outcome, rB.outcome);
  assert.deepEqual(a.calls.rpc[0].args.p_verdicts, b.calls.rpc[0].args.p_verdicts);  // same eligibility/verdict set from both paths
});

test("idempotent already-verified → outcome verified, idempotent:true", async () => {
  const { client } = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: { status: "verified", idempotent: true, verified_scored_answers: 4 }, error: null }) });
  const r = await verifyLoadedSession(client, completedSession, {});
  assert.equal(r.outcome, "verified");
  assert.equal(r.idempotent, true);
});

test("missing snapshot → RPC records honest ineligible/no_snapshot → outcome ineligible", async () => {
  const s = { ...completedSession, question_snapshot: null };
  const { client, calls } = fakeAdmin({ session: s, rpc: () => ({ data: { status: "ineligible", reason: "no_snapshot", idempotent: false }, error: null }) });
  const r = await verifyLoadedSession(client, s, {});
  assert.equal(r.outcome, "ineligible");
  assert.equal(r.reason, "no_snapshot");
  assert.deepEqual(calls.rpc[0].args.p_verdicts, []);      // nothing to grade, still recorded durably
});

test("snapshot-hash mismatch (RPC raises) → terminal integrity outcome", async () => {
  const { client } = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: null, error: { message: "record_game_verification: snapshot hash mismatch for session S1 (frozen=x, now=y)" } }) });
  const r = await verifyLoadedSession(client, completedSession, {});
  assert.equal(r.outcome, "integrity");
  assert.equal(r.code, "snapshot_hash_mismatch");
});

test("other RPC error → transient (retryable)", async () => {
  const { client } = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: null, error: { message: "deadlock detected" } }) });
  const r = await verifyLoadedSession(client, completedSession, {});
  assert.equal(r.outcome, "transient");
  assert.equal(r.code, "verification_write_failed");
});

test("answers load failure → transient", async () => {
  const { client } = fakeAdmin({ session: completedSession, answersError: { message: "timeout" } });
  const r = await verifyLoadedSession(client, completedSession, {});
  assert.equal(r.outcome, "transient");
  assert.equal(r.code, "answers_load_failed");
});

test("worker path eligibility: demo / canceled / not-completed / not-found — no grading, no record call", async () => {
  const cases = [
    [{ ...completedSession, demo_mode: true }, "ineligible", "demo_session"],
    [{ ...completedSession, status: "canceled" }, "ineligible", "terminal_status"],
    [{ ...completedSession, status: "started" }, "not_ready", undefined],
  ];
  for (const [session, outcome, reason] of cases) {
    const { client, calls } = fakeAdmin({ session, answers: ANSWERS });
    const r = await verifyCompletedSession(client, "S1", {});
    assert.equal(r.outcome, outcome);
    if (reason) assert.equal(r.reason, reason);
    assert.equal(calls.rpc.length, 0, `${outcome} must not call the record RPC`);
    assert.equal(calls.answerSelects, 0, `${outcome} must not load answers`);
  }
  const nf = fakeAdmin({ session: null });
  const rNf = await verifyCompletedSession(nf.client, "S1", {});
  assert.equal(rNf.outcome, "ineligible"); assert.equal(rNf.reason, "not_found");
  assert.equal(nf.calls.rpc.length, 0);
});

test("session load failure → transient; bad request → bad_request", async () => {
  const le = fakeAdmin({ sessionError: { message: "conn reset" } });
  assert.equal((await verifyCompletedSession(le.client, "S1", {})).outcome, "transient");
  const br = fakeAdmin({});
  assert.equal((await verifyCompletedSession(br.client, null, {})).outcome, "bad_request");
  assert.equal(br.calls.sessionSelects, 0);
});

test("entrypoint-supplied authorize policy gates the shared loader", async () => {
  const deny = fakeAdmin({ session: completedSession, answers: ANSWERS });
  const rDeny = await verifyCompletedSession(deny.client, "S1", { authorize: () => false });
  assert.equal(rDeny.outcome, "unauthorized");
  assert.equal(deny.calls.rpc.length, 0);        // denied before any grading/persistence
  const allow = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: { status: "verified" }, error: null }) });
  const rAllow = await verifyCompletedSession(allow.client, "S1", { authorize: async () => true });
  assert.equal(rAllow.outcome, "verified");
  // authorize throwing is treated as denial (never as authorized)
  const threw = fakeAdmin({ session: completedSession, answers: ANSWERS });
  assert.equal((await verifyCompletedSession(threw.client, "S1", { authorize: () => { throw new Error("profile load failed"); } })).outcome, "unauthorized");
});

test("no answer text / snapshot / secret material appears in the returned outcome", async () => {
  const { client } = fakeAdmin({ session: completedSession, answers: ANSWERS, rpc: () => ({ data: { status: "verified", idempotent: false, verified_scored_answers: 4, eligible_participant_count: 1 }, error: null }) });
  const r = await verifyLoadedSession(client, completedSession, {});
  const s = JSON.stringify(r);
  for (const leak of ["free text", "hubspot", "answer_text", "question_snapshot", "option_idx", "numeric_value"]) {
    assert.ok(!s.includes(leak), `outcome must not leak ${leak}`);
  }
});
