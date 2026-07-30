/**
 * Canonical grader — unit + PARITY tests.
 *
 * Parity target: the EXACT correctness rules that shipped in rankd-app.jsx before
 * this slice — the self-paced `isAnswerCorrect()` and the live `doReveal()`
 * per-type branches. Both are re-implemented verbatim below as reference oracles;
 * every case asserts gradeAnswer() agrees with them. This is what lets the live
 * host path be rewired onto the shared grader with zero behavioral change.
 *
 * Run: node --test src/lib/gameGrading.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  gradeAnswer,
  gradePersistedAnswer,
  reconstructSubmitted,
  normalizeQuestion,
  buildSessionVerdicts,
  GRADER_VERSION,
  ELIGIBILITY,
  AUTO_GRADABLE_TYPES,
} from "./gameGrading.js";

// ── Reference oracle #1: self-paced isAnswerCorrect() (verbatim pre-change) ──────
function refSelfPaced(ques, selected) {
  switch (ques.type) {
    case "slider":
      return selected !== null && selected !== undefined
        && Math.abs(selected - (ques.correct ?? 5)) <= (ques.tolerance ?? 1);
    case "type":
      return typeof selected === "string"
        && (ques.acceptedAnswers ?? []).some(a => a.trim().toLowerCase() === selected.trim().toLowerCase());
    case "match": {
      const pairs = ques.pairs ?? [];
      if (!pairs.length || !Array.isArray(selected) || selected.length !== pairs.length) return false;
      return selected.every(mp => pairs[mp.leftIdx]?.right === mp.rightText);
    }
    case "open":
      return typeof selected === "string" && selected.trim().length > 0;
    case "mc":
    case "tf":
      return selected === ques.correct;
    default:
      return false;
  }
}

// ── Reference oracle #2: live doReveal() correctness (verbatim pre-change) ───────
// One function per type mirroring the exact inline expressions doReveal used,
// operating on the same in-memory `ans` shape (post-resolution for match).
const refLive = {
  mc: (q, ans) => ans ? (ans.optionIdx === q.correct) : false,
  tf: (q, ans) => ans ? (ans.optionIdx === q.correct) : false,
  type: (q, ans) => {
    if (!ans?.text) return false;
    return (q.acceptedAnswers ?? []).some(a => (ans.text ?? "").toLowerCase().trim() === a.toLowerCase().trim());
  },
  slider: (q, ans) => {
    if (ans?.sliderValue == null) return false;
    const tol = q.tolerance ?? 1, target = q.correct ?? 5;
    return Math.abs(ans.sliderValue - target) <= tol;
  },
  match: (q, resolvedPairs) => {
    if (!resolvedPairs?.length) return false;
    const pairs = q.pairs ?? [];
    const correctCount = resolvedPairs.filter(mp => mp.rightText === pairs[mp.leftIdx]?.right).length;
    return pairs.length > 0 && correctCount === pairs.length;
  },
};

// ── Fixtures ────────────────────────────────────────────────────────────────────
const mc = { id: "m1", type: "mc", correct: 2, options: ["a", "b", "c", "d"], acceptedAnswers: ["x"], tolerance: 1, pairs: [] };
const tf = { id: "t1", type: "tf", correct: 0, options: ["True", "False"] };
const typeQ = { id: "y1", type: "type", acceptedAnswers: ["Black", " navy "], options: ["", "", "", ""] };
const slider = { id: "s1", type: "slider", correct: 50, tolerance: 5 };
const sliderZero = { id: "s0", type: "slider", correct: 0, tolerance: 0 };
const match = { id: "p1", type: "match", pairs: [{ left: "A", right: "1" }, { left: "B", right: "2" }, { left: "C", right: "3" }] };
const open = { id: "o1", type: "open", acceptedAnswers: [] };
const legacy = { id: "z1", type: "pin", correct: 1 };

test("GRADER_VERSION + surface", () => {
  assert.equal(GRADER_VERSION, "ralli-game-grader@1");
  assert.deepEqual(AUTO_GRADABLE_TYPES, ["mc", "tf", "type", "slider", "match"]);
});

test("MC/TF parity + eligibility", () => {
  for (const idx of [0, 1, 2, 3, null, undefined]) {
    const ans = idx === undefined ? null : { optionIdx: idx };
    const g = gradeAnswer(mc, idx);
    assert.equal(g.correct, refLive.mc(mc, ans), `mc idx=${idx}`);
    assert.equal(g.correct, refSelfPaced(mc, idx));
  }
  assert.equal(gradeAnswer(mc, 2).eligibility, ELIGIBILITY.SCORED);
  assert.equal(gradeAnswer(mc, null).eligibility, ELIGIBILITY.UNANSWERED);
  // TF
  assert.equal(gradeAnswer(tf, 0).correct, true);
  assert.equal(gradeAnswer(tf, 1).correct, false);
  assert.equal(gradeAnswer(tf, 0).correct, refSelfPaced(tf, 0));
});

test("Type normalization parity (trim + case-insensitive)", () => {
  for (const s of ["black", "BLACK", " Black ", "navy", "NAVY", "  navy  ", "green", "", "  ", "x"]) {
    const g = gradeAnswer(typeQ, s);
    assert.equal(g.correct, refSelfPaced(typeQ, s), `type "${s}"`);
    assert.equal(g.correct, refLive.type(typeQ, { text: s }), `live type "${s}"`);
  }
  assert.equal(gradeAnswer(typeQ, null).eligibility, ELIGIBILITY.UNANSWERED);
  // Empty acceptedAnswers can never be correct
  assert.equal(gradeAnswer({ type: "type", acceptedAnswers: [] }, "anything").correct, false);
});

test("Slider tolerance parity incl. ZERO target & tolerance", () => {
  for (const q of [slider, sliderZero]) {
    for (const v of [q.correct, q.correct + q.tolerance, q.correct - q.tolerance, q.correct + q.tolerance + 0.001, q.correct - q.tolerance - 0.001, 0, 50, -3, null]) {
      const g = gradeAnswer(q, v);
      assert.equal(g.correct, refSelfPaced(q, v), `slider target=${q.correct} tol=${q.tolerance} v=${v}`);
      assert.equal(g.correct, refLive.slider(q, { sliderValue: v }), `live slider v=${v}`);
    }
  }
  // Exact-zero target, exact-zero value → correct (the ?? vs || trap)
  assert.equal(gradeAnswer(sliderZero, 0).correct, true);
  assert.equal(gradeAnswer(sliderZero, 1).correct, false);
});

test("Matching ordering/normalization parity", () => {
  const allRight = [{ leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "2" }, { leftIdx: 2, rightText: "3" }];
  const shuffledOrder = [{ leftIdx: 2, rightText: "3" }, { leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "2" }];
  const oneWrong = [{ leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "3" }, { leftIdx: 2, rightText: "2" }];
  const incomplete = [{ leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "2" }];
  for (const sub of [allRight, shuffledOrder, oneWrong, incomplete, [], null]) {
    const g = gradeAnswer(match, sub);
    assert.equal(g.correct, refSelfPaced(match, sub), `match ${JSON.stringify(sub)}`);
    if (Array.isArray(sub) && sub.length) assert.equal(g.correct, refLive.match(match, sub));
  }
  assert.equal(gradeAnswer(match, allRight).correct, true);
  assert.equal(gradeAnswer(match, shuffledOrder).correct, true, "order-independent");
  assert.equal(gradeAnswer(match, oneWrong).correct, false);
  assert.equal(gradeAnswer(match, allRight).detail.matched, 3);
  assert.equal(gradeAnswer(match, oneWrong).detail.matched, 1);
});

test("Open ended is never auto-verifiable (correct=null, manual)", () => {
  const g = gradeAnswer(open, "a thoughtful answer");
  assert.equal(g.correct, null);
  assert.equal(g.eligibility, ELIGIBILITY.OPEN_MANUAL);
});

test("Unknown/legacy type never guessed correct", () => {
  const g = gradeAnswer(legacy, 1);
  assert.equal(g.correct, null);
  assert.equal(g.eligibility, ELIGIBILITY.UNSUPPORTED);
  // Both rulesets agree it is NOT correct; the grader is stricter (null "unknown"
  // vs the self-paced false), never guessing an unsupported type as correct.
  assert.notEqual(g.correct, true);
  assert.notEqual(refSelfPaced(legacy, 1), true);
});

test("Malformed inputs never throw", () => {
  const bad = [undefined, null, {}, { type: "mc" }, { type: "slider", correct: "x", tolerance: "y" }, { type: "match", pairs: "nope" }];
  for (const q of bad) {
    for (const s of [undefined, null, 1, "s", [], {}, NaN]) {
      assert.doesNotThrow(() => gradeAnswer(q, s), `q=${JSON.stringify(q)} s=${JSON.stringify(s)}`);
      const g = gradeAnswer(q, s);
      assert.ok(g && "correct" in g && "eligibility" in g);
      assert.notEqual(g.correct, true, "malformed never accidentally correct"); // false or null only
    }
  }
});

test("reconstructSubmitted from persisted rows", () => {
  assert.equal(reconstructSubmitted(mc, { option_idx: 2 }), 2);
  assert.equal(reconstructSubmitted(mc, { option_idx: null }), undefined);
  assert.equal(reconstructSubmitted(typeQ, { answer_text: "Black" }), "Black");
  assert.equal(reconstructSubmitted(slider, { numeric_value: 0 }), 0);
  assert.equal(reconstructSubmitted(slider, { numeric_value: null }), undefined);
  assert.deepEqual(reconstructSubmitted(match, { answer_json: [{ leftIdx: 0, rightText: "1" }] }), [{ leftIdx: 0, rightText: "1" }]);
  assert.equal(reconstructSubmitted(match, { answer_json: null }), undefined);
});

test("gradePersistedAnswer: skipped vs unanswered vs scored", () => {
  assert.equal(gradePersistedAnswer(mc, { was_skipped: true, option_idx: 2 }).eligibility, ELIGIBILITY.SKIPPED);
  assert.equal(gradePersistedAnswer(mc, { was_skipped: true }).correct, null);
  assert.equal(gradePersistedAnswer(mc, { option_idx: null }).eligibility, ELIGIBILITY.UNANSWERED);
  const scored = gradePersistedAnswer(mc, { option_idx: 2 });
  assert.equal(scored.eligibility, ELIGIBILITY.SCORED);
  assert.equal(scored.correct, true);
  // slider zero persisted
  assert.equal(gradePersistedAnswer(sliderZero, { numeric_value: 0 }).correct, true);
  // match persisted
  assert.equal(gradePersistedAnswer(match, { answer_json: [{ leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "2" }, { leftIdx: 2, rightText: "3" }] }).correct, true);
  // open persisted → manual
  assert.equal(gradePersistedAnswer(open, { answer_text: "hi" }).eligibility, ELIGIBILITY.OPEN_MANUAL);
  // missing question
  assert.equal(gradePersistedAnswer(undefined, { option_idx: 1 }).eligibility, ELIGIBILITY.MALFORMED);
});

test("buildSessionVerdicts: edge grading core over a full session", () => {
  const snapshot = [mc, typeQ, slider, match, open, sliderZero];
  const rows = [
    { id: "a0", player_id: "u1", question_idx: 0, option_idx: 2 },                                   // mc correct
    { id: "a1", player_id: "u1", question_idx: 1, answer_text: "BLACK" },                             // type correct (case-insens)
    { id: "a2", player_id: "u1", question_idx: 2, numeric_value: 53 },                                // slider within tol(50±5)
    { id: "a3", player_id: "u1", question_idx: 3, answer_json: [{ leftIdx: 0, rightText: "1" }, { leftIdx: 1, rightText: "2" }, { leftIdx: 2, rightText: "3" }] }, // match correct
    { id: "a4", player_id: "u1", question_idx: 4, answer_text: "prose" },                             // open → manual (not scored)
    { id: "a5", player_id: "u2", question_idx: 0, option_idx: 0 },                                    // mc wrong
    { id: "a6", player_id: "u2", question_idx: 5, numeric_value: 0 },                                 // slider zero correct
    { id: "a7", player_id: "u2", question_idx: 2, was_skipped: true },                                // skipped
    { id: "a8", player_id: "u2", question_idx: 1, answer_text: null },                                // unanswered
    { id: "a9", player_id: "u2", question_idx: 99 },                                                  // out-of-range → malformed
  ];
  const v = buildSessionVerdicts(snapshot, rows);
  assert.equal(v.length, rows.length);
  // Every verdict carries provenance for the RPC.
  for (const item of v) {
    assert.ok("answer_id" in item && "player_id" in item && "question_idx" in item);
    assert.equal(item.verification_method, "auto");
    assert.notEqual(item.verified_correct, undefined);
  }
  const byId = Object.fromEntries(v.map((x, i) => [rows[i].id, x]));
  assert.equal(byId.a0.verified_correct, true);
  assert.equal(byId.a0.eligibility, ELIGIBILITY.SCORED);
  assert.equal(byId.a0.question_stable_id, "m1");
  assert.equal(byId.a1.verified_correct, true);
  assert.equal(byId.a2.verified_correct, true);
  assert.equal(byId.a3.verified_correct, true);
  assert.equal(byId.a4.verified_correct, null);
  assert.equal(byId.a4.eligibility, ELIGIBILITY.OPEN_MANUAL);
  assert.equal(byId.a5.verified_correct, false);
  assert.equal(byId.a5.eligibility, ELIGIBILITY.SCORED);
  assert.equal(byId.a6.verified_correct, true);        // slider zero
  assert.equal(byId.a7.eligibility, ELIGIBILITY.SKIPPED);
  assert.equal(byId.a7.verified_correct, null);
  assert.equal(byId.a8.eligibility, ELIGIBILITY.UNANSWERED);
  assert.equal(byId.a9.eligibility, ELIGIBILITY.MALFORMED);
  assert.equal(byId.a9.verified_correct, null);
  // Client is_correct/points/time_ms are never read: a row lying "is_correct:true"
  // on a wrong option must still verify false.
  const lying = buildSessionVerdicts([mc], [{ id: "x", player_id: "u", question_idx: 0, option_idx: 0, is_correct: true, points: 999, time_ms: 1 }]);
  assert.equal(lying[0].verified_correct, false);
});

test("buildSessionVerdicts: defensive on malformed inputs", () => {
  assert.deepEqual(buildSessionVerdicts(null, null), []);
  assert.deepEqual(buildSessionVerdicts(undefined, undefined), []);
  assert.doesNotThrow(() => buildSessionVerdicts([mc], [{}]));
  const v = buildSessionVerdicts([mc], [{}]);
  assert.equal(v[0].eligibility, ELIGIBILITY.MALFORMED); // question_idx missing → -1 → no question
});

test("normalizeQuestion selects by type only, ignores superset keys", () => {
  // mc question carrying pairs/acceptedAnswers/tolerance (real editor superset) —
  // must grade purely as mc.
  const superset = { id: "sup", type: "mc", correct: 1, options: ["a", "b"], pairs: [{ left: "x", right: "y" }], acceptedAnswers: ["b"], tolerance: 3 };
  assert.equal(gradeAnswer(superset, 1).correct, true);
  assert.equal(gradeAnswer(superset, 0).correct, false);
  const n = normalizeQuestion(superset);
  assert.equal(n.type, "mc");
  assert.equal(n.stableId, "sup");
});
