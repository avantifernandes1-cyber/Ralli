/**
 * Ralli Game Service
 *
 * All database operations for game sessions, players, and answers.
 * Returns { data, error } for every function — callers decide how to handle errors.
 *
 * All writes are non-blocking from the UI perspective:
 * - createGameSession is awaited (UI needs the session id)
 * - endGameSession is fire-and-forget (UI navigates immediately)
 *
 * Production upgrade checklist:
 *   - Scope all queries to tenantId once RLS + JWT claims are wired
 *   - Replace player_id 'anonymous' with auth user.id
 *   - game_answers: extend to pass full per-question payloads from KahootHostView
 *
 * @module gameService
 */

import { supabase } from "./supabase.js";
import { REVEAL_ALLOWED_STATUSES, REVEAL_PRE_PHASES, classifyRevealPublish } from "./revealPublish.js";

// ── SESSION ────────────────────────────────────────────────────────────────────

/**
 * Create a new game session in the database.
 * Called in handleCreateSession immediately after the host clicks "Create Session".
 *
 * Routes through the create_game_session_atomic RPC (migration 046) instead
 * of a raw insert: the RPC generates the 6-digit code server-side and
 * retries on a same-tenant collision, so code allocation is atomic and never
 * races on the client. It also re-derives the caller's real tenant_id from
 * their Supabase session when authenticated — the `tenantId` passed here is
 * only actually used as a fallback for the anon/demo-mode path, where there
 * is no stronger signal available. The `pin` param is intentionally no
 * longer accepted — the caller doesn't get to choose the code.
 *
 * @param {{ name: string, quizId: string, questionCount: number, demoMode: boolean, tenantId?: string|null, hostId?: string }} params
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function createGameSession({
  name,
  quizId,
  questionCount,
  demoMode = false,
  tenantId = null,
  hostId = "anonymous",
}) {
  const { data, error } = await supabase.rpc("create_game_session_atomic", {
    p_tenant_id:      tenantId,
    p_host_id:        hostId,
    p_quiz_id:        quizId,
    p_name:           name,
    p_question_count: questionCount,
    p_demo_mode:      demoMode,
  });
  return { data, error };
}

/**
 * Find a game session to join, scoped to the caller's tenant + the entered
 * code (migration 046's find_joinable_session RPC) — never a code-only
 * lookup. A pin that belongs to a different tenant returns exactly the same
 * "not found" shape as a pin that doesn't exist at all, so callers can never
 * distinguish "wrong organization" from "doesn't exist" (no existence leak).
 * `tenantId` is only actually used for the anon/demo-mode path — an
 * authenticated caller's real tenant (from their Supabase session) always
 * wins server-side.
 *
 * @param {string|null} tenantId - the current user's tenant/org id, or null for anon/demo
 * @param {string} pin
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function findJoinableSession(tenantId, pin) {
  const { data, error } = await supabase.rpc("find_joinable_session", {
    p_tenant_id: tenantId,
    p_pin:       pin,
  });
  // A no-match call returns a null composite, not an error — normalize to
  // `data: null` either way so callers have one shape to check.
  return { data: data?.id ? data : null, error };
}

/**
 * Mark a session as started and record start time.
 * Called in handleGameStart before navigating to rankd-game.
 *
 * @param {string} pin
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function startGameSession(sessionId) {
  // Server-authorized write (migration 080): rpc_start_session takes the EXACT game_sessions.id
  // the caller already holds (activeGameSessionDbId) — never a PIN lookup that could target a
  // reused/stale session. It authorizes host/manager server-side and requires a real (non-demo),
  // 'waiting' session that already has its immutable question snapshot. Moving the filtered
  // UPDATE behind a SECURITY DEFINER RPC is what lets a later REVOKE SELECT (081) not break start.
  const { error } = await supabase.rpc("rpc_start_session", { p_session_id: sessionId });
  return { data: null, error };
}

/**
 * Mark a session as completed, record end time, and save final player scores.
 * Called in handleGameEnd (fire-and-forget — UI navigates immediately).
 *
 * @param {string} pin
 * @param {{ scores: Array, tenantId?: string|null }} params
 *   scores: [{ id?, name, score, emoji?, color? }]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function endGameSession(pin, { scores = [], tenantId = null, sessionId = null } = {}) {
  // 1+2. Server-authorized ATOMIC end (migration 080): rpc_end_session authorizes host/
  // manager and marks the session 'completed' AND completes its active participants in one
  // transaction — keyed on the EXACT session id (no PIN fallback), so a demo game (null id)
  // or a mismatched id can never complete another session. A null id returns matched:false
  // and is a no-op. This replaces the two direct filtered UPDATEs so a later REVOKE SELECT
  // (081) won't break end. `pin` is retained only for the caller's own award/history path.
  const { data: endData, error: sessionError } = await supabase.rpc("rpc_end_session", {
    p_session_id: sessionId,
  });
  if (sessionError) {
    console.error("[gameService] endGameSession: failed to end session", sessionError);
    return { data: null, error: sessionError };
  }

  const sid = sessionId ?? endData?.session_id ?? null;
  if (!sid) return { data: null, error: null };

  // 3. Save final player scores (ranked by position in scores array)
  if (scores.length > 0) {
    const playerRows = scores.map((p, idx) => ({
      session_id:  sid,
      tenant_id:   tenantId,
      player_id:   p.id ?? p.playerId ?? p.name ?? `player-${idx}`,
      name:        p.name,
      emoji:       p.emoji ?? null,
      color:       p.color ?? null,
      final_score: p.score ?? 0,
      final_rank:  idx + 1,
    }));

    const { error: playersError } = await supabase
      .from("game_players")
      .insert(playerRows);

    if (playersError) {
      console.error("[gameService] endGameSession: failed to save player scores", playersError);
      // Non-fatal — session is already marked completed
    }
  }

  return { data: { id: sid }, error: null };
}

/**
 * Request server-authoritative verification of a durably-completed session
 * (migration 072 + the verify-game-session Edge Function). The function
 * re-grades the session against its frozen snapshot with the shared canonical
 * grader and writes immutable verification records; the underlying RPC is
 * idempotent, so retries / reconnect / repeated completion never duplicate them.
 *
 * SAFE-BY-DEFAULT: the Edge Function is not deployed in every environment yet.
 * When it is absent/unreachable, this resolves as `{ unavailable: true }`
 * WITHOUT throwing — the caller treats the session as simply "unverified" (never
 * leaderboard-eligible) and MUST NOT let this affect gameplay results or the end
 * screen. Service errors are never surfaced to the player.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Object|null, error: Object|null, unavailable: boolean }>}
 */
