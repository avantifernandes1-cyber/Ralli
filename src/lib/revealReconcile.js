/**
 * Ralli Live — REVEAL RECONCILIATION from the CANONICAL roster + DURABLE submissions (migration 084).
 *
 * Pure, runtime-neutral. The host, at reveal, grades EVERY canonical roster member against that
 * member's durable submission (from rpc_begin_question_reveal) using the ONE shared grader —
 * never chAnswers / ANSWER payloads / presence / names / client player ids. A member with no
 * durable submission is honestly UNANSWERED (0 points, present row). Correctness/points reuse the
 * existing live point economy (100 base + up to 50 speed bonus); the speed component now uses the
 * TRUSTWORTHY server time (submitted_at − server question start), clamped to the question limit.
 *
 * @typedef {{id:string,name:string,emoji?:string|null,status?:string}} RosterMember
 * @typedef {{player_id:string,q_type?:string,option_idx?:number|null,text?:string|null,numeric_value?:number|null,answer_json?:any,submitted_at?:string|null}} Submission
 */

/** Convert a durable submission row into the internal answer shape the grader consumes. */
export function submissionToAns(sub) {
  if (!sub) return null;
  return {
    optionIdx:   sub.option_idx ?? null,
    text:        sub.text ?? null,
    sliderValue: sub.numeric_value == null ? null : Number(sub.numeric_value),
    matchPairs:  Array.isArray(sub.answer_json) ? sub.answer_json : null,   // [{leftIdx,rightIdx}]
    submittedAt: sub.submitted_at ?? null,
  };
}

/** Trustworthy server latency for the speed bonus: submitted_at − question start, clamped [0, limit]. */
export function serverLatencyMs(submittedAt, questionStartedAt, limitMs) {
  if (!submittedAt || !questionStartedAt) return null;
  const t = new Date(submittedAt).getTime() - new Date(questionStartedAt).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.min(limitMs, t));
}

/**
 * Reconcile one question's reveal. Iterates the CANONICAL roster (membership truth), grades each
 * member's durable submission, and returns cumulative scores + one answer row per member.
 *
 * @returns {{newScores:Array, answerRows:Array}}
 */
export function reconcileReveal({ roster, submissions, question, prevScores = [], gradeAnswer,
  shuffledRight = [], questionStartedAt = null, tenantId = null, qIdx }) {
  const members = Array.isArray(roster) ? roster : [];
  const subByPlayer = new Map((submissions || []).map(s => [String(s.player_id), s]));
  const prevById = new Map((prevScores || []).map(p => [String(p.id), p]));
  const type = question?.type;
  const limitMs = (question?.timeLimit ?? 20) * 1000;
  const resolveMatch = (mps) => Array.isArray(mps)
    ? mps.map(mp => ({ leftIdx: mp.leftIdx, rightText: shuffledRight[mp.rightIdx]?.right ?? null })) : [];

  const newScores = [];
  const answerRows = [];
  for (const m of members) {
    const prev = prevById.get(String(m.id));
    const base = prev ? (prev.score ?? 0) : 0;
    const ans = submissionToAns(subByPlayer.get(String(m.id)));
    const stMs = ans ? serverLatencyMs(ans.submittedAt, questionStartedAt, limitMs) : null;

    let correct = false, matchCorrectCount = 0;
    const row = { playerId: m.id, playerName: m.name, questionIdx: qIdx, optionIdx: null, text: null,
      timeMs: stMs, isCorrect: false, points: 0, tenantId, numericValue: null, answerJson: null };

    if (ans) {
      if (type === "type" || type === "open") {
        if (ans.text != null) { correct = type === "open" ? false : gradeAnswer(question, ans.text).correct === true; row.text = ans.text; }
      } else if (type === "slider") {
        if (ans.sliderValue != null) { correct = gradeAnswer(question, ans.sliderValue).correct === true; row.numericValue = ans.sliderValue; }
      } else if (type === "match") {
        if (ans.matchPairs?.length) { const g = gradeAnswer(question, resolveMatch(ans.matchPairs)); correct = g.correct === true; matchCorrectCount = g.detail?.matched ?? 0; row.answerJson = resolveMatch(ans.matchPairs); }
      } else { // mc / tf
        if (ans.optionIdx != null) { correct = gradeAnswer(question, ans.optionIdx).correct === true; row.optionIdx = ans.optionIdx; }
      }
    }
    const speedBonus = correct && stMs != null ? Math.max(0, Math.round((1 - stMs / limitMs) * 50)) : 0;
    const delta = correct ? 100 + speedBonus : 0;
    row.isCorrect = correct; row.points = delta;

    newScores.push({ ...(prev ?? {}), id: m.id, name: m.name, emoji: m.emoji ?? (prev?.emoji ?? null),
      color: prev?.color ?? null, score: base + delta, delta, wasCorrect: correct, matchCorrectCount });
    answerRows.push(row);
  }
  newScores.sort((a, b) => b.score - a.score);
  return { newScores, answerRows };
}

export default { submissionToAns, serverLatencyMs, reconcileReveal };
