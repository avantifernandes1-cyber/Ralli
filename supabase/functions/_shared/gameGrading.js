/**
 * Ralli Live — Canonical Game Answer Grader (single source of truth)
 *
 * ONE pure, runtime-neutral correctness module used by:
 *   - the live host reveal path (KahootHostView.doReveal in rankd-app.jsx)
 *   - the server verification path (supabase/functions/verify-game-session)
 *   - unit / parity tests (src/lib/gameGrading.test.mjs)
 *
 * There is intentionally NO second grading implementation (no SQL grader, no
 * copy inside the Edge Function). This file is imported verbatim by the browser
 * bundle (Vite), by Deno/Supabase Edge (relative import), and by Node tests.
 *
 * RUNTIME NEUTRALITY (hard requirement — do not break):
 *   - No imports. No browser (window/DOM), React, Supabase, Node, or Deno APIs.
 *   - No Date/clock, no Math.random, no I/O, no tenant/identity concepts.
 *   - Pure functions of (normalized immutable question, raw submitted answer).
 *   - Deterministic and versioned (see GRADER_VERSION).
 *
 * SCOPE: this module decides CORRECTNESS + ELIGIBILITY only. It never computes
 * points, speed bonuses, ranks, scores, or leaderboard placement — those are
 * gameplay/economy concerns that stay in their existing call sites. Client
 * `is_correct`, `points`, `final_score`, `final_rank`, and `time_ms` are never
 * read here and are never leaderboard truth.
 *
 * Correctness rules are the EXACT rules already shipped in rankd-app.jsx —
 * the self-paced `isAnswerCorrect()` and the live `doReveal()` per-type
 * branches — consolidated here without behavioral change. See gameGrading.test.mjs
 * for the parity assertions that lock this.
 */

// Bump ONLY when the correctness semantics intentionally change. Stored on every
// verification record so historical verifications remain attributable to the
// exact ruleset that produced them.
export const GRADER_VERSION = "ralli-game-grader@1";

// Question types this grader can decide automatically.
export const AUTO_GRADABLE_TYPES = Object.freeze(["mc", "tf", "type", "slider", "match"]);

// Eligibility of a single answer for verified, leaderboard-bearing scoring.
export const ELIGIBILITY = Object.freeze({
  SCORED: "scored",             // supported type, real submission → verified_correct is a real boolean
  UNANSWERED: "unanswered",     // supported type, no submission → not scored (verified_correct = false)
  SKIPPED: "skipped",           // host skipped the question → not scored (verified_correct = null)
  OPEN_MANUAL: "open_manual",   // open-ended → not auto-verifiable; needs a trusted manual record
  UNSUPPORTED: "unsupported",   // unknown/removed type → never scored (never guessed correct)
  MALFORMED: "malformed",       // question or answer shape unusable → not scored
  AMBIGUOUS: "ambiguous_duplicate", // duplicate rows with no trustworthy latest → not scored, never guessed
});

/**
 * Normalize a raw snapshot question into the minimal canonical shape the grader
 * reads. Questions in the snapshot carry a SUPERSET of keys (the shared editor
 * stores pairs/acceptedAnswers/tolerance on every question regardless of type),
 * so we select strictly by `type` and never infer a type from field presence.
 *
 * @param {object} rawQ - a question object from game_sessions.question_snapshot
 * @returns {{type:string, stableId:(string|null), correct:*, tolerance:*, acceptedAnswers:string[], pairs:Array, options:Array}}
 */
export function normalizeQuestion(rawQ) {
  const q = rawQ && typeof rawQ === "object" ? rawQ : {};
  const type = typeof q.type === "string" ? q.type : "";
  return {
    type,
    stableId: typeof q.id === "string" ? q.id : (typeof q.id === "number" ? String(q.id) : null),
    // For mc/tf `correct` is an option index; for slider it is the numeric target.
    correct: q.correct,
    tolerance: q.tolerance,
    acceptedAnswers: Array.isArray(q.acceptedAnswers) ? q.acceptedAnswers : [],
    pairs: Array.isArray(q.pairs) ? q.pairs : [],
    options: Array.isArray(q.options) ? q.options : [],
  };
}