export async function requestSessionVerification(sessionId) {
  if (!sessionId) return { data: null, error: null, unavailable: true };
  try {
    const { data, error } = await supabase.functions.invoke("verify-game-session", {
      body: { session_id: sessionId },
    });
    // A not-deployed / unreachable function (FunctionsFetchError, 404) is an
    // expected pre-deploy state, not a failure — report it as unavailable so the
    // caller degrades to "unverified" rather than erroring.
    if (error) return { data: null, error, unavailable: true };
    return { data, error: null, unavailable: false };
  } catch (e) {
    return { data: null, error: e, unavailable: true };
  }
}

/**
 * Cancel a session — a terminal status that is NOT joinable (findable joins
 * require status "waiting") and is NOT surfaced in Past Sessions (getGameHistory
 * only queries status "completed"). Used to roll back a session whose question
 * snapshot failed to persist, so it never becomes an orphaned joinable session
 * without a snapshot.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {string|null} tenantId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function cancelGameSession(sessionId, tenantId = null) {
  // Server-authorized write (migration 080): host/manager-authorized cancel by session id.
  // tenantId kept for contract compatibility; authorization is derived server-side.
  const { error } = await supabase.rpc("rpc_cancel_session", { p_session_id: sessionId });
  return { error };
}

// ── LOBBY PARTICIPANTS ────────────────────────────────────────────────────────

/**
 * Persist a player joining the lobby. Upserts so re-joins are safe.
 * Call immediately after the user confirms their name in the name-entry screen.
 *
 * @param {string} sessionId - game_sessions.id (UUID, the DB primary key, not the PIN)
 * @param {{ playerId: string, name: string, emoji?: string|null, color?: string|null, tenantId?: string|null }} params
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function joinGameSession(sessionId, { playerId, name, emoji = null, color = null, tenantId = null }) {
  // Server-authorized SELF-join (migration 080): rpc_participant_join forces
  // player_id = auth.uid() and derives tenant server-side, so a learner can only ever write
  // THEIR OWN participant row into a SAME-TENANT session (no impersonation, no cross-tenant).
  // Idempotent upsert (no duplicate). The caller's avatar choice — including null, which
  // means "no avatar" — is authoritative and passed through unchanged. The playerId/tenantId
  // params are kept for contract compatibility but are NOT trusted for the write.
  const { error } = await supabase.rpc("rpc_participant_join", {
    p_session_id: sessionId, p_name: name, p_emoji: emoji, p_color: color,
  });
  return { data: null, error };
}

/**
 * Fetch the current lobby roster for a session.
 * Used by the manager lobby on mount and as a polling fallback.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getLobbyParticipants(sessionId) {
  // Safe-read cutover (migration 075): presence-only roster via the server-authorized
  // rpc_lobby_participants (host/manager OR a participant of this session). Returns
  // id/name/emoji/color/status/joined_at/last_seen_at — never answers or scores.
  // Preserves the prior "active"/"joined" filtering client-side so the host halt
  // watchdog + lobby roster behave identically.
  const { data, error } = await supabase.rpc("rpc_lobby_participants", { p_session_id: sessionId });
  if (error) return { data: null, error };
  const rows = (Array.isArray(data) ? data : []).filter(p => !p.status || p.status === "active" || p.status === "joined");
  return { data: rows, error: null };
}

// NOTE: subscribeToLobbyParticipants (postgres_changes INSERT on
// game_session_participants) was removed as a prerequisite for revoking direct table
// SELECT. Its only job was to notify the lobby that a new participant row appeared;
// the roster's visibility/count is driven by Realtime Presence (chPlayers), and the
// durable identity/status truth is getLobbyParticipants() → rpc_lobby_participants.
// The lobby now refreshes that durable roster on presence change / focus / poll, so
// no client needs a direct postgres_changes subscription on this table.

// ── LIVE GAME PERSISTENCE ─────────────────────────────────────────────────────

/**
 * Persist host game state (phase + current question index + paused flag).
 * Called on each phase transition in KahootHostView so a host refresh can recover.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {{ phase: string, currentQuestionIndex?: number, paused?: boolean }} params
 * @returns {Promise<{ error: Object|null }>}
 */
