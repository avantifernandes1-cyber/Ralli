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
