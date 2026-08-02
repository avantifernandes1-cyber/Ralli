/**
 * Ralli Live — canonical player-safe question serializer (single source).
 *
 * ONE helper that strips every correct-answer / grading field from a question
 * before it is sent to or restored by a PLAYER. It is used at the single write
 * point (KahootHostView.startQuestion) to build the SHOW_QUESTION broadcast AND
 * the persisted game_sessions.live_question payload — the exact same safe object
 * for both, so there is no separate sanitization logic in the broadcast vs. the
 * database path. The player-restore RPC simply returns the already-sanitized
 * stored payload; it never re-sanitizes.
 *
 * ALLOWLIST design: the safe payload is built by copying only known
 * player-presentational fields. Anything unknown (including any future
 * solution-bearing field) is dropped by construction — safer than a denylist.
 *
 * The HOST always keeps the canonical question (questions[qIdx]) locally for its
 * own reveal display and scoring; only the PLAYER-facing payload is sanitized.
 *
 * Pure and dependency-free (browser + Node testable). No grading/scoring here.
 */

// Fields a player legitimately needs to READ and ANSWER a question (pre-reveal).
// NOTE: `options` are the visible MC/TF/answer choices (safe — the correct one is
// identified by the stripped `correct` index, never by the option text itself).
export const PLAYER_SAFE_QUESTION_KEYS = Object.freeze([
  "id",        // stable question id
  "type",      // mc | tf | type | slider | match | open
  "q",         // prompt text
  "text",      // prompt text (alias some questions carry)
  "options",   // visible choices (MC/TF)
  "timeLimit", // countdown seconds
  "imageUrl",  // presentational
  "min", "max", "step",       // slider scale (NOT the target)
  "minLabel", "maxLabel",     // slider labels
]);

// Solution / grading fields that must NEVER reach a player before reveal. Kept as
// an explicit list so the static test can assert the serializer excludes each.
export const SOLUTION_QUESTION_KEYS = Object.freeze([
  "correct",         // MC/TF correct index OR slider target
  "correctX", "correctY", // legacy coordinate solutions
  "acceptedAnswers", // Type accepted answers
  "tolerance",       // Slider tolerance
  "explanation",     // may reveal/imply the answer
  // `pairs` is handled specially below: left prompts kept, right solution dropped.
]);

// Reduce any option to its player-visible DISPLAY TEXT ONLY. An option is
// normally a plain string; if a builder ever stores an object, we copy NONE of
// its structure (which could carry `correct`/`isCorrect`/answer ids/explanation/
// scoring metadata) — only its visible label. Never returns the original object.
function toDisplayText(v) {
  if (v === null || v === undefined) return "";
  const t = typeof v;
  if (t === "string") return v;
  if (t === "number" || t === "boolean") return String(v);
  if (t === "object") {
    // Object option/prompt: extract a visible label, dropping everything else.
    const cand = v.text ?? v.label ?? v.value ?? v.title ?? v.name;
    return typeof cand === "string" ? cand
         : (typeof cand === "number" || typeof cand === "boolean") ? String(cand)
         : ""; // unknown object shape → empty label, never the object itself
  }
  return "";
}

/**
 * Build the player-safe view of a question. Returns a NEW object containing only
 * allowlisted fields, with `options` and Matching left-prompts NORMALIZED to plain
 * display text so no nested solution-bearing key (correct/isCorrect/answer id/
 * explanation/scoring metadata) can survive through objects, arrays, spreads,
 * Matching pairs, or unknown future shapes. For Matching, the canonical left→right
 * mapping is never sent. Unknown question types fail safe — they get the same
 * normalized allowlist subset, never the original object.
 *
 * @param {object} q - a canonical question object
 * @returns {object} player-safe question
 */