export async function updateSessionPhase(sessionId, { phase, currentQuestionIndex, paused, liveQuestion } = {}) {
  // Server-authorized write (migration 080): rpc_set_session_phase authorizes host/manager
  // and persists phase (always) plus the optional fields via tri-state flags — preserving
  // the exact prior semantics: live_question object=store / null=clear / undefined=leave
  // untouched (same for current_question_index and paused). No reveal logic here (reveal is
  // rpc_host_publish_reveal, 079).
  const { error } = await supabase.rpc("rpc_set_session_phase", {
    p_session_id:  sessionId,
    p_phase:       phase,
    p_set_cqi:     currentQuestionIndex !== undefined,
    p_cqi:         currentQuestionIndex ?? null,
    p_set_paused:  paused !== undefined,
    p_paused:      paused ?? null,
    p_set_live:    liveQuestion !== undefined,
    p_live_question: liveQuestion ?? null,
  });
  return { error };
}

/**
 * Durable REVEAL publication — the confirmed, state-guarded write that MUST
 * succeed before the host broadcasts the correct answer.
 *
 * FIRST PUBLICATION (atomic, strict): flips phase→'reveal' + persists the reveal
 * ONLY when the session is on the exact question, in a pre-reveal phase
 * (`question`, or `open-review` for open-ended), the status is exactly a RUNNING
 * game (`started`), AND it is not paused (`paused=false`). Requiring the running
 * status + unpaused — not merely "not terminal" — is what stops a delayed reveal
 * from overwriting a same-index `countdown`/`scoreboard`, a `waiting` lobby, or a
 * paused game.
 *
 * 0-ROW OUTCOME is classified (read-only) from the current row:
 *   - `idempotent`: phase already 'reveal' for this exact qIdx with the SAME
 *     payload (a lost response after a successful persist) → success; the host may
 *     broadcast the already-durable reveal without rewriting it.
 *   - `conflict`: phase 'reveal' for this qIdx but a DIFFERENT payload → reject.
 *   - `stale`: anything else (countdown/scoreboard/ended/unknown phase, newer/older
 *     qIdx, terminal status) → reject, never overwrite.
 *
 * Touches only `phase` + `live_question`; never scoring/answers/timers.
 *
 * @param {string} sessionId
 * @param {number} expectedQIdx
 * @param {Object} liveQuestion - the frozen safe live_question payload incl. its `reveal` block
 * @returns {Promise<{ ok: boolean, outcome: 'applied'|'idempotent'|'conflict'|'stale'|'error', error: Object|null }>}
 */
