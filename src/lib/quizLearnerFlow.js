// ─────────────────────────────────────────────────────────────────────────────
// Learner-safe quiz flow — pure data transforms (Stage 1b UI cutover).
//
// These functions are the client half of the answer-confidentiality contract
// (migration 055). They translate between the learner-facing RPC payloads
// (list_quizzes_for_learner / get_quiz_for_attempt / get_quiz_review /
// submit_quiz_attempt_atomic_v2) and the shapes the React quiz screens render —
// WITHOUT ever inventing, storing, or requiring canonical answer keys on the
// learner's side. Kept as a separate, dependency-free module so the security
// contract can be unit-tested repeatably (see quizLearnerFlow.test.mjs), rather
// than being buried inside the 23k-line component file.
//
// Canonical answer keys (`correct`, `acceptedAnswers`, `tolerance`, `pairs`,
// `explanation`, target values) live ONLY in the immutable per-attempt snapshot
// the server returns AFTER an official pass (get_quiz_review.solutionsByAttempt)
// or that a manager reads directly. They must NEVER be reconstructed here.
// ─────────────────────────────────────────────────────────────────────────────

/** Keys that would leak the answer for a question. Used by guards + tests. */
export const ANSWER_BEARING_KEYS = [
  "correct", "correctX", "correctY", "acceptedAnswers", "tolerance", "pairs", "explanation",
];

/** True if ANY question still carries an answer-bearing key (i.e. NOT sanitized). */
export function hasAnswerKeys(questions) {
  if (!Array.isArray(questions)) return false;
  return questions.some(q =>
    q && typeof q === "object" && ANSWER_BEARING_KEYS.some(k => k in q)
  );
}

/**
 * list_quizzes_for_learner() item → the catalog/card shape the learner
 * QuizzesScreen + HomeScreen render. Metadata only: NO question bodies, so a
 * learner's browser never receives answers just to list what's assigned.
 */
export function metaToCatalogQuiz(meta) {
  if (!meta || typeof meta !== "object") return null;
  return {
    id:               meta.id,
    name:             meta.name,
    title:            meta.name,            // screens read either .title or .name
    status:           meta.status ?? "active",
    tags:             meta.tags ?? [],
    passingScore:     typeof meta.passing_score === "number" ? meta.passing_score : null,
    questionCount:    typeof meta.question_count === "number" ? meta.question_count : 0,
    questionRevision: meta.question_revision ?? null,
    // Deliberately NO `questions` — a learner card is answer-free by construction.
    _learnerMeta:     true,
  };
}

/** Map an array of learner metadata rows to catalog quizzes (drops any nulls). */
export function metaListToCatalog(list) {
  if (!Array.isArray(list)) return [];
  return list.map(metaToCatalogQuiz).filter(Boolean);
}

/**
 * get_quiz_for_attempt() payload → the quiz object QuizTakingView consumes.
 * Questions are already sanitized by the server; we only rename the snake_case
 * revision and expose `passingScore`. We assert (defensively) that nothing
 * answer-bearing slipped through — if it did, that's a server contract breach,
 * not something to silently render.
 */
export function rpcQuizToTakeable(rpc) {
  if (!rpc || typeof rpc !== "object") return null;
  const questions = Array.isArray(rpc.questions) ? rpc.questions : [];
  return {
    id:               rpc.id,
    name:             rpc.name,
    title:            rpc.name,
    passingScore:     typeof rpc.passing_score === "number" ? rpc.passing_score : null,
    questionRevision: rpc.question_revision ?? null,
    questions,
    _sanitized:       true,
  };
}

/**
 * Normalize a Matching question's columns for rendering, from EITHER the
 * sanitized learner shape (leftItems + independently shuffled rightChoices) OR
 * the canonical shape (pairs) used by demo/manager review. Returns plain arrays
 * of strings; the right column is never re-paired to the left here.
 */
