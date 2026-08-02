/**
 * Static guard + unit tests for the canonical player-safe question serializer.
 *
 * Proves the serializer excludes EVERY known solution-bearing field for every
 * question type, and includes a source-level guard that fails if learner-reachable
 * code broadcasts/persists the raw canonical question instead of the safe payload.
 *
 * Run: node --test src/lib/playerSafeQuestion.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  toPlayerSafeQuestion,
  isPlayerSafeQuestion,
  applyRevealToQuestion,
  SOLUTION_QUESTION_KEYS,
} from "./playerSafeQuestion.js";

const __dir = dirname(fileURLToPath(import.meta.url));

// A superset question of each type (editor stores extra keys on every question).
const mc     = { id: "m", type: "mc", q: "?", text: "?", options: ["a","b","c","d"], timeLimit: 20, correct: 2, acceptedAnswers: ["x"], tolerance: 1, pairs: [{left:"L",right:"R"}], explanation: "because b", correctX: 1, correctY: 2, imageUrl: "u" };
const tf     = { id: "t", type: "tf", q: "?", options: ["True","False"], timeLimit: 10, correct: 0 };
const typeQ  = { id: "y", type: "type", q: "?", options: ["","","",""], timeLimit: 30, acceptedAnswers: ["Black"," navy "] };
const slider = { id: "s", type: "slider", q: "?", timeLimit: 20, min: 0, max: 10, step: 1, minLabel: "lo", maxLabel: "hi", correct: 0, tolerance: 0 };
const match  = { id: "p", type: "match", q: "?", timeLimit: 30, pairs: [{left:"A",right:"1"},{left:"B",right:"2"},{left:"C",right:"3"}] };
const open   = { id: "o", type: "open", q: "?", timeLimit: 60, acceptedAnswers: [] };

test("serializer strips ALL solution fields for every type", () => {
  for (const q of [mc, tf, typeQ, slider, match, open]) {
    const safe = toPlayerSafeQuestion(q);
    for (const k of SOLUTION_QUESTION_KEYS) {
      assert.ok(!(k in safe), `type=${q.type}: solution field "${k}" leaked into safe payload`);
    }
    assert.ok(isPlayerSafeQuestion(safe), `type=${q.type}: isPlayerSafeQuestion false`);
    // No matching pair may carry the canonical right mapping.
    if (Array.isArray(safe.pairs)) {
      for (const p of safe.pairs) assert.ok(!("right" in p), "matching pair leaked canonical right");
    }
  }
});

test("serializer preserves what the player needs to render/answer", () => {
  const smc = toPlayerSafeQuestion(mc);
  assert.deepEqual(smc.options, ["a","b","c","d"]);
  assert.equal(smc.q, "?"); assert.equal(smc.timeLimit, 20); assert.equal(smc.id, "m"); assert.equal(smc.type, "mc");
  const ss = toPlayerSafeQuestion(slider);
  assert.equal(ss.min, 0); assert.equal(ss.max, 10); assert.equal(ss.step, 1); assert.equal(ss.minLabel, "lo");
  const sm = toPlayerSafeQuestion(match);
  assert.deepEqual(sm.pairs, [{left:"A"},{left:"B"},{left:"C"}]); // left prompts only
});

test("applyRevealToQuestion restores correct-answer display fields post-reveal", () => {
  assert.equal(applyRevealToQuestion(toPlayerSafeQuestion(mc), { correctIdx: 2 }).correct, 2);
  assert.deepEqual(applyRevealToQuestion(toPlayerSafeQuestion(typeQ), { acceptedAnswers: ["Black"] }).acceptedAnswers, ["Black"]);
  const sr = applyRevealToQuestion(toPlayerSafeQuestion(slider), { sliderTarget: 0, sliderTolerance: 0 });
  assert.equal(sr.correct, 0); assert.equal(sr.tolerance, 0); // zero preserved
  const mr = applyRevealToQuestion(toPlayerSafeQuestion(match), { matchPairsCorrect: [{left:"A",right:"1"}] });
  assert.equal(mr.pairs[0].right, "1");
});

test("DEEP sanitization: nested/object options can never carry solution metadata", () => {
  // A malicious/rich builder shape: option objects carrying correctness + ids.
  const evil = {
    id: "e", type: "mc", q: "?", timeLimit: 20, correct: 1,
    options: [
      { text: "A", correct: false, isCorrect: false, id: "opt-a", explanation: "nope", score: 0 },
      { text: "B", correct: true,  isCorrect: true,  id: "opt-b", explanation: "the answer", score: 100 },
      "C",
      { label: "D", answerId: "x", meta: { winner: true } },
    ],
    // even a nested pairs array on a non-match type must not leak
    pairs: [{ left: { text: "L", correct: true }, right: "R", correct: true }],
  };
  const safe = toPlayerSafeQuestion(evil);
  // options reduced to display text ONLY — no objects, no correctness survive
  assert.deepEqual(safe.options, ["A", "B", "C", "D"]);
  for (const o of safe.options) assert.equal(typeof o, "string");
  assert.ok(isPlayerSafeQuestion(safe));
  // The whole serialized blob must contain none of the solution tokens.
  const blob = JSON.stringify(safe);
  for (const tok of ["correct", "isCorrect", "explanation", "opt-b", "answerId", "winner", "score"]) {
    assert.ok(!blob.includes(tok), `solution token "${tok}" survived serialization: ${blob}`);
  }
});

test("DEEP sanitization: Matching left objects reduced to text; right never sent", () => {
  const evil = { id: "m", type: "match", q: "?", timeLimit: 30,
    pairs: [{ left: { text: "Left1", correct: 2, mapTo: "R2" }, right: "R1" }, { left: "Left2", right: "R2" }] };
  const safe = toPlayerSafeQuestion(evil);
  assert.deepEqual(safe.pairs, [{ left: "Left1" }, { left: "Left2" }]);
  const blob = JSON.stringify(safe);
  for (const tok of ["right", "R1", "R2", "correct", "mapTo"]) {
    assert.ok(!blob.includes(tok), `matching token "${tok}" survived: ${blob}`);
  }
});

test("unknown question type fails safe (never returns the original object)", () => {
  const legacy = { id: "z", type: "mystery", q: "?", correct: 3, acceptedAnswers: ["a"], secretAnswer: "42", options: [{ text: "x", correct: true }] };
  const safe = toPlayerSafeQuestion(legacy);
  assert.notStrictEqual(safe, legacy);          // new object, not the original
  assert.ok(isPlayerSafeQuestion(safe));
  const blob = JSON.stringify(safe);
  for (const tok of ["correct", "acceptedAnswers", "secretAnswer", "42"]) {
    assert.ok(!blob.includes(tok), `unknown-type leak of "${tok}": ${blob}`);
  }
  assert.deepEqual(safe.options, ["x"]);          // normalized, no metadata
});

test("scalar fields arriving as objects are reduced to text, never copied", () => {
  const q = { id: "s", type: "type", q: { text: "prompt", correct: "answer" }, timeLimit: 30, acceptedAnswers: ["answer"] };
  const safe = toPlayerSafeQuestion(q);
  assert.equal(safe.q, "prompt");
  assert.ok(!JSON.stringify(safe).includes("answer"));
});

test("malformed inputs never throw", () => {
  for (const bad of [null, undefined, 1, "x", []]) {
    assert.doesNotThrow(() => toPlayerSafeQuestion(bad));
    assert.doesNotThrow(() => applyRevealToQuestion(bad, {}));
    assert.doesNotThrow(() => isPlayerSafeQuestion(bad));
  }
});

// ── STATIC SOURCE GUARD ──────────────────────────────────────────────────────
// Fails if learner-reachable code persists/broadcasts the RAW canonical question
// object instead of the sanitized payload. We assert that the ONE place building
// the live payload routes the question through toPlayerSafeQuestion, and that no
// SHOW_QUESTION broadcast or live_question persist sends `question: q` raw.
test("STATIC GUARD: live question payload is built via toPlayerSafeQuestion", () => {
  const src = readFileSync(join(__dir, "..", "..", "rankd-app.jsx"), "utf8");
  // The canonical live payload construction must sanitize the question.
  assert.match(src, /question:\s*toPlayerSafeQuestion\(/, "startQuestion must build liveQuestion.question via toPlayerSafeQuestion()");
  // Guard against a raw `question: q` (the pre-fix leak) in a live/broadcast payload.
  assert.doesNotMatch(src, /\bquestion:\s*q\s*,/, "raw `question: q,` must not be broadcast/persisted (use toPlayerSafeQuestion)");
  assert.ok(src.includes('import { toPlayerSafeQuestion'), "rankd-app.jsx must import the serializer");
});