export async function publishRevealDurable(sessionId, expectedQIdx, liveQuestion) {
  // Safe-read cutover (migration 079): the strict conditional first-publication UPDATE
  // and the 0-row current-row read now run server-side, host/manager-authorized, via
  // rpc_host_publish_reveal — so no direct game_sessions read/write here. The 0-row
  // outcome is still classified with the SAME shared JS (classifyRevealPublish); the
  // reveal state machine's semantics are unchanged.
  const { data, error } = await supabase.rpc("rpc_host_publish_reveal", {
    p_session_id: sessionId, p_expected_qidx: expectedQIdx, p_live_question: liveQuestion,
  });
  if (error) return { ok: false, outcome: "error", error };
  if (data?.outcome === "applied") return { ok: true, outcome: "applied", error: null };
  // 0 rows → classify the returned current row (idempotent lost-response / conflict / stale).
  const cls = classifyRevealPublish(data?.current ?? null, expectedQIdx, liveQuestion);
  if (cls === "idempotent") return { ok: true, outcome: "idempotent", error: null };
  return { ok: false, outcome: cls, error: null }; // 'conflict' | 'stale'
}

/**
 * Batch-insert per-question answers for all players after a reveal.
 * Called by KahootHostView.doReveal() once scores are computed.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {Array<{
 *   playerId: string,
 *   playerName: string,
 *   questionIdx: number,
 *   optionIdx: number|null,
 *   text: string|null,
 *   timeMs: number|null,
 *   isCorrect: boolean,
 *   points: number,
 *   tenantId?: string|null,
 *   answerJson?: Array<{leftIdx:number,rightIdx:number}>|null,  // Matching
 *   numericValue?: number|null,                                 // Slider
 *   wasSkipped?: boolean,                                        // true = host skipped this question, not a real (non-)answer
 * }>} answers
 * @returns {Promise<{ error: Object|null }>}
 */
export async function saveGameAnswers(sessionId, answers = []) {
  if (!answers.length) return { error: null };
  const rows = answers.map(a => ({
    session_id:    sessionId,
    tenant_id:     a.tenantId ?? null,
    player_id:     a.playerId,
    player_name:   a.playerName,
    question_idx:  a.questionIdx,
    option_idx:    a.optionIdx ?? null,
    answer_text:   a.text ?? null,
    time_ms:       a.timeMs ?? null,
    is_correct:    a.isCorrect,
    points:        a.points ?? 0,
    answer_json:   a.answerJson ?? null,
    numeric_value: a.numericValue ?? null,
    was_skipped:   a.wasSkipped ?? false,
  }));
  const { error } = await supabase.from("game_answers").insert(rows);
  return { error };
}

/**
 * Mark a lobby participant as having left the session.
 * Called when a player disconnects (presence untrack) or manually leaves.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {string} playerId - player_id value from game_session_participants
 * @returns {Promise<{ error: Object|null }>}
 */
