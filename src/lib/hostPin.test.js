// Regression tests for the host Game PIN visibility fix.
//
// These reproduce the live-QA failure: the host's active-game PIN was invisible
// because the chrome rendered the `pin` prop directly, and on a host refresh/restore
// that prop (lobbyPin) is empty even though the restored session carries the durable
// PIN. The `resolveHostPin` fallback is what keeps the PIN visible in that state.
//
// Layout/responsive behavior (the PIN staying visible and not clipping controls at
// narrow/split-screen widths) is verified separately in a real browser at desktop /
// split-screen / tablet / mobile widths — a layout-less unit runner cannot assert it.
//
// Runs on Node's built-in test runner: `node --test` (no dependencies).

import test from "node:test";
import assert from "node:assert/strict";
import { resolveHostPin, hostPinChipLabel } from "./hostPin.js";

test("uses the live prop PIN when present", () => {
  assert.equal(resolveHostPin("482901", null), "482901");
});

test("REGRESSION: falls back to the restored session PIN when the prop is empty (host refresh)", () => {
  // This is the supplied-screenshot scenario: a restored host whose lobbyPin prop
  // is empty. Before the fix nothing sourced the restored PIN, so it rendered blank.
  assert.equal(resolveHostPin("", "492188"), "492188");
  assert.equal(resolveHostPin(null, "492188"), "492188");
  assert.equal(resolveHostPin(undefined, "492188"), "492188");
});

test("prefers the live prop over the restored PIN when both exist", () => {
  assert.equal(resolveHostPin("111111", "222222"), "111111");
});

test("returns null when there is genuinely no PIN (never an empty label)", () => {
  assert.equal(resolveHostPin(null, null), null);
  assert.equal(resolveHostPin("", ""), null);
  assert.equal(resolveHostPin("   ", null), null);
  assert.equal(resolveHostPin(undefined, undefined), null);
});

test("trims stray whitespace and accepts numeric PINs", () => {
  assert.equal(resolveHostPin("  492188  ", null), "492188");
  assert.equal(resolveHostPin(492188, null), "492188");
  assert.equal(resolveHostPin(null, 492188), "492188");
});

test("never generates or reconstructs a PIN — only echoes an existing one", () => {
  // No input PIN anywhere => no output. The helper cannot invent a value; the
  // only way to get a non-null result is to pass a non-empty PIN in.
  assert.equal(resolveHostPin(null, null), null);
  assert.equal(resolveHostPin("", "   "), null);
});

test("compact chip label formats as 'PIN <pin>' or null", () => {
  assert.equal(hostPinChipLabel("492188"), "PIN 492188");
  assert.equal(hostPinChipLabel(""), null);
  assert.equal(hostPinChipLabel(null), null);
});
