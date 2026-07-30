/**
 * Ralli Live — reveal-publication state machine (pure, testable).
 *
 * The durable reveal transition is intentionally strict so a delayed/duplicate
 * reveal can never overwrite a newer or cleared live_question:
 *
 *   FIRST PUBLICATION — allowed ONLY when the session is on the exact question,
 *   in a pre-reveal phase, and active. Atomically flips phase→reveal + persists
 *   the reveal. (Handled by the conditional UPDATE in gameService.publishRevealDurable
 *   using the constants below; a matched row means "applied".)
 *
 *   0-ROW OUTCOME — classified here from the current row:
 *     - idempotent : phase already 'reveal' for this exact qIdx AND the stored
 *                    payload is byte-equivalent to ours (a lost response after a
 *                    successful persist). The host may broadcast the already-durable
 *                    reveal; nothing is rewritten.
 *     - conflict   : phase 'reveal' for this qIdx but a DIFFERENT payload is stored
 *                    (integrity conflict) — reject.
 *     - stale      : anything else (countdown/scoreboard/ended/unknown phase,
 *                    newer/older qIdx, terminal status) — reject, never overwrite.
 */

// Exact game_sessions.status spellings (audited): active vs terminal.
export const ACTIVE_SESSION_STATUSES = Object.freeze(["waiting", "started", "live", "active", "paused"]);
// Phases a reveal may legitimately transition FROM: a live auto-question, or the
// open-ended grading phase (open-review is the open-ended analog of 'question').
export const REVEAL_PRE_PHASES = Object.freeze(["question", "open-review"]);

/**
 * Order-independent deep equality for JSON values (objects compared by key set,
 * arrays by order). Used to decide whether a stored reveal payload is the exact
 * same frozen payload we are trying to publish.
 */
export function deepEqualJson(a, b) {
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a === b;
  const ta = typeof a, tb = typeof b;
  if (ta !== tb) return false;
  if (ta !== "object") return a === b;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqualJson(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqualJson(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Classify the 0-row outcome of the strict first-publication update.
 * @param {object|null} currentRow - { phase, current_question_index, live_question } or null
 * @param {number} expectedQIdx
 * @param {object} frozenLiveQuestion - the exact payload we tried to persist
 * @returns {'idempotent'|'conflict'|'stale'}
 */
export function classifyRevealPublish(currentRow, expectedQIdx, frozenLiveQuestion) {
  if (!currentRow || typeof currentRow !== "object") return "stale";
  if (currentRow.phase === "reveal" && currentRow.current_question_index === expectedQIdx) {
    return deepEqualJson(currentRow.live_question, frozenLiveQuestion) ? "idempotent" : "conflict";
  }
  return "stale";
}

export default { ACTIVE_SESSION_STATUSES, REVEAL_PRE_PHASES, deepEqualJson, classifyRevealPublish };