export async function markParticipantLeft(sessionId, playerId) {
  // Server-authorized SELF write (migration 080): the RPC flips ONLY the caller's own row
  // (player_id = auth.uid()) to 'left'. playerId kept for contract compatibility; the write
  // target is derived server-side so a learner can never mark another player left.
  const { error } = await supabase.rpc("rpc_participant_leave", { p_session_id: sessionId });
  return { error };
}

/**
 * Update a participant's last_seen_at heartbeat timestamp.
 * Called periodically by KahootPlayerView while the player is in-game.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {string} playerId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function updateParticipantHeartbeat(sessionId, playerId) {
  // Server-authorized SELF write (migration 080): refreshes ONLY the caller's own
  // last_seen_at (player_id = auth.uid()). playerId kept for contract compatibility.
  const { error } = await supabase.rpc("rpc_participant_heartbeat", { p_session_id: sessionId });
  return { error };
}

/**
 * Exact participant count for each of the given sessions, as { [sessionId]: n }.
 * Reads only the session_id column of game_players (never scores/answers/names),
 * so the player UI can show "#N of M" without pulling other players' data. RLS
 * confines the read to the caller's tenant.
 *
 * @param {string[]} sessionIds
 * @returns {Promise<{ data: Object<string,number>|null, error: Object|null }>}
 */
export async function getSessionPlayerCounts(sessionIds) {
  const ids = (sessionIds ?? []).filter(Boolean);
  if (ids.length === 0) return { data: {}, error: null };
  // Safe-read cutover (migration 075): server returns counts ONLY for sessions the
  // caller may see (a manager of it, or a participant of it) — count only, never
  // identities. Same { [sessionId]: n } shape as before.
  const { data, error } = await supabase.rpc("rpc_session_player_counts", { p_session_ids: ids });
  if (error) return { data: null, error };
  return { data: data ?? {}, error: null };
}

/**
 * Persist the exact question set + order a session will play, written ONCE at
 * session creation. This is the authoritative source for post-game analytics
 * (migration 049) — game_answers.question_idx indexes INTO this array. Stores
 * question DEFINITIONS only (never scoring state or player answers).
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {Array} questions - the normalized questions array, in play order
 * @returns {Promise<{ error: Object|null }>}
 */
export async function saveSessionQuestionSnapshot(sessionId, questions) {
  if (!sessionId || !Array.isArray(questions) || questions.length === 0) return { error: null };
  // Server-authorized write (migration 080): host/manager-authorized, WRITE-ONCE (the RPC
  // only sets question_snapshot when still null), preserving the immutable historical-
  // question contract. Accepts DEFINITIONS only — never answers or scores.
  const { error } = await supabase.rpc("rpc_save_question_snapshot", {
    p_session_id: sessionId, p_questions: questions,
  });
  return { error };
}

// ── ANALYTICS ─────────────────────────────────────────────────────────────────

/**
 * Fetch completed game session history for a tenant — the durable data
 * source behind Ralli Live's "Past Sessions" tab.
 *
 * Root cause this fixes: the app never called this function at all. Past
 * Sessions was instead derived by filtering the same local `sessions` array
 * that getActiveSessions() populates — but getActiveSessions() only ever
 * queries non-terminal statuses, so a completed session could never appear
 * there in the first place, and the 10s active-sessions poll wiped out any
 * session an in-memory optimistic update had marked "completed" within
 * seconds. game_sessions.status DOES correctly reach "completed" (and
 * game_players DOES get its final_score/final_rank rows) via endGameSession()
 * — verified live against production data — so no backfill was needed here,
 * only wiring up this read path and normalizing it the same way
 * getActiveSessions() does, so downstream consumers (RankdResultsScreen's
 * code-based lookup, session.dbId/quizId usage) work unchanged.
 *
 * @param {string} tenantId
 * @param {number} [limit=20]
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getGameHistory(tenantId, limit = 20) {
  // Safe-read cutover (migration 075): server-authorized manager history. Returns
  // completed sessions + per-session player summary + host display name, WITHOUT
  // any question_snapshot. Tenant scope is derived server-side (orgAdmin → own;
  // ralli_admin → passed tenant; learner → []).
  const { data, error } = await supabase.rpc("rpc_manager_session_history", { p_tenant_id: tenantId ?? null, p_limit: limit });
  if (error) return { data: null, error };
  const rows = Array.isArray(data) ? data : [];
  const normalised = rows.map(s => ({
    code:          s.pin,
    name:          s.name,
    quizId:        s.quiz_id,
    questionCount: s.question_count,
    status:        s.status,
    playerCount:   s.player_count ?? 0,
    demoMode:      s.demo_mode ?? false,
    players:       [],
    dbId:          s.id,
    endedAt:       s.ended_at,
    createdAt:     s.created_at,
    hostId:        s.host_id ?? null,
    hostName:      s.host_name ?? null,
    topPlayer:     s.top_player
      ? { name: s.top_player.name, score: s.top_player.score ?? 0, emoji: s.top_player.emoji ?? null }
      : null,
  }));
  return { data: normalised, error: null };
}

/**
 * Manager exact-session analytics (migration 075) — the single server-authorized
 * source for the RankdResultsScreen Overview / Player Breakdown / Questions tabs.
 * Returns { session, players, answers, snapshot } for a session the caller HOSTS
 * or is a same-tenant orgAdmin / ralli_admin for; raises server-side otherwise.
 * Replaces the three direct reads (getSessionPlayers + getGameAnswersForSession +
 * getSessionQuestionSnapshot). Ordinary learners can never call it successfully.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: { session: Object, players: Object[], answers: Object[], snapshot: Array|null }|null, error: Object|null }>}
 */
