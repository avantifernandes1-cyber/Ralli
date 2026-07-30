import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deepEqualJson,
  classifyRevealPublish,
  ACTIVE_SESSION_STATUSES,
  REVEAL_PRE_PHASES,
} from "./revealPublish.js";

const payload = { qIdx: 2, question: { id: "q", type: "mc", options: ["a", "b"] }, shuffledRight: [{ right: "x" }], reveal: { correctIdx: 1 } };

test("constants: audited spellings", () => {
  assert.deepEqual(ACTIVE_SESSION_STATUSES, ["waiting", "started", "live", "active", "paused"]);
  assert.deepEqual(REVEAL_PRE_PHASES, ["question", "open-review"]);
});

test("deepEqualJson: order-independent object equality; array order matters", () => {
  assert.ok(deepEqualJson({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
  assert.ok(!deepEqualJson({ a: 1 }, { a: 1, b: 2 }));
  assert.ok(!deepEqualJson([1, 2, 3], [1, 3, 2]));
  assert.ok(deepEqualJson([{ x: 1 }], [{ x: 1 }]));
  assert.ok(!deepEqualJson({ a: 1 }, { a: 2 }));
  assert.ok(deepEqualJson(null, null));
  assert.ok(!deepEqualJson(null, {}));
});

test("classify: idempotent when phase=reveal, same qIdx, identical payload (key order irrelevant)", () => {
  const stored = { phase: "reveal", current_question_index: 2, live_question: { reveal: { correctIdx: 1 }, qIdx: 2, question: { type: "mc", id: "q", options: ["a", "b"] }, shuffledRight: [{ right: "x" }] } };
  assert.equal(classifyRevealPublish(stored, 2, payload), "idempotent");
});

test("classify: conflict when phase=reveal, same qIdx, DIFFERENT payload", () => {
  const stored = { phase: "reveal", current_question_index: 2, live_question: { qIdx: 2, reveal: { correctIdx: 0 } } };
  assert.equal(classifyRevealPublish(stored, 2, payload), "conflict");
});

test("classify: stale for countdown / scoreboard / ended / unknown at same qIdx", () => {
  for (const phase of ["countdown", "scoreboard", "ended", "answered", "waiting", "mystery"]) {
    assert.equal(classifyRevealPublish({ phase, current_question_index: 2, live_question: null }, 2, payload), "stale", phase);
  }
});

test("classify: stale for newer / older qIdx even if phase=reveal", () => {
  assert.equal(classifyRevealPublish({ phase: "reveal", current_question_index: 3, live_question: payload }, 2, payload), "stale");
  assert.equal(classifyRevealPublish({ phase: "reveal", current_question_index: 1, live_question: payload }, 2, payload), "stale");
});

test("classify: stale when row missing", () => {
  assert.equal(classifyRevealPublish(null, 2, payload), "stale");
});
