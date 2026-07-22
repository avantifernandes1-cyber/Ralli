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
export async function startGameSession(pin, tenantId = null) {
  // Scoped by tenant_id whenever the caller has one — see endGameSession's
  // comment above for why pin alone is no longer a safe match (migration
  // 046: pins are only unique within a tenant).
  let query = supabase
    .from("game_sessions")
    .update({
      status:     "started",
      started_at: new Date().toISOString(),
    })
    .eq("pin", pin);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data, error } = await query.select().single();
  return { data, error };
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
export async function endGameSession(pin, { scores = [], tenantId = null } = {}) {
  // 1. Update session status. Scoped by tenant_id whenever the caller has
  // one, not just pin — pins are only unique WITHIN a tenant (migration
  // 046), so a code-only match here could otherwise end a different
  // tenant's session that happens to share the same visible pin.
  let query = supabase
    .from("game_sessions")
    .update({
      status:   "completed",
      ended_at: new Date().toISOString(),
    })
    .eq("pin", pin);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { data: session, error: sessionError } = await query.select().single();

  if (sessionError) {
    console.error("[gameService] endGameSession: failed to update session", sessionError);
    return { data: null, error: sessionError };
  }

  if (!session?.id) return { data: null, error: new Error("session not found") };

  // 2. Mark all active participants as completed (so lobby no longer shows them)
  await supabase
    .from("game_session_participants")
    .update({ status: "completed", last_seen_at: new Date().toISOString() })
    .eq("session_id", session.id)
    .in("status", ["active", "joined"]);

  // 3. Save final player scores (ranked by position in scores array)
  if (scores.length > 0) {
    const playerRows = scores.map((p, idx) => ({
      session_id:  session.id,
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

  return { data: session, error: null };
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
  let query = supabase
    .from("game_sessions")
    .update({ status: "canceled", ended_at: new Date().toISOString() })
    .eq("id", sessionId);
  if (tenantId) query = query.eq("tenant_id", tenantId);
  const { error } = await query;
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
  // The caller's avatar choice is AUTHORITATIVE — including null, which means
  // "no avatar / clear any previously stored one". The previous logic
  // (existing?.emoji ?? emoji) preserved a prior stored avatar over the
  // caller's value, so a player who once had an avatar and later chose "None"
  // had the old avatar silently restored on rejoin. Emoji no longer drifts on
  // reconnect (name-entry passes the actual selection or null, never a
  // recomputed hash), so preservation is obsolete and was the bug.
  const { data: existing } = await supabase
    .from("game_session_participants")
    .select("emoji, color")
    .eq("session_id", sessionId)
    .eq("player_id", playerId)
    .maybeSingle();

  const finalEmoji = emoji;   // caller-authoritative — null clears any prior avatar
  const finalColor = color;

  const { data, error } = await supabase
    .from("game_session_participants")
    .upsert(
      {
        session_id: sessionId,
        player_id:  playerId,
        tenant_id:  tenantId,
        name,
        emoji: finalEmoji,
        color: finalColor,
        joined_at:  new Date().toISOString(),
      },
      { onConflict: "session_id,player_id" }
    )
    .select()
    .single();
  return { data, error };
}

/**
 * Fetch the current lobby roster for a session.
 * Used by the manager lobby on mount and as a polling fallback.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getLobbyParticipants(sessionId) {
  const { data, error } = await supabase
    .from("game_session_participants")
    .select("*")
    .eq("session_id", sessionId)
    .in("status", ["active", "joined"])
    .order("joined_at", { ascending: true });
  return { data, error };
}

/**
 * Subscribe to new participants joining this lobby (postgres_changes INSERT).
 * Returns the Supabase channel so the caller can unsubscribe on cleanup.
 *
 * Usage:
 *   const channel = subscribeToLobbyParticipants(sessionId, (row) => addPlayer(row));
 *   // cleanup:
 *   supabase.removeChannel(channel);
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @param {(row: Object) => void} onInsert - called with the new participant row
 * @returns {RealtimeChannel}
 */
export function subscribeToLobbyParticipants(sessionId, onInsert) {
  const channel = supabase
    .channel(`lobby_participants:${sessionId}`)
    .on(
      "postgres_changes",
      {
        event:  "INSERT",
        schema: "public",
        table:  "game_session_participants",
        filter: `session_id=eq.${sessionId}`,
      },
      (payload) => {
        if (payload.new) onInsert(payload.new);
      }
    )
    .subscribe();
  return channel;
}

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
  const patch = { phase };
  if (currentQuestionIndex !== undefined) patch.current_question_index = currentQuestionIndex;
  if (paused !== undefined) patch.paused = paused;
  // live_question is the durable recovery source (migration 048). Passing an
  // object stores the current SHOW_QUESTION payload; passing null clears it
  // (host moved off the question); passing undefined leaves it untouched.
  if (liveQuestion !== undefined) patch.live_question = liveQuestion;
  const { error } = await supabase
    .from("game_sessions")
    .update(patch)
    .eq("id", sessionId);
  return { error };
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
 * Fetch every per-question, per-player answer row for a completed (or
 * in-progress) session — the canonical data source for post-game analytics
 * drill-down (Player Breakdown / Questions tabs in RankdResultsScreen).
 * Ordered by question_idx so callers can group by question cheaply.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getGameAnswersForSession(sessionId) {
  const { data, error } = await supabase
    .from("game_answers")
    .select("*")
    .eq("session_id", sessionId)
    .order("question_idx", { ascending: true });
  return { data, error };
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
  const { error } = await supabase
    .from("game_session_participants")
    .update({ status: "left", last_seen_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);
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
  const { error } = await supabase
    .from("game_session_participants")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("player_id", playerId);
  return { error };
}

/**
 * Fetch game history for a player from game_players table.
 * Used on the "My Scores" tab to replace the static USER_GAME_HISTORY seed.
 *
 * @param {string} playerId - auth user id
 * @param {number} [limit=20]
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getPlayerGameHistory(playerId, limit = 20) {
  const { data, error } = await supabase
    .from("game_players")
    .select("*, game_sessions(name, question_count, ended_at, pin)")
    .eq("player_id", playerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return { data, error };
}

/**
 * Fetch final results for a completed session from game_players.
 * Used by RankdResultsScreen when gameData is not in memory (after refresh).
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getSessionPlayers(sessionId) {
  const { data, error } = await supabase
    .from("game_players")
    .select("*")
    .eq("session_id", sessionId)
    .order("final_rank", { ascending: true });
  return { data, error };
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
  const { error } = await supabase
    .from("game_sessions")
    .update({ question_snapshot: questions })
    .eq("id", sessionId);
  return { error };
}

/**
 * Fetch the durable question snapshot for a session. Returns null (not an
 * error) for legacy sessions created before the snapshot existed — callers
 * must degrade honestly rather than fall back to the mutable current quiz.
 *
 * @param {string} sessionId - game_sessions.id (UUID)
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getSessionQuestionSnapshot(sessionId) {
  const { data, error } = await supabase
    .from("game_sessions")
    .select("question_snapshot")
    .eq("id", sessionId)
    .single();
  return { data: data?.question_snapshot ?? null, error };
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
  const { data, error } = await supabase
    .from("game_sessions")
    .select("*, game_players(*)")
    .eq("tenant_id", tenantId)
    .eq("status", "completed")
    .order("ended_at", { ascending: false })
    .limit(limit);

  if (error || !data) return { data: null, error };

  // Resolve host display names for real (UUID) host_ids in one batch query.
  // Mock/demo host_ids (seed data, e.g. "demo-host") never match a profiles
  // row and safely fall back to null (rendered as "Unknown host") below —
  // never fabricated.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hostIds = [...new Set(data.map(s => s.host_id).filter(id => id && UUID_RE.test(id)))];
  let hostNames = {};
  if (hostIds.length > 0) {
    const { data: hosts } = await supabase.from("profiles").select("id, name, email").in("id", hostIds);
    hostNames = Object.fromEntries((hosts ?? []).map(h => [h.id, h.name ?? h.email ?? null]));
  }

  const normalised = data.map(s => {
    const players = (s.game_players ?? []).slice().sort((a, b) => (a.final_rank ?? 999) - (b.final_rank ?? 999));
    const top = players[0] ?? null;
    return {
      code:          s.pin,
      name:          s.name,
      quizId:        s.quiz_id,
      questionCount: s.question_count,
      status:        s.status,
      playerCount:   players.length,
      demoMode:      s.demo_mode ?? false,
      players:       [],
      dbId:          s.id,
      endedAt:       s.ended_at,
      createdAt:     s.created_at,
      hostId:        s.host_id ?? null,
      hostName:      hostNames[s.host_id] ?? null,
      topPlayer:     top ? { name: top.name, score: top.final_score ?? 0, emoji: top.emoji ?? null } : null,
    };
  });

  return { data: normalised, error: null };
}

/**
 * Fetch a single session with all player scores.
 * Used by results screens when navigating from game history.
 *
 * @param {string} sessionId
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function getSessionWithResults(sessionId) {
  const { data, error } = await supabase
    .from("game_sessions")
    .select("*, game_players(*), game_answers(*)")
    .eq("id", sessionId)
    .single();
  return { data, error };
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
export async function getActiveSessions(tenantId, limit = 30) {
  const { data, error } = await supabase
    .from("game_sessions")
    .select("*")
    .eq("tenant_id", tenantId)
    .in("status", ["waiting", "started", "live", "active", "paused"])
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error || !data) return { data: null, error };

  const normalised = data.map(s => ({
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
  const [sessionResult, answersResult] = await Promise.all([
    supabase
      .from("game_sessions")
      .select("id, phase, current_question_index, paused, status, pin, name, quiz_id, question_count, player_count, tenant_id, live_question")
      .eq("id", sessionId)
      .single(),
    supabase
      .from("game_answers")
      .select("player_id, player_name, question_idx, points, is_correct, answer_text")
      .eq("session_id", sessionId),
  ]);

  return {
    session: { data: sessionResult.data ?? null, error: sessionResult.error ?? null },
    answers: { data: answersResult.data ?? null, error: answersResult.error ?? null },
  };
}
