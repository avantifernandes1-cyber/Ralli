// Canonical per-session verification (shared, no Deno/HTTP deps).
//
// Loads a completed session's FROZEN immutable snapshot + its raw answers, grades with the ONE
// shared grader (../_shared/gameGrading.js — never re-implemented), and writes append-only,
// immutable verdicts via the service-role-only record_game_verification RPC (migration 072).
// Idempotent by design. Client is_correct / points / final_score / time_ms are never trusted.
//
// `admin` is a service-role Supabase client (RLS-independent). This module is used by BOTH the
// on-demand verify-game-session Edge Function's grading path AND the durable verify-queue-worker,
// so the grader and the write path have a single source of truth. It performs NO authorization —
// callers authorize first (the Edge Function via JWT+role; the worker via the service-role gate and
// the service-role-only claim RPC). Transient failures throw a retryable Error; everything else
// returns a small status object carrying NO answer/snapshot/secret material.

import { buildSessionVerdicts, GRADER_VERSION } from "./gameGrading.js";

export const VERIFICATION_SOURCE_EDGE = "edge:verify-game-session";
export const VERIFICATION_SOURCE_WORKER = "worker:verify-queue";

function retryable(code) {
  const e = new Error(code);
  e.retryable = true;
  return e;
}

// Verify one session. Returns { status: 'verified'|'ineligible'|'not_found', ... }.
// Throws a retryable Error on transient load/write failures so the caller can reschedule.
export async function verifyCompletedSession(admin, sessionId, { source = VERIFICATION_SOURCE_EDGE } = {}) {
  if (!sessionId || typeof sessionId !== "string") throw new Error("session_id required");

  const { data: session, error: sErr } = await admin
    .from("game_sessions")
    .select("id, tenant_id, host_id, status, demo_mode, question_snapshot")
    .eq("id", sessionId)
    .maybeSingle();
  if (sErr) throw retryable("session load failed");
  if (!session) return { status: "not_found" };
  if (session.demo_mode === true) return { status: "ineligible", reason: "demo_session" };
  if (session.status !== "completed") throw retryable("session not completed");

  // Missing snapshot → honest ineligible recorded durably (never guessed).
  const snapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot : null;

  let verdicts = [];
  if (snapshot) {
    const { data: answers, error: aErr } = await admin
      .from("game_answers")
      .select("id, player_id, question_idx, option_idx, answer_text, numeric_value, answer_json, was_skipped, answered_at")
      .eq("session_id", sessionId);
    if (aErr) throw retryable("answers load failed");
    verdicts = buildSessionVerdicts(snapshot, answers ?? []);
  }

  const { data: result, error: rErr } = await admin.rpc("record_game_verification", {
    p_session_id: sessionId,
    p_grader_version: GRADER_VERSION,
    p_source: source,
    p_verdicts: verdicts,
  });
  if (rErr) throw retryable("verification write failed");

  return { status: "verified", result: result ?? null };
}