export function toPlayerSafeQuestion(q) {
  if (!q || typeof q !== "object") return {};
  const safe = {};
  for (const k of PLAYER_SAFE_QUESTION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(q, k)) continue;
    if (k === "options") continue;   // normalized below, never copied verbatim
    const v = q[k];
    // Scalar presentational fields only. If a supposedly-scalar field arrives as
    // an object/array (malformed/malicious), reduce it to display text — never
    // copy an object structure into the safe payload.
    if (k === "q" || k === "text" || k === "minLabel" || k === "maxLabel") {
      safe[k] = (v !== null && typeof v === "object") ? toDisplayText(v) : v;
    } else if (v !== null && typeof v === "object") {
      // id/type/timeLimit/min/max/step/imageUrl should be scalars; drop any object.
      continue;
    } else {
      safe[k] = v;
    }
  }
  // Options → array of display-text strings only (strips any nested correctness).
  if (Array.isArray(q.options)) {
    safe.options = q.options.map(toDisplayText);
  }
  // Matching: keep ONLY the left prompt display text; never p.right (the mapping).
  if (q.type === "match" && Array.isArray(q.pairs)) {
    safe.pairs = q.pairs.map(p => ({ left: p && typeof p === "object" ? toDisplayText(p.left) : toDisplayText(p) }));
  }
  return safe;
}

/**
 * True if an object carries NO solution-bearing field — the invariant the safe
 * payload must satisfy. Used by the static guard test and (optionally) as a
 * defensive assertion before broadcast/persist.
 * @param {object} q
 * @returns {boolean}
 */
export function isPlayerSafeQuestion(q) {
  if (!q || typeof q !== "object") return true;
  for (const k of SOLUTION_QUESTION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(q, k)) return false;
  }
  // options must be plain scalars (no nested objects/arrays that could hide
  // correctness metadata).
  if (Array.isArray(q.options) && q.options.some(o => o !== null && typeof o === "object")) return false;
  // Matching pairs must be { left: scalar } only — never `right`, never a nested object.
  if (Array.isArray(q.pairs) && q.pairs.some(p =>
    !p || typeof p !== "object" || "right" in p || (p.left !== null && p.left !== undefined && typeof p.left === "object")
  )) return false;
  return true;
}

/**
 * Merge post-reveal correct-answer info back into a (sanitized) question object
 * so the player's REVEAL render — which reads question.correct / acceptedAnswers /
 * tolerance / pairs — displays the intended answer. Called ONLY at reveal, from
 * the reveal broadcast (live path) or the persisted live_question.reveal field
 * (recovery path). The two callers pass the same `reveal` shape.
 *
 * reveal = { correctIdx?, acceptedAnswers?, sliderTarget?, sliderTolerance?, matchPairsCorrect?, isOpen? }
 *
 * @param {object} q - the sanitized question the player currently holds
 * @param {object} reveal - post-reveal answer info
 * @returns {object} question with correct-answer fields populated for display
 */
export function applyRevealToQuestion(q, reveal) {
  if (!q || typeof q !== "object") return q;
  if (!reveal || typeof reveal !== "object") return q;
  const merged = { ...q };
  if (reveal.correctIdx !== undefined && reveal.correctIdx !== null) merged.correct = reveal.correctIdx;
  if (Array.isArray(reveal.acceptedAnswers)) merged.acceptedAnswers = reveal.acceptedAnswers;
  if (reveal.sliderTarget !== undefined && reveal.sliderTarget !== null) {
    merged.correct = reveal.sliderTarget;                 // slider render reads question.correct as the target
    if (reveal.sliderTolerance !== undefined && reveal.sliderTolerance !== null) merged.tolerance = reveal.sliderTolerance;
  }
  if (Array.isArray(reveal.matchPairsCorrect)) merged.pairs = reveal.matchPairsCorrect;
  return merged;
}

export default { toPlayerSafeQuestion, isPlayerSafeQuestion, applyRevealToQuestion, PLAYER_SAFE_QUESTION_KEYS, SOLUTION_QUESTION_KEYS };
