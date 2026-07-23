// Repeatable tests for the learner-safe quiz flow transforms (Stage 1b).
// Run: node src/lib/quizLearnerFlow.test.mjs   (no creds, no DB)
//
// Covers the client half of the answer-confidentiality contract: no
// answer-bearing data ever reaches a learner render, every sanitized question
// type round-trips, the matching drag/drop contract, Slider 0, server-only
// result gating, failed/passed review rules, immutable manager/history review,
// stale-revision recovery, and that correctness is NEVER computed client-side.
import {
  ANSWER_BEARING_KEYS,
  hasAnswerKeys,
  metaToCatalogQuiz,
  metaListToCatalog,
  rpcQuizToTakeable,
  matchColumns,
  buildSubmissionAnswers,
  interpretSubmit,
  buildAttemptReview,
  buildManagerAttemptReview,
  reviewRows,
} from "./quizLearnerFlow.js";

let pass = 0, fail = 0;
const ok  = (n, cond) => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n); } };
const eq  = (n, got, want) => ok(n + `  (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));

// A sanitized quiz exactly as get_quiz_for_attempt returns it (no answer keys).
const sanitizedRpc = {
  id: "q1", name: "Onboarding", passing_score: 100, question_revision: "rev-abc",
  questions: [
    { id: "m1", type: "mc", text: "Pick", options: ["A", "B", "C"] },
    { id: "t1", type: "tf", text: "T/F", options: ["True", "False"] },
    { id: "y1", type: "type", text: "Capital?" },
    { id: "s1", type: "slider", text: "Rate", min: 0, max: 10, step: 1 },
    { id: "x1", type: "match", text: "Match", leftItems: ["L1", "L2"], rightChoices: ["R2", "R1"] },
    { id: "o1", type: "open", text: "Explain" },
  ],
};
// The canonical answer key (immutable snapshot) for the SAME questions.
const canonicalSolution = [
  { id: "m1", type: "mc", text: "Pick", options: ["A", "B", "C"], correct: 1, explanation: "B is right" },
  { id: "t1", type: "tf", text: "T/F", options: ["True", "False"], correct: 0 },
  { id: "y1", type: "type", text: "Capital?", acceptedAnswers: ["Paris"] },
  { id: "s1", type: "slider", text: "Rate", min: 0, max: 10, step: 1, correct: 5, tolerance: 1 },
  { id: "x1", type: "match", text: "Match", pairs: [{ left: "L1", right: "R1" }, { left: "L2", right: "R2" }] },
  { id: "o1", type: "open", text: "Explain" },
];

// ── 1. No learner answer-bearing data ────────────────────────────────────────
{
  const meta = metaToCatalogQuiz({ id: "q1", name: "Onboarding", status: "active", tags: ["x"], passing_score: 80, question_count: 6, question_revision: "rev-abc" });
  ok("1a catalog has NO questions body", !("questions" in meta));
  eq("1b catalog exposes question_count only", meta.questionCount, 6);
  ok("1c catalog carries no answer key", !ANSWER_BEARING_KEYS.some(k => k in meta));
  ok("1d hasAnswerKeys(false) on sanitized", hasAnswerKeys(sanitizedRpc.questions) === false);
  ok("1e hasAnswerKeys(true) on canonical", hasAnswerKeys(canonicalSolution) === true);
  eq("1f metaListToCatalog maps + drops nulls", metaListToCatalog([{ id: "a", name: "A", question_count: 1 }, null]).length, 1);
}

// ── 2. Sanitized quiz round-trips; every type preserved, no keys ─────────────
{
  const q = rpcQuizToTakeable(sanitizedRpc);
  eq("2a revision surfaced", q.questionRevision, "rev-abc");
  eq("2b passingScore surfaced", q.passingScore, 100);
  ok("2c still no answer keys after mapping", hasAnswerKeys(q.questions) === false);
  // MC/TF options preserved
  eq("2d mc options", q.questions[0].options, ["A", "B", "C"]);
  // Slider min/max/step preserved (incl. min 0)
  const s = q.questions[3];
  eq("2e slider min/max/step", [s.min, s.max, s.step], [0, 10, 1]);
  // Matching columns decoupled: leftItems in order, rightChoices independent
  const mc = matchColumns(q.questions[4]);
  eq("2f match leftItems order", mc.leftItems, ["L1", "L2"]);
  eq("2g match rightChoices decoupled (server-shuffled)", mc.rightChoices, ["R2", "R1"]);
  // Canonical pairs also normalize via matchColumns (demo/manager path)
  const mcCanon = matchColumns(canonicalSolution[4]);
  eq("2h canonical → leftItems", mcCanon.leftItems, ["L1", "L2"]);
  eq("2i canonical → rightChoices", mcCanon.rightChoices, ["R1", "R2"]);
}

// ── 3. Submission contract: matching decoupled, Slider 0, no `correct` ────────
{
  const answersById = {
    m1: 0,                                   // mc index 0 (falsy but valid)
    t1: 1,
    y1: "Paris",
    s1: 0,                                   // Slider 0 must be preserved
    x1: [{ leftIdx: 0, rightIdx: 1, rightText: "R1" }, { leftIdx: 1, rightIdx: 0, rightText: "R2" }],
    // o1 intentionally unanswered
  };
  const times = { s1: 4 };
  const out = buildSubmissionAnswers(sanitizedRpc.questions, answersById, times);
  eq("3a one entry per question in order", out.map(a => a.questionId), ["m1", "t1", "y1", "s1", "x1", "o1"]);
  eq("3b mc index 0 preserved (not null)", out[0].selected, 0);
  eq("3c slider 0 preserved (not null)", out[3].selected, 0);
  eq("3d timeSpent carried", out[3].timeSpent, 4);
  eq("3e matching → {leftIdx,rightText} only (no rightIdx)", out[4].selected, [{ leftIdx: 0, rightText: "R1" }, { leftIdx: 1, rightText: "R2" }]);
  eq("3f unanswered → null", out[5].selected, null);
  ok("3g NO canonical `correct` on any entry", out.every(a => !("correct" in a)));
}

// ── 4. Server-only result gating (never optimistic) ──────────────────────────
{
  eq("4a transport error → error", interpretSubmit(null, new Error("net")).kind, "error");
  eq("4b null data → error", interpretSubmit(null, null).kind, "error");
  eq("4c unknown status → error", interpretSubmit({ status: "weird" }, null).kind, "error");
  const changed = interpretSubmit({ status: "quiz_changed", current_revision: "rev-new" }, null);
  eq("4d quiz_changed detected", changed.kind, "quiz_changed");
  eq("4e quiz_changed carries current revision", changed.currentRevision, "rev-new");
  const okRes = interpretSubmit({ status: "ok", server_score: 80, server_passed: false, pointsAwarded: 25, attempt: { id: "at1", score: 80, passed: false, created_at: "2026-07-23T00:00:00Z" }, answers: [{ questionId: "m1", selected: 0, isCorrect: false }] }, null);
  eq("4f ok → server score", okRes.score, 80);
  eq("4g ok → server passed", okRes.passed, false);
  eq("4h ok → points", okRes.points, 25);
  // Idempotent replay: a lost response + retry (same idempotency key) returns the
  // EXISTING attempt (alreadyRecorded, no pointsAwarded) — still a safe 'ok',
  // same score/pass, so the client shows results without a duplicate attempt/XP.
  const replay = interpretSubmit({ status: "ok", alreadyRecorded: true, server_score: 80, server_passed: false, attempt: { id: "at1", score: 80, passed: false, created_at: "2026-07-23T00:00:00Z" }, answers: [{ questionId: "m1", selected: 0, isCorrect: false }] }, null);
  eq("4i replay → ok", replay.kind, "ok");
  eq("4j replay → alreadyRecorded", replay.alreadyRecorded, true);
  eq("4k replay → same score", replay.score, 80);
  eq("4l replay → no points on replay", replay.points, null);
}

// ── 5. Failed vs passed review rules (pass-gated reveal) ─────────────────────
{
  const attemptsPayload = [{
    attempt_id: "at1", attempt_num: 1, score: 80, passed: false, provenance: "server_v2",
    created_at: "2026-07-23T00:00:00Z",
    answers: [{ questionId: "m1", selected: 0, isCorrect: false }, { questionId: "o1", selected: "essay", isCorrect: null }],
  }];
  // FAILED: server withholds reveal + solutions
  const failReview = buildAttemptReview({ attempts: attemptsPayload, revealAvailable: false, solutionsByAttempt: {} }, "at1");
  eq("5a failed → reveal false", failReview.reveal, false);
  eq("5b failed → solution null", failReview.solution, null);
  eq("5c failed → not unavailable (reveal not expected)", failReview.unavailable, false);
  // PASSED: reveal + immutable snapshot present
  const passReview = buildAttemptReview({ attempts: [{ ...attemptsPayload[0], passed: true, score: 100 }], revealAvailable: true, solutionsByAttempt: { at1: canonicalSolution } }, "at1");
  eq("5d passed → reveal true", passReview.reveal, true);
  ok("5e passed → solution is the snapshot", Array.isArray(passReview.solution) && passReview.solution[0].correct === 1);
  // PASSED but snapshot missing (legacy pass that somehow unlocked) → honest degrade
  const passNoSnap = buildAttemptReview({ attempts: attemptsPayload, revealAvailable: true, solutionsByAttempt: {} }, "at1");
  eq("5f reveal + no snapshot → unavailable", passNoSnap.unavailable, true);
}

// ── 6. reviewRows: server correctness only, labels safe, key only on reveal ──
{
  const answers = [
    { questionId: "m1", selected: 0, isCorrect: false },
    { questionId: "o1", selected: "essay", isCorrect: null },
  ];
  // No reveal, sanitized labels only (question text/options, NO answer key)
  const rowsNoReveal = reviewRows({ answers, solution: canonicalSolution, labelQuestions: sanitizedRpc.questions, reveal: false });
  eq("6a isCorrect passthrough (server truth)", rowsNoReveal[0].isCorrect, false);
  eq("6b open isCorrect null → shown as submitted upstream", rowsNoReveal[1].isCorrect, null);
  ok("6c NO solution when reveal=false", rowsNoReveal.every(r => r.solution === null));
  ok("6d label text present from sanitized source", rowsNoReveal[0].text === "Pick");
  ok("6e option labels present (not answer key)", JSON.stringify(rowsNoReveal[0].options) === JSON.stringify(["A", "B", "C"]));
  // Reveal → answer key from snapshot appears
  const rowsReveal = reviewRows({ answers, solution: canonicalSolution, reveal: true });
  ok("6f solution present when reveal=true", rowsReveal[0].solution && rowsReveal[0].solution.correct === 1);
}

// ── 7. Immutable manager/history review (snapshot, not current quiz) ─────────
{
  const trusted = { id: "at1", attempt_num: 2, score: 100, passed: true, grading_provenance: "server_v2", created_at: "2026-07-23T00:00:00Z", answers: [{ questionId: "m1", selected: 1, isCorrect: true }] };
  const mrTrusted = buildManagerAttemptReview(trusted, canonicalSolution);
  ok("7a manager always reveals", mrTrusted.reveal === true);
  eq("7b trusted attempt flagged", mrTrusted.trusted, true);
  ok("7c trusted uses snapshot solution", Array.isArray(mrTrusted.solution));
  eq("7d trusted not unavailable", mrTrusted.unavailable, false);
  // Legacy attempt: no snapshot → honest degrade, never current-quiz substitution
  const legacy = { id: "at0", attempt_num: 1, score: 100, passed: true, grading_provenance: null, created_at: "2026-01-01T00:00:00Z", answers: [] };
  const mrLegacy = buildManagerAttemptReview(legacy, undefined);
  eq("7e legacy untrusted", mrLegacy.trusted, false);
  eq("7f legacy → no solution", mrLegacy.solution, null);
  eq("7g legacy → unavailable", mrLegacy.unavailable, true);
}

// ── 8. Matching review row uses left labels; correctness only on reveal ──────
{
  const answers = [{ questionId: "x1", selected: [{ leftIdx: 0, rightText: "R1" }, { leftIdx: 1, rightText: "R2" }], isCorrect: true }];
  const rows = reviewRows({ answers, labelQuestions: sanitizedRpc.questions, reveal: false });
  eq("8a match left labels from sanitized leftItems", rows[0].leftItems, ["L1", "L2"]);
  eq("8b match no answer key without reveal", rows[0].solution, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
