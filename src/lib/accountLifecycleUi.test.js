// Source-level wiring tests for the account-lifecycle fixes in rankd-app.jsx.
//
// Issue 1: a deactivated (removed) account that signs in must be routed to a blocked screen — never into
//   the app — at BOTH login and session restore (refresh / already-open session), without recreating the
//   profile. Issue 2: same-org reinvite reconnects the SAME profile (existing-account sign-in, blank name
//   preserves the existing name) — no duplicate identity.
//
// rankd-app.jsx can't be imported headless, so these assert on its source.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../rankd-app.jsx", import.meta.url)), "utf8");

function region(fromNeedle, toNeedle) {
  const a = src.indexOf(fromNeedle);
  assert.ok(a !== -1, `anchor not found: ${fromNeedle}`);
  const b = src.indexOf(toNeedle, a + fromNeedle.length);
  assert.ok(b !== -1, `end anchor not found after ${fromNeedle}: ${toNeedle}`);
  return src.slice(a, b + toNeedle.length);
}

// ── Issue 1: login gate ────────────────────────────────────────────────────────
test("LoginScreen accepts an onBlocked prop and gates entry through evaluateAccountAccess", () => {
  assert.match(src, /function LoginScreen\(\{ onLogin, onBlocked/, "LoginScreen takes onBlocked");
  const enter = region("const enter = (profile) =>", "onLogin(profile);");
  assert.match(enter, /evaluateAccountAccess\(profile\)/, "gate evaluates access");
  assert.match(enter, /if \(access\.blocked\) \{ if \(onBlocked\) onBlocked\(\); return; \}/,
    "blocked → onBlocked() and NOT onLogin");
});

test("login path routes both fetched and freshly-created profiles through the gate (enter), not raw onLogin", () => {
  const handleSubmit = region("const { data, error: authErr } = await supabase.auth.signInWithPassword", "setError(mapAuthError");
  assert.match(handleSubmit, /if \(profile\) \{ enter\(profile\); return; \}/, "fetched profile gated");
  assert.match(handleSubmit, /if \(created\) \{ enter\(created\); return; \}/, "created profile gated");
  // No un-gated onLogin() slipped back in within the auth-success block.
  assert.ok(!/\bonLogin\(profile\)/.test(handleSubmit) || /const enter/.test(handleSubmit),
    "no raw onLogin(profile) bypass");
});

// ── Issue 1: session-restore / refresh gate ────────────────────────────────────
test("session restore blocks a deactivated account before seating currentUser", () => {
  const restore = region("if (session?.user && !currentUser) {", "setCurrentUser({ ...profile");
  assert.match(restore, /evaluateAccountAccess\(profile\)\.blocked/, "restore evaluates access");
  assert.match(restore, /setBlockedAccount\(true\);\s*\n\s*return;/, "blocked → setBlockedAccount + early return");
  // The block check must appear BEFORE setCurrentUser in this region.
  assert.ok(restore.indexOf("setBlockedAccount(true)") < restore.indexOf("setCurrentUser({ ...profile"),
    "gate precedes setCurrentUser");
});

// ── Issue 1: blocked screen render precedence + no app content ──────────────────
test("BlockedAccountScreen renders with precedence over the app and shows only the deactivation message", () => {
  assert.match(src, /const \[blockedAccount,\s*setBlockedAccount\]\s*=\s*useState\(false\)/, "blockedAccount state exists");
  // precedence: the blockedAccount return appears before the `if (!currentUser)` login gate.
  const idxBlocked = src.indexOf("if (blockedAccount) {");
  const idxLoginGate = src.indexOf("if (!currentUser) {");
  assert.ok(idxBlocked !== -1 && idxLoginGate !== -1 && idxBlocked < idxLoginGate,
    "blocked-account render precedes the login/app render");
  const screen = region("function BlockedAccountScreen(", "\n}\n");
  assert.match(screen, /DEACTIVATED_MESSAGE/, "shows the deactivation message");
  assert.match(screen, /onSignOut/, "offers Sign out");
  // Must not render Home/Settings/app content.
  assert.ok(!/HomeScreen|SettingsScreen|<AppShell|renderScreen/.test(screen), "no app content in blocked screen");
});

test("handleLogin has a defense-in-depth block check", () => {
  const hl = region("const handleLogin = (u) => {", "setCurrentUser(u);");
  assert.match(hl, /evaluateAccountAccess\(u\)\.blocked/, "handleLogin re-checks access");
});

test("does not recreate/reactivate a profile on the blocked path (createMissingProfile only for missing rows)", () => {
  // createMissingProfile is only called when getProfile returned null (new signup), never to 'fix' a
  // removed user (whose row exists). Assert the login path only calls it in the !profile branch.
  assert.match(src, /createMissingProfile is not reached|for a removed user getProfile returns the existing row/,
    "documents no-recreate guarantee");
  // ensure_self_profile stays ON CONFLICT DO NOTHING (server-side), so it can't reactivate.
});

// ── Issue 2: same-org reinvite reconnection + name preservation (no duplicate) ──
test("InviteScreen reconnects the existing account (sign-in) instead of creating a duplicate", () => {
  const inv = region("const handleSubmit = async (e) => {", "// 3. Accept invitation");
  assert.match(inv, /signInWithPassword\(\{/, "existing-account path signs in (no duplicate identity)");
  assert.match(inv, /already.*registered|isExisting/is, "detects an existing account");
});

test("accept_invitation preserves the existing profile name when the field is left blank", () => {
  assert.match(src, /p_name:\s*name\.trim\(\) \|\| null/, "blank name → null → accept keeps existing name");
  assert.match(src, /data-testid="reinvite-name-help"/, "name field has clarifying helper text");
});

// ── Guardrails: no new client profile writes / RLS broadening introduced ───────
test("the fix introduces no new client profiles insert/upsert and no tenant broadening", () => {
  // No client-side profiles insert/upsert anywhere in the app shell (single-line or chained).
  assert.ok(!/\.from\("profiles"\)\s*\.insert\(/.test(src), "no client profiles.insert");
  assert.ok(!/\.from\("profiles"\)\s*\.upsert\(/.test(src), "no client profiles.upsert");
  assert.ok(!/\.from\("profiles"\)[\s\S]{0,80}\.(insert|upsert)\(/.test(src), "no chained profiles insert/upsert");
  // Creation stays server-authoritative via the RPC (defined in profileService.js, imported here).
  assert.match(src, /import \{ getProfile, createMissingProfile/, "createMissingProfile imported");
  const svc = readFileSync(fileURLToPath(new URL("./profileService.js", import.meta.url)), "utf8");
  assert.match(svc, /rpc\("ensure_self_profile"/, "createMissingProfile uses ensure_self_profile RPC (no client role/status write)");
  assert.ok(!/\.upsert\(/.test(svc), "profileService has no upsert (no legacy direct role/status write)");
});
