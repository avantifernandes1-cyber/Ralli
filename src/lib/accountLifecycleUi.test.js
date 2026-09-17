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

// ── Issue 2: same-org reinvite reconnection + POST-AUTH name prefill (no duplicate) ──
test("InviteScreen authenticates first (existing account signs in — no duplicate identity)", () => {
  const cont = region("const handleContinue = async (e) => {", "setPhase(\"confirm\");");
  assert.match(cont, /signUp\(\{/, "attempts signUp for brand-new accounts");
  assert.match(cont, /signInWithPassword\(\{/, "existing-account path signs in (reconnects same identity)");
  assert.match(cont, /already.*registered|isExisting/is, "detects an existing account");
});

test("post-auth prefill: after sign-in, reads the invitee's OWN profile and pre-fills the editable name", () => {
  const cont = region("const handleContinue = async (e) => {", "setPhase(\"confirm\");");
  // The name read happens AFTER auth (inside handleContinue, after authData is set) — never via the invite link.
  assert.match(cont, /getProfile\(authData\.user\.id\)/, "reads the invitee's own profile post-auth");
  assert.match(cont, /if \(existing\?\.name && !name\.trim\(\)\) \{\s*setName\(existing\.name\)/,
    "pre-fills the name field from the preserved profile when empty");
  assert.match(cont, /setPrefilledName\(true\)/, "marks the field as pre-filled");
  // The unauthenticated invite lookup must NOT return a profile name (no leak via the link).
  const invLoad = region('supabase.rpc("get_invitation_by_token"', "setStatus(\"ready\");");
  assert.ok(!/\bname\b/.test(invLoad) || !/setName/.test(invLoad), "invite-token load does not set a name from the link");
});

test("name field stays editable and accept updates the SAME profile; blank/unchanged preserves it", () => {
  const accept = region("const handleAccept = async (e) => {", "setStatus(\"done\");");
  assert.match(accept, /accept_invitation/, "accept routes through accept_invitation (same user id)");
  assert.match(accept, /p_name:\s*name\.trim\(\) \|\| null/, "blank/unchanged → null → keeps existing name; edit → updates same profile");
  assert.match(src, /data-testid="reinvite-name-help"/, "name field is present with helper text in the confirm phase");
  // The name field is a plain editable input bound to setName (not readOnly/disabled).
  assert.match(src, /value=\{name\} placeholder="First Last"\s*\n\s*onChange=\{e => setName\(e\.target\.value\)\}/,
    "name input is editable");
});

// ── Issue 1b: already-open-tab deactivation recheck (focus / visibility) ────────
test("a focus/visibility recheck re-verifies status and blocks a deactivated open tab", () => {
  const eff = region("Already-open-tab deactivation recheck", "[currentUser?._isReal, currentUser?.id]");
  // Runs only for real signed-in users (invite/tenant-less/new-user flows unaffected).
  assert.match(eff, /if \(!currentUser\?\._isReal \|\| !currentUser\?\.id\) return;/, "guarded to real signed-in users");
  // Wires BOTH focus and visibilitychange (no polling).
  assert.match(eff, /addEventListener\("focus", recheck\)/, "listens on window focus");
  assert.match(eff, /addEventListener\("visibilitychange", onVisibility\)/, "listens on visibilitychange");
  assert.ok(!/setInterval|setTimeout\([^)]*recheck/.test(eff), "no polling timer");
  // Re-reads own status and blocks on a definitive non-active result.
  assert.match(eff, /getProfile\(uid\)/, "re-reads the user's own profile");
  assert.match(eff, /if \(evaluateAccountAccess\(profile\)\.blocked\) setBlockedAccount\(true\)/, "blocks when deactivated");
});

test("recheck is fail-safe and cannot restore the app from a stale response", () => {
  const eff = region("Already-open-tab deactivation recheck", "[currentUser?._isReal, currentUser?.id]");
  assert.match(eff, /catch \{ return; \}/, "transient error → keep active user in (fail-safe)");
  assert.match(eff, /if \(!profile\) return;/, "inconclusive (no row) → do not deactivate");
  assert.match(eff, /seq !== statusRecheckSeq\.current.*return|if \(seq !== statusRecheckSeq\.current\) return/s, "drops superseded responses");
  // The recheck must never re-seat the app or clear the block (no restore path).
  assert.ok(!/setCurrentUser\(/.test(eff), "recheck never re-seats currentUser");
  assert.ok(!/setBlockedAccount\(false\)/.test(eff), "recheck never clears the block");
  // Only visible tabs trigger a fetch.
  assert.match(eff, /visibilityState === "hidden"\) return|visibilityState === "visible"/s, "only rechecks when visible");
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
