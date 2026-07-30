import test from "node:test";
import assert from "node:assert/strict";
import { evaluateConnectivity } from "./zeroPlayerHalt.js";

// The required truth table for the zero-player halt connectivity rule.
// 'connected'/'unknown' both cancel a zero streak (no halt); only 'zero' halts (after grace).

test("presence=1 / durable=1 → connected (continue)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 1, durableKnown: true, durableActiveCount: 1 }), "connected");
});

test("presence=1 / durable=0 → connected (presence fast path)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 1, durableKnown: true, durableActiveCount: 0 }), "connected");
});

test("presence=0 / durable=1 fresh → connected (durable veto)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: true, durableActiveCount: 1 }), "connected");
});

test("presence=0 / durable=0, both known → zero (halt after grace)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: true, durableActiveCount: 0 }), "zero");
});

test("presence unknown (not subscribed), durable=0 → unknown (do NOT halt)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: false, presenceCount: 0, durableKnown: true, durableActiveCount: 0 }), "unknown");
});

test("durable not loaded (unknown), presence empty+subscribed → unknown (do NOT halt at start)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: false, durableActiveCount: 0 }), "unknown");
});

test("both sources unknown → unknown", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: false, presenceCount: 0, durableKnown: false, durableActiveCount: 0 }), "unknown");
});

test("temporary presence drop while durable fresh → connected (no halt during blip)", () => {
  // presence momentarily empty (roster resync) but heartbeat still fresh
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: true, durableActiveCount: 2 }), "connected");
});

test("genuine disconnect: presence gone, heartbeat still within tolerance → connected until stale", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: true, durableActiveCount: 1 }), "connected");
});

test("genuine disconnect: presence gone AND heartbeat now stale (0 fresh) → zero", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: 0, durableKnown: true, durableActiveCount: 0 }), "zero");
});

test("not subscribed but durable proves a fresh player → connected (either source)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: false, presenceCount: 0, durableKnown: true, durableActiveCount: 3 }), "connected");
});

test("string/loose counts are coerced (defensive)", () => {
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: "0", durableKnown: true, durableActiveCount: "1" }), "connected");
  assert.equal(evaluateConnectivity({ presenceKnown: true, presenceCount: "0", durableKnown: true, durableActiveCount: "0" }), "zero");
});