// A single normalized string compare for Type answers — trim then lowercase on
// BOTH sides. Matches isAnswerCorrect() and doReveal()'s type branch exactly.
function normText(s) {
  return typeof s === "string" ? s.trim().toLowerCase() : null;
}

/**
 * THE canonical correctness decision. Pure function of a normalized question and
 * the already-reconstructed submitted value (see reconstructSubmitted for the
 * persisted-row → submitted mapping).
 *
 * Submitted value shape by type:
 *   mc / tf : number  (chosen option index)
 *   type    : string  (typed text)
 *   slider  : number  (chosen numeric value)
 *   match   : Array<{leftIdx:number, rightText:string}>  (resolved pairings)
 *   open    : string  (never auto-graded here)
 *   A submitted value of null/undefined means "no answer".
 *
 * @param {object} question - output of normalizeQuestion (or a raw question)
 * @param {*} submitted
 * @returns {{correct:(boolean|null), eligibility:string, reason:string, detail?:object}}
 */
export function gradeAnswer(question, submitted) {
  const q = question && typeof question === "object" && "acceptedAnswers" in question
    ? question
    : normalizeQuestion(question);

  const noAnswer = submitted === null || submitted === undefined;

  switch (q.type) {
    case "mc":
    case "tf": {
      if (noAnswer) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "no submission" };
      // Strict identity to the correct option index — identical to
      // `selected === ques.correct` / `ans.optionIdx === q.correct`.
      const correct = submitted === q.correct;
      return { correct, eligibility: ELIGIBILITY.SCORED, reason: correct ? "match" : "wrong option" };
    }

    case "type": {
      if (noAnswer) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "no submission" };
      const sel = normText(submitted);
      if (sel === null) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "non-string submission" };
      // Empty accepted-answer set can never mark correct (mirrors current code).
      const correct = q.acceptedAnswers.some(a => normText(a) === sel);
      return { correct, eligibility: ELIGIBILITY.SCORED, reason: correct ? "accepted answer" : "not accepted" };
    }

    case "slider": {
      if (noAnswer) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "no submission" };
      const val = typeof submitted === "number" ? submitted : Number(submitted);
      if (!Number.isFinite(val)) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "non-numeric submission" };
      // `?? ` (NOT ||) so a target/tolerance of 0 is preserved, never coerced to
      // the 5/1 defaults — matches isAnswerCorrect() and doReveal() exactly.
      const target = typeof q.correct === "number" ? q.correct : (q.correct ?? 5);
      const tol = typeof q.tolerance === "number" ? q.tolerance : (q.tolerance ?? 1);
      const t = Number(target);
      const to = Number(tol);
      if (!Number.isFinite(t) || !Number.isFinite(to)) {
        return { correct: false, eligibility: ELIGIBILITY.MALFORMED, reason: "invalid slider target/tolerance" };
      }
      const correct = Math.abs(val - t) <= to;
      return { correct, eligibility: ELIGIBILITY.SCORED, reason: correct ? "within tolerance" : "outside tolerance", detail: { target: t, tolerance: to, diff: Math.abs(val - t) } };
    }

    case "match": {
      const pairs = q.pairs;
      if (noAnswer) return { correct: false, eligibility: ELIGIBILITY.UNANSWERED, reason: "no submission" };
      if (!Array.isArray(pairs) || pairs.length === 0) {
        return { correct: false, eligibility: ELIGIBILITY.MALFORMED, reason: "question has no pairs" };
      }
      if (!Array.isArray(submitted)) {
        return { correct: false, eligibility: ELIGIBILITY.MALFORMED, reason: "submission is not a pairing array" };
      }
      // Canonical Matching rule (identical to isAnswerCorrect): every left slot
      // must be paired with the right TEXT of its own canonical pair, and the
      // pairing count must equal the number of pairs. `detail.matched` exposes
      // the per-pair correct count for callers that display it (e.g. the host
      // reveal's matchCorrectCount) — single-sourced so live + verification agree.
      const matched = submitted.filter(mp => mp && pairs[mp.leftIdx] && pairs[mp.leftIdx].right === mp.rightText).length;
      const correct = submitted.length === pairs.length && matched === pairs.length;
      return { correct, eligibility: ELIGIBILITY.SCORED, reason: correct ? "all pairs correct" : "pairs incorrect/incomplete", detail: { matched, total: pairs.length } };
    }

    case "open": {
      // Open-ended is never machine-verifiable. Correctness is unknown (null),
      // not false — a trusted manual grade must supply it elsewhere.
      return { correct: null, eligibility: ELIGIBILITY.OPEN_MANUAL, reason: "open-ended requires manual verification" };
    }

    default: {
      // Unknown / removed type (e.g. legacy "pin"). NEVER guess correct — do not
      // fall back to comparing raw fields, which can read as accidentally correct.
      return { correct: null, eligibility: ELIGIBILITY.UNSUPPORTED, reason: q.type ? `unsupported type: ${q.type}` : "missing question type" };
    }
  }
}