export async function getManagerSessionAnalytics(sessionId) {
  const { data, error } = await supabase.rpc("rpc_manager_session_analytics", { p_session_id: sessionId });
  if (error) return { data: null, error };
  return {
    data: {
      session:  data?.session ?? null,
      players:  data?.players ?? [],
      answers:  data?.answers ?? [],
      snapshot: data?.snapshot ?? null,
    },
    error: null,
  };
}

/**
 * Fetch active / recent sessions for a tenant.
 * Used on mount to replace INITIAL_SESSIONS for real users.
 * Returns sessions normalised to the local state shape.
 *
 * @param {string} tenantId
 * @param {number} [limit=30]
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
/**
 * Learner-safe JOINABLE session list (migration 077) — the same-tenant waiting,
 * non-demo sessions any authenticated tenant member may see to find/select a game
 * to join. Server derives the tenant from the caller's profile. Returns ONLY safe
 * display fields (no question_snapshot / live_question / answers / analytics), so
 * ordinary learners (for whom the manager list returns []) get their joinable games
 * back. Normalized to the SAME shape as getActiveSessions so the join panel is
 * unchanged.
 *
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
/**
 * Atomic safe rejoin (migration 078) — a prior same-tenant participant re-entering a
 * STARTED/paused session by PIN. The server verifies eligibility (authenticated,
 * same-tenant real session, status='started', caller already a participant by
 * auth.uid()) and reactivates their existing participant row in one op — never a
 * duplicate, never a resume, never admitting a non-participant. Returns the session
 * (id/pin/name/status/phase/paused/…) + the caller's stored participant identity, or
 * an error the caller maps to a user message.
 *
 * @param {string} pin
 * @returns {Promise<{ data: { session: Object, participant: Object }|null, error: Object|null }>}
 */
export async function rejoinSession(pin) {
  const { data, error } = await supabase.rpc("rpc_rejoin_session", { p_pin: pin });
  if (error) return { data: null, error };
  return { data: { session: data?.session ?? null, participant: data?.participant ?? null }, error: null };
}

export async function getLearnerJoinableSessions() {
  const { data, error } = await supabase.rpc("rpc_learner_joinable_sessions");
  if (error) return { data: null, error };
  const rows = Array.isArray(data) ? data : [];
  const normalised = rows.map(s => ({
    code:          s.pin,
    name:          s.name,
    quizId:        s.quiz_id,
    questionCount: s.question_count,
    status:        s.status,
    playerCount:   s.player_count ?? 0,
    demoMode:      s.demo_mode ?? false,
    players:       [],
    dbId:          s.id,
  }));
  return { data: normalised, error: null };
}