export function matchColumns(question) {
  if (!question || typeof question !== "object") return { leftItems: [], rightChoices: [] };
  if (Array.isArray(question.leftItems) || Array.isArray(question.rightChoices)) {
    return {
      leftItems:    Array.isArray(question.leftItems) ? question.leftItems.slice() : [],
      rightChoices: Array.isArray(question.rightChoices) ? question.rightChoices.slice() : [],
    };
  }
  const pairs = Array.isArray(question.pairs) ? question.pairs : [];
  return {
    leftItems:    pairs.map(p => p?.left),
    rightChoices: pairs.map(p => p?.right),
  };
}

/**
 * Build the submission answer list from the taking view's internal state.
 * Output is exactly what submit_quiz_attempt_atomic_v2 expects: one entry per
 * question, in question order, `{questionId, selected, timeSpent}` — and for
 * matching, `selected` is the decoupled `[{leftIdx, rightText}]` contract
 * (never the internal rightIdx bookkeeping). NO canonical `correct` is emitted.
 *
 * `answersById[qId]` holds the raw per-question selection:
 *   mc/tf → option index (0 is valid), type/open → string, slider → number
 *   (0 is valid), match → [{leftIdx, rightIdx, rightText}] (internal shape).
 */
export function buildSubmissionAnswers(questions, answersById = {}, answerTimes = {}) {
  if (!Array.isArray(questions)) return [];
  return questions.map(q => {
    const raw = q.id in answersById ? answersById[q.id] : null;
    let selected;
    if (q.type === "match") {
      selected = Array.isArray(raw)
        ? raw.map(mp => ({ leftIdx: mp.leftIdx, rightText: mp.rightText }))
        : [];
    } else {
      // Preserve 0 / "" exactly; only absent answers become null.
      selected = raw === undefined ? null : raw;
    }
    return {
      questionId: q.id,
      selected,
      timeSpent:  q.id in answerTimes ? answerTimes[q.id] : null,
    };
  });
}

/**
 * Interpret a submit_quiz_attempt_atomic_v2 response into a UI decision.
 * Never optimistic: only an explicit status:'ok' yields a result to show.
 *   { kind: 'error' }        → transport/RPC failure; show Retry, no results.
 *   { kind: 'quiz_changed' } → stale; nothing persisted; reload + retake.
 *   { kind: 'ok', score, passed, points, attempt } → server-authoritative.
 */
export function interpretSubmit(data, error) {
  if (error) return { kind: "error" };
  if (!data || typeof data !== "object") return { kind: "error" };
  if (data.status === "quiz_changed") {
    return { kind: "quiz_changed", currentRevision: data.current_revision ?? null };
  }
  if (data.status === "ok") {
    const attempt = data.attempt ?? null;
    return {
      kind:    "ok",
      score:   typeof data.server_score === "number" ? data.server_score : attempt?.score ?? null,
      passed:  typeof data.server_passed === "boolean" ? data.server_passed : !!attempt?.passed,
      points:  typeof data.pointsAwarded === "number" ? data.pointsAwarded : null,
      alreadyRecorded: !!data.alreadyRecorded,
      attempt,
      answers: Array.isArray(data.answers) ? data.answers : [],
    };
  }
  // Unknown / unexpected shape — treat as a failure, never as success.
  return { kind: "error" };
}

/**
 * Build a per-attempt review model from get_quiz_review() output for ONE
 * attempt (the caller's own). Pass-gated reveal is already decided by the
 * server (`revealAvailable` + presence of a snapshot in solutionsByAttempt):
 *   - failed / no official pass → reveal=false, solution=null (submission +
 *     server isCorrect only, never the answer key).
 *   - official pass → reveal=true, solution=<immutable snapshot> if present.
 *   - reveal expected but snapshot absent (legacy) → unavailable=true, so the
 *     UI shows "Exact historical answer detail unavailable" and NEVER falls
 *     back to current mutable quiz questions.
 */
