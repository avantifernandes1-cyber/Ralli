// Ralli Live durable scoreboard recovery — ONE canonical, importable, executable decision contract
// shared by host + learner for realtime SCOREBOARD, initial restore, and reconnect/focus/visibility
// recovery (migration 081). Pure functions (no React) so they can be unit-executed, not regex-checked.

// Local phases in which a scoreboard must never be (re)entered (terminal / already-finished).
const TERMINAL_PHASES = new Set(["ended", "canceled", "cancelled", "completed"]);

/**
 * Decide whether a realtime/durable scoreboard payload should be applied, and return its canonical
 * entries + version, or null to ignore. Guards (ALL must hold):
 *  - valid payload shape (object with entries array);
 *  - exact session match;
 *  - not a terminal local phase (ended/canceled/completed) — a late board can't reopen a finished game;
 *  - qIdx agreement: when the client's current question index is known, payload.q_idx must equal it,
 *    so a DELAYED OLD scoreboard for a prior question is rejected after the client advanced;
 *  - monotonic version: older than applied → drop; EQUAL → drop for realtime (harmless duplicate),
 *    permitted only for an intentional idempotent initial-mount reapply (allowEqualVersion).
 * Uses only the passed monotonic `appliedVersion` (a ref value), never a stale render closure.
 */
export function scoreboardApplyDecision(payload, {
  sessionDbId = null,
  currentQIdx = null,
  localPhase = null,
  appliedVersion = -Infinity,
  allowEqualVersion = false,
} = {}) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.entries)) return null;
  if (sessionDbId && payload.session_id != null && String(payload.session_id) !== String(sessionDbId)) return null;
  if (localPhase && TERMINAL_PHASES.has(localPhase)) return null;
  if (currentQIdx != null && payload.q_idx != null && Number(payload.q_idx) !== Number(currentQIdx)) return null;
  const version = Number(payload.version ?? 0);
  if (Number.isFinite(appliedVersion)) {
    if (version < appliedVersion) return null;
    if (version === appliedVersion && !allowEqualVersion) return null;
  }
  return { entries: payload.entries, version, qIdx: payload.q_idx ?? null };
}

/**
 * Durable-restore decision: apply the durable board ONLY when the authorized session object is
 * itself in the scoreboard phase AND its embedded live_scoreboard payload agrees with the durable
 * columns (session id, current_question_index, scoreboard_version). On any disagreement, reject
 * honestly — never repair/guess client-side. Returns { entries, version, qIdx } or null.
 */
export function durableRestoreDecision(session) {
  if (!session || typeof session !== "object" || session.phase !== "scoreboard") return null;
  const sb = session.live_scoreboard;
  if (!sb || typeof sb !== "object" || !Array.isArray(sb.entries)) return null;
  if (session.id != null && sb.session_id != null && String(sb.session_id) !== String(session.id)) return null;
  if (session.current_question_index != null && sb.q_idx != null
      && Number(sb.q_idx) !== Number(session.current_question_index)) return null;
  if (session.scoreboard_version != null && sb.version != null
      && Number(sb.version) !== Number(session.scoreboard_version)) return null;
  return { entries: sb.entries, version: Number(sb.version ?? 0), qIdx: sb.q_idx ?? null };
}

/**
 * Pure shape adapter: canonical server entries → host/learner score rows, PRESERVING the server's
 * order and rank (never re-ranks; never recomputes name/avatar). Null avatar stays null.
 */
export function scoreboardRows(entries) {
  return (Array.isArray(entries) ? entries : []).map(e => ({
    id: e.id,
    name: e.name,
    emoji: e.emoji ?? null,
    score: Number(e.score ?? 0),
    delta: Number(e.delta ?? 0),
    rank: e.rank ?? null,
  }));
}

/** Stable per-episode idempotency key for a (session, question) scoreboard publication. */
export function scoreboardPublishKey(sessionDbId, qIdx) {
  return `${sessionDbId}:q${qIdx}`;
}