export async function getActiveSessions(tenantId, limit = 30) { // eslint-disable-line no-unused-vars
  // Safe-read cutover (migration 075): server derives the caller's manager scope
  // from auth.uid()+profiles. orgAdmin → own tenant (p_tenant_id ignored server-side);
  // ralli_admin → the passed tenant; ordinary learner → []. No question_snapshot.
  const { data, error } = await supabase.rpc("rpc_manager_active_sessions", { p_tenant_id: tenantId ?? null });
  if (error) return { data: null, error };
  const rows = Array.isArray(data) ? data : [];
  const normalised = rows.map(s => ({
    code:          s.pin,
    name:          s.name,
    quizId:        s.quiz_id,
    questionCount: s.question_count,
    status:        s.status,
    playerCount:   s.player_count ?? 0,
    demoMode:      s.demo_mode ?? false,
    players:       [],
    dbId:          s.id,
  }));
  return { data: normalised, error: null };
}

/**
 * Fetch everything needed to restore a host's in-progress game session.
 * Runs two parallel queries: session metadata and all saved answers.
 *
 * @param {string} sessionId - UUID of the game_session row
 * @returns {Promise<{ session: { data: Object|null, error: Object|null }, answers: { data: Object[]|null, error: Object|null } }>}
 */
export async function getSessionRestoreData(sessionId) {
  // Safe-read cutover (migration 075): host recovery via the server-authorized
  // rpc_host_session_restore (exact host / same-tenant orgAdmin / ralli_admin only).
  // Returns the SAME { session, answers } shape as before, plus `participants`
  // (id/name/emoji/color) so the host restore no longer reads the participants table
  // directly. Errors are surfaced identically on both sub-results (retryable).
  const { data, error } = await supabase.rpc("rpc_host_session_restore", { p_session_id: sessionId });
  if (error) {
    return {
      session:      { data: null, error },
      answers:      { data: null, error },
      participants: { data: null, error },
    };
  }
  return {
    session:      { data: data?.session ?? null, error: null },
    answers:      { data: data?.answers ?? [], error: null },
    participants: { data: data?.participants ?? [], error: null },
  };
}

// ── LEARNER-SAFE READ RPCs (migration 073) ──────────────────────────────────────

/**
 * Active-player reconnect via the learner-safe RPC (073). Returns the SAME shape
 * as getSessionRestoreData ({ session:{data,error}, answers:{data,error} }) so the
 * player reconcile is unchanged — but `answers` contains ONLY the caller's own
 * per-question points/correctness, and the session's live_question is the
 * already-sanitized payload (correct answers only inside its post-reveal block).
 * Never returns question_snapshot or another player's answer. Errors are explicit
 * and retryable (never coerced to empty gameplay state).
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 */
export async function getPlayerSessionRestore(sessionId) {
  const { data, error } = await supabase.rpc("rpc_player_session_restore", { p_session_id: sessionId });
  if (error) return { session: { data: null, error }, answers: { data: null, error } };
  return {
    session: { data: data?.session ?? null, error: null },
    answers: { data: data?.my_answers ?? [], error: null },
  };
}

/**
 * A participant's own review of a durably COMPLETED session via the learner-safe
 * RPC (073). Correct answers (snapshot) are returned only post-completion to a
 * participant; never another player's raw answer.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: { snapshot: Array|null, myAnswers: Array, playerCount: number|null }|null, error: Object|null }>}
 */
export async function getMyCompletedSessionReview(sessionId) {
  const { data, error } = await supabase.rpc("rpc_my_completed_session_review", { p_session_id: sessionId });
  if (error) return { data: null, error };
  return { data: { snapshot: data?.snapshot ?? null, myAnswers: data?.my_answers ?? [], playerCount: data?.player_count ?? null }, error: null };
}

/**
 * The caller's own game history via the learner-safe RPC (073) — same row shape
 * as getPlayerGameHistory (game_players fields + a `game_sessions` metadata
 * object), but server-enforced to the caller's own rows.
 *
 * @param {number} [limit=20]
 */
export async function listMyGameHistory(limit = 20) {
  const { data, error } = await supabase.rpc("rpc_list_my_game_history", { p_limit: limit });
  return { data: error ? null : (data ?? []), error };
}