/**
 * Rebuild the canonical `submitted` value for gradeAnswer() from a persisted
 * game_answers row. The persisted representation is the durable, reconstructable
 * one (Matching stores resolved {leftIdx, rightText}; Slider stores numeric_value;
 * MC/TF store option_idx; Type stores answer_text) — see gameService.saveGameAnswers
 * and doReveal()'s per-type answerRows. Returns undefined for "no submission".
 *
 * @param {object} question - normalized question (or raw) — only its `type` is used
 * @param {object} row - a game_answers row (snake_case columns)
 * @returns {*}
 */
export function reconstructSubmitted(question, row) {
  const type = (question && question.type) || "";
  const r = row || {};
  switch (type) {
    case "mc":
    case "tf":
      return r.option_idx == null ? undefined : r.option_idx;
    case "type":
      return r.answer_text == null ? undefined : r.answer_text;
    case "open":
      return r.answer_text == null ? undefined : r.answer_text;
    case "slider":
      return r.numeric_value == null ? undefined : Number(r.numeric_value);
    case "match": {
      const j = r.answer_json;
      if (!Array.isArray(j)) return undefined;
      // Persisted as [{leftIdx, rightText}] already (doReveal resolves rightText
      // from the ephemeral shuffle at reveal time). Pass through, coercing shape.
      return j.map(p => ({ leftIdx: p && p.leftIdx, rightText: p && p.rightText }));
    }
    default:
      return undefined;
  }
}

/**
 * Grade a persisted game_answers row end-to-end: honor the host `was_skipped`
 * flag first, distinguish skipped vs unanswered, then apply gradeAnswer().
 * This is the exact per-row decision the server verification path records.
 *
 * @param {object} question - a raw snapshot question at the row's question_idx
 * @param {object} row - a game_answers row
 * @returns {{correct:(boolean|null), eligibility:string, reason:string, detail?:object}}
 */
export function gradePersistedAnswer(question, row) {
  const q = normalizeQuestion(question);
  const r = row || {};
  // Host-skipped questions are never a real (non-)answer — they are not scored.
  if (r.was_skipped === true) {
    return { correct: null, eligibility: ELIGIBILITY.SKIPPED, reason: "question skipped by host" };
  }
  if (!q.type) {
    return { correct: null, eligibility: ELIGIBILITY.MALFORMED, reason: "missing/unknown question at index" };
  }
  const submitted = reconstructSubmitted(q, r);
  return gradeAnswer(q, submitted);
}

/**
 * The exact grading core the server verification path runs: independently grade
 * every persisted answer row of ONE session against its frozen immutable
 * snapshot, producing the verdict array consumed by the `record_game_verification`
 * RPC. Pure and runtime-neutral — imported unchanged by the Edge Function AND by
 * Node tests, so what the tests prove is what the server runs.
 *
 * Client `is_correct`, `points`, and `time_ms` on the rows are deliberately
 * IGNORED — correctness comes only from re-grading against the snapshot. No speed
 * is emitted (client time_ms is unverified; see 071 design doc).
 *
 * @param {Array} snapshot - the session's frozen question_snapshot (array of questions)
 * @param {Array} answerRows - game_answers rows for this session (snake_case)
 * @returns {Array<object>} verdicts for record_game_verification's p_verdicts
 */
