// Canonical per-session verification (shared, no Deno/HTTP deps).
//
// THE single internal implementation for verifying one Ralli Live session. Both entrypoints —
// the on-demand `verify-game-session` Edge Function and the durable `verify-queue-worker` — call
// this module, so grading, snapshot handling, answer reconciliation, verification persistence, and
// idempotency-result mapping have ONE source of truth and cannot drift.
//
//   • grading            — the ONE shared grader (./gameGrading.js), never re-implemented.
//   • persistence + the authoritative gate — record_game_verification RPC (migration 072), which
//     remains the server-side backstop: it re-checks demo/completed, binds the frozen snapshot hash,
//     confines verdicts to the session, dedups, and is idempotent (returns idempotent:true).
//
// Authorization is NOT decided here from untrusted request fields. The entrypoint owns the policy:
//   - the Edge Function authenticates the JWT and checks host/manager/admin BEFORE calling in;
//   - the worker is service-role-gated at transport and via the service-role-only claim RPC.
// verifyCompletedSession accepts an OPTIONAL `authorize(session)` policy callback (given the trusted,
// server-loaded session) for callers that want the shared loader to enforce their decision.
//
// Typed result contract (returned, never leaking answers/snapshots/secrets):
//   { outcome: 'verified',    idempotent, result }   — verdicts (re)recorded; idempotent=already verified
//   { outcome: 'ineligible',  reason, idempotent? }  — permanently not verifiable (demo/terminal/not_found/no_snapshot)
//   { outcome: 'not_ready' }                          — session exists but is not yet completed (retryable)
//   { outcome: 'integrity',   code }                  — snapshot-hash mismatch etc. (terminal; retry cannot help)
//   { outcome: 'transient',   code }                  — DB/service load/write failure (retryable)
//   { outcome: 'unauthorized' }                       — the entrypoint-supplied authorize() denied
//   { outcome: 'bad_request' }                        — missing/invalid session id

import { buildSessionVerdicts, GRADER_VERSION } from "./gameGrading.js";

export const VERIFICATION_SOURCE_EDGE = "edge:verify-game-session";
export const VERIFICATION_SOURCE_WORKER = "worker:verify-queue";

// Statuses that can never become 'completed' — verifying them is pointless (terminal ineligible).
const TERMINAL_INELIGIBLE = new Set(["canceled", "cancelled", "ended", "abandoned"]);

// The columns the grader needs — identical for both entrypoints (single select contract).
const SESSION_COLS = "id, tenant_id, host_id, status, demo_mode, question_snapshot";
const ANSWER_COLS = "id, player_id, question_idx, option_idx, answer_text, numeric_value, answer_json, was_skipped, answered_at";

// Canonical grade + record for an ALREADY-LOADED, completed, non-demo session. This is the ONLY place
// snapshot handling, answer loading, grading, and the record RPC live. Callers guarantee the session is
// the one to verify (the RPC re-validates authoritatively regardless).
export async function verifyLoadedSession(admin, session, { source = VERIFICATION_SOURCE_EDGE } = {}) {
  const snapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot : null;

  let verdicts = [];
  if (snapshot) {
    const { data: answers, error: aErr } = await admin
      .from("game_answers").select(ANSWER_COLS).eq("session_id", session.id);
    if (aErr) return { outcome: "transient", code: "answers_load_failed" };
    verdicts = buildSessionVerdicts(snapshot, answers ?? []);
  }

  const { data: result, error: rErr } = await admin.rpc("record_game_verification", {
    p_session_id: session.id, p_grader_version: GRADER_VERSION, p_source: source, p_verdicts: verdicts,
  });
  if (rErr) {
    const msg = typeof rErr.message === "string" ? rErr.message : "";
    // The 072 RPC is immutable and message-only. A snapshot-hash mismatch is a terminal integrity error
    // (retrying can't help — the snapshot is write-once); everything else is treated as transient.
    if (/snapshot hash mismatch/i.test(msg)) return { outcome: "integrity", code: "snapshot_hash_mismatch" };
    return { outcome: "transient", code: "verification_write_failed" };
  }

  const idempotent = !!(result && result.idempotent);
  if (result && result.status === "ineligible") {
    return { outcome: "ineligible", reason: (result && result.reason) || "ineligible", idempotent, result };
  }
  return { outcome: "verified", idempotent, result: result ?? null };
}

// Load a session by id, classify eligibility, and (when verifiable) delegate to verifyLoadedSession.
// Used by the queue worker (which has only an id). `authorize` is optional (worker passes none).
export async function verifyCompletedSession(admin, sessionId, { source = VERIFICATION_SOURCE_WORKER, authorize } = {}) {
  if (!sessionId || typeof sessionId !== "string") return { outcome: "bad_request" };

  const { data: session, error: sErr } = await admin
    .from("game_sessions").select(SESSION_COLS).eq("id", sessionId).maybeSingle();
  if (sErr) return { outcome: "transient", code: "session_load_failed" };
  if (!session) return { outcome: "ineligible", reason: "not_found" };

  if (typeof authorize === "function") {
    let allowed = false;
    try { allowed = await authorize(session); } catch { allowed = false; }
    if (!allowed) return { outcome: "unauthorized" };
  }

  if (session.demo_mode === true) return { outcome: "ineligible", reason: "demo_session" };
  if (TERMINAL_INELIGIBLE.has(session.status)) return { outcome: "ineligible", reason: "terminal_status" };
  if (session.status !== "completed") return { outcome: "not_ready" };

  return verifyLoadedSession(admin, session, { source });
}