export function buildAttemptReview(reviewData, attemptId) {
  const attempts = Array.isArray(reviewData?.attempts) ? reviewData.attempts : [];
  const attempt = attemptId != null
    ? attempts.find(a => String(a.attempt_id) === String(attemptId))
    : attempts[0];
  if (!attempt) return null;
  const reveal = !!reviewData?.revealAvailable;
  const solutions = reviewData?.solutionsByAttempt ?? {};
  const solution = reveal ? (solutions[String(attempt.attempt_id)] ?? null) : null;
  return {
    attemptId:   attempt.attempt_id,
    attemptNum:  attempt.attempt_num ?? null,
    score:       attempt.score,
    passed:      attempt.passed,
    provenance:  attempt.provenance ?? null,
    createdAt:   attempt.created_at ?? null,
    answers:     Array.isArray(attempt.answers) ? attempt.answers : [],
    reveal,
    solution,                              // canonical snapshot array | null
    // "reveal is unlocked but we have no immutable record" → honest degrade.
    unavailable: reveal && solution == null,
  };
}

/**
 * Manager/admin drilldown review model for ONE attempt, using the immutable
 * snapshot fetched separately (managers always reveal for trusted attempts).
 * `snapshot` is the solution array for this attempt_id or null/undefined.
 * A trusted attempt is server_v2; anything else (legacy) has no snapshot and
 * degrades honestly rather than borrowing today's mutable questions.
 */
export function buildManagerAttemptReview(attempt, snapshot) {
  const trusted = attempt?.grading_provenance === "server_v2" || attempt?.provenance === "server_v2";
  const solution = Array.isArray(snapshot) ? snapshot : null;
  return {
    attemptId:   attempt?.id ?? attempt?.attempt_id ?? null,
    attemptNum:  attempt?.attempt_num ?? null,
    score:       attempt?.score,
    passed:      attempt?.passed,
    createdAt:   attempt?.created_at ?? null,
    answers:     Array.isArray(attempt?.answers) ? attempt.answers : [],
    reveal:      true,                     // managers may always see the answer key…
    solution,                              // …but only from the immutable snapshot.
    trusted,
    // Reveal wanted, but no snapshot → unavailable (legacy or pre-snapshot).
    unavailable: solution == null,
  };
}

/**
 * Per-question review row for the shared SnapshotQuizReview renderer. Combines:
 *   - the learner-safe submitted answer (with server `isCorrect`),
 *   - optional SANITIZED label questions (question text / option labels / left
 *     prompts — NO answer keys) so a review can name the question even before/
 *     without an official pass, and
 *   - only when `reveal`, the canonical detail from the immutable snapshot
 *     (correct answer, accepted answers, target/tolerance, pairs, explanation).
 * Never computes correctness client-side — `isCorrect` always comes from the
 * server. `labelQuestions` must be sanitized (assert-guarded by the caller).
 */
export function reviewRows({ answers = [], solution = null, labelQuestions = null, reveal = false }) {
  const bySolutionId = new Map();
  if (Array.isArray(solution)) for (const sq of solution) if (sq && sq.id != null) bySolutionId.set(String(sq.id), sq);
  const byLabelId = new Map();
  if (Array.isArray(labelQuestions)) for (const lq of labelQuestions) if (lq && lq.id != null) byLabelId.set(String(lq.id), lq);

  return answers.map(a => {
    const sol = reveal ? bySolutionId.get(String(a.questionId)) ?? null : null;
    const lbl = byLabelId.get(String(a.questionId)) ?? null;
    const type = sol?.type ?? lbl?.type ?? a.type ?? null;
    // Option/prompt LABELS may come from the snapshot or the sanitized label
    // source; the answer KEY (correct/pairs/…) may come ONLY from the snapshot.
    const options   = sol?.options ?? lbl?.options ?? null;
    const leftItems = (sol && Array.isArray(sol.pairs)) ? sol.pairs.map(p => p?.left) : (lbl?.leftItems ?? null);
    return {
      questionId: a.questionId,
      type,
      text:       sol?.text ?? sol?.q ?? lbl?.text ?? lbl?.q ?? null,
      options,                                    // labels only
      leftItems,                                  // labels only
      selected:   a.selected,
      isCorrect:  a.isCorrect,                    // server truth; may be null for open-ended
      timeSpent:  a.timeSpent ?? null,
      solution:   sol,                            // canonical question (answer key) | null
    };
  });
}