export function buildSessionVerdicts(snapshot, answerRows) {
  const questions = Array.isArray(snapshot) ? snapshot : [];
  const rows = Array.isArray(answerRows) ? answerRows : [];
  // game_answers has NO unique constraint, so a session may hold duplicate rows
  // for the same (question_idx, player_id) — e.g. a host refresh that re-reveals a
  // question re-inserts a batch. We must resolve those to ONE canonical verdict per
  // (question_idx, player_id) deterministically BEFORE writing (the verification
  // tables enforce UNIQUE(session_id, question_idx, player_id)). Never rely on
  // arbitrary DB row order.
  const groups = new Map();
  for (const row of rows) {
    const idx = Number.isInteger(row && row.question_idx) ? row.question_idx : -1;
    const pid = row && row.player_id != null ? String(row.player_id) : "";
    const key = idx + "|" + pid;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const verdicts = [];
  for (const group of groups.values()) {
    const { canonical, ambiguous } = resolveDuplicateAnswer(group);
    const idx = Number.isInteger(canonical && canonical.question_idx) ? canonical.question_idx : -1;
    const question = idx >= 0 && idx < questions.length ? questions[idx] : null;
    const stableId = question ? normalizeQuestion(question).stableId : null;
    let verdict;
    if (ambiguous) {
      // Duplicate identity with no trustworthy latest → do not guess correctness.
      verdict = { correct: null, eligibility: ELIGIBILITY.AMBIGUOUS, reason: "duplicate answers with no trustworthy latest (missing/tied answered_at)" };
    } else if (!question) {
      verdict = { correct: null, eligibility: ELIGIBILITY.MALFORMED, reason: `no snapshot question at index ${idx}` };
    } else {
      verdict = gradePersistedAnswer(question, canonical);
    }
    verdicts.push({
      answer_id: (canonical && canonical.id) || null,
      player_id: (canonical && canonical.player_id) || null,
      question_idx: idx,
      question_stable_id: stableId,
      verified_correct: verdict.correct, // boolean | null (null = not auto-verifiable)
      eligibility: verdict.eligibility,
      reason: verdict.reason,
      verification_method: "auto",
    });
  }
  return verdicts;
}

/**
 * Deterministic duplicate resolution for one (question_idx, player_id) group.
 * Honest precedence: prefer the LATEST DURABLE answer by the server-set
 * `answered_at` (the only trustworthy ordering field on game_answers; it is set
 * by the DB default at each reveal-batch insert). If `answered_at` is missing on
 * any contested row, or the maximum is not unique (a tie), the identity is
 * AMBIGUOUS — we do not pick arbitrarily. Single-row groups are unambiguous.
 *
 * `answered_at` values come uniformly from PostgREST as ISO-8601 UTC strings with
 * fixed fractional precision, so lexicographic comparison is a correct ordering.
 *
 * @returns {{canonical: object, ambiguous: boolean}}
 */
export function resolveDuplicateAnswer(group) {
  if (!Array.isArray(group) || group.length === 0) return { canonical: null, ambiguous: false };
  if (group.length === 1) return { canonical: group[0], ambiguous: false };
  const timed = group.map(r => ({ r, t: r && r.answered_at != null ? String(r.answered_at) : null }));
  if (timed.some(x => x.t === null)) return { canonical: group[0], ambiguous: true };
  let maxT = null;
  for (const x of timed) if (maxT === null || x.t > maxT) maxT = x.t;
  const top = timed.filter(x => x.t === maxT);
  if (top.length !== 1) return { canonical: group[0], ambiguous: true };
  return { canonical: top[0].r, ambiguous: false };
}

// Grouped export for ergonomic importing in the Edge Function / tests.
export const gameGrading = {
  GRADER_VERSION,
  AUTO_GRADABLE_TYPES,
  ELIGIBILITY,
  normalizeQuestion,
  gradeAnswer,
  reconstructSubmitted,
  gradePersistedAnswer,
  buildSessionVerdicts,
  resolveDuplicateAnswer,
};

export default gameGrading;
