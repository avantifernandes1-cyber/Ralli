// Executable tests for the durable reveal reconciliation (migration 084 host cutover).
// Run: node src/lib/revealReconcile.test.mjs   — uses the REAL shared grader.
import { reconcileReveal, submissionToAns, serverLatencyMs } from "./revealReconcile.js";
import { gradeAnswer } from "../../supabase/functions/_shared/gameGrading.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };

const roster = [{ id: "u1", name: "U1", emoji: null }, { id: "u2", name: "U2", emoji: "X" }];
const start = "2026-08-03T00:00:00.000Z";
const at = (secs) => new Date(Date.parse(start) + secs * 1000).toISOString();

// 1. MC: u1 correct, u2 no submission → both present; unanswered = 0; one row each.
{
  const q = { type: "mc", correct: 1, options: ["a", "b"], timeLimit: 20 };
  const subs = [{ player_id: "u1", q_type: "mc", option_idx: 1, submitted_at: at(2) }];
  const { newScores, answerRows } = reconcileReveal({ roster, submissions: subs, question: q, prevScores: [], gradeAnswer, questionStartedAt: start, qIdx: 0 });
  ok("1 every canonical member gets a score row (2)", newScores.length === 2 && answerRows.length === 2);
  const u1 = newScores.find(p => p.id === "u1"), u2 = newScores.find(p => p.id === "u2");
  ok("1b answerer scored correct (>=100)", u1.wasCorrect === true && u1.score >= 100);
  ok("1c unanswered member PRESENT at zero (not dropped)", u2 && u2.score === 0 && u2.wasCorrect === false);
  ok("1d answer rows include the unanswered member (null answer, 0 pts)",
     answerRows.find(r => r.playerId === "u2").optionIdx === null && answerRows.find(r => r.playerId === "u2").points === 0);
}
// 2. MC wrong → 0.
{
  const q = { type: "mc", correct: 1, options: ["a", "b"], timeLimit: 20 };
  const { newScores } = reconcileReveal({ roster, submissions: [{ player_id: "u1", option_idx: 0, submitted_at: at(1) }], question: q, prevScores: [], gradeAnswer, questionStartedAt: start, qIdx: 0 });
  ok("2 wrong MC scores 0", newScores.find(p => p.id === "u1").score === 0);
}
// 3. Slider 0 preserved + graded.
{
  const q = { type: "slider", correct: 0, tolerance: 1, timeLimit: 20 };
  const subs = [{ player_id: "u1", q_type: "slider", numeric_value: 0, submitted_at: at(1) }];
  const { newScores, answerRows } = reconcileReveal({ roster, submissions: subs, question: q, prevScores: [], gradeAnswer, questionStartedAt: start, qIdx: 1 });
  ok("3 slider value 0 preserved in the answer row", answerRows.find(r => r.playerId === "u1").numericValue === 0);
  ok("3b slider 0 within tolerance graded correct", newScores.find(p => p.id === "u1").wasCorrect === true);
  ok("3c submissionToAns preserves 0 (not null)", submissionToAns({ numeric_value: 0 }).sliderValue === 0);
}
// 4. Matching resolved against shuffledRight + graded all-pairs.
{
  const q = { type: "match", pairs: [{ right: "x" }, { right: "y" }], timeLimit: 20 };
  const shuffledRight = [{ right: "y" }, { right: "x" }]; // shuffled
  // u1 pairs left0→rightIdx1 ("x") and left1→rightIdx0 ("y") = all correct
  const subs = [{ player_id: "u1", q_type: "match", answer_json: [{ leftIdx: 0, rightIdx: 1 }, { leftIdx: 1, rightIdx: 0 }], submitted_at: at(3) }];
  const { newScores, answerRows } = reconcileReveal({ roster, submissions: subs, question: q, prevScores: [], gradeAnswer, shuffledRight, questionStartedAt: start, qIdx: 3 });
  ok("4 matching resolved to rightText + graded all-pairs-correct", newScores.find(p => p.id === "u1").wasCorrect === true);
  ok("4b matching answer row persists resolved [{leftIdx,rightText}]",
     JSON.stringify(answerRows.find(r => r.playerId === "u1").answerJson) === JSON.stringify([{ leftIdx: 0, rightText: "x" }, { leftIdx: 1, rightText: "y" }]));
}
// 5. Type answer graded case-insensitively; cumulative score adds to prev.
{
  const q = { type: "type", acceptedAnswers: ["Paris"], timeLimit: 20 };
  const prev = [{ id: "u1", name: "U1", score: 100 }, { id: "u2", name: "U2", score: 0 }];
  const subs = [{ player_id: "u1", q_type: "type", text: "  paris ", submitted_at: at(2) }];
  const { newScores } = reconcileReveal({ roster, submissions: subs, question: q, prevScores: prev, gradeAnswer, questionStartedAt: start, qIdx: 2 });
  ok("5 type graded correct + cumulative (prev 100 + >=100)", newScores.find(p => p.id === "u1").score >= 200);
}
// 6. A submission from OUTSIDE the roster is never scored (roster is authoritative membership).
{
  const q = { type: "mc", correct: 0, options: ["a", "b"], timeLimit: 20 };
  const subs = [{ player_id: "u1", option_idx: 0, submitted_at: at(1) }, { player_id: "GHOST", option_idx: 0, submitted_at: at(1) }];
  const { newScores, answerRows } = reconcileReveal({ roster, submissions: subs, question: q, prevScores: [], gradeAnswer, questionStartedAt: start, qIdx: 0 });
  ok("6 outside-roster submission never enters scores/rows", newScores.length === 2 && !newScores.some(p => p.id === "GHOST") && !answerRows.some(r => r.playerId === "GHOST"));
}
// 7. Server latency clamp: after-limit answer gets no speed bonus (still correct → base 100).
{
  const q = { type: "mc", correct: 1, options: ["a", "b"], timeLimit: 10 };
  const late = reconcileReveal({ roster, submissions: [{ player_id: "u1", option_idx: 1, submitted_at: at(10) }], question: q, prevScores: [], gradeAnswer, questionStartedAt: start, qIdx: 0 });
  ok("7 at-limit correct answer scores base 100 (no negative bonus)", late.newScores.find(p => p.id === "u1").score === 100);
  ok("7b serverLatencyMs clamps to [0, limit]", serverLatencyMs(at(999), start, 10000) === 10000 && serverLatencyMs(start, at(5), 10000) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
