// Regression guard for cross-account navigation-state leakage on sign-out.
// Run: node src/lib/appSessionRestoration.test.mjs   (no creds, no DB, no browser)
//
// THE BUG THIS CATCHES
// Learn navigation context is persisted per-tab in sessionStorage:
//   ralli_last_screen, ralli_pending_quiz_review, ralli_learn_filter,
//   ralli_learn_user_tab, ralli_learn_admin_tab.
// sessionStorage survives an in-tab sign-out → sign-in. If those keys are not
// wiped on sign-out, the NEXT account signed in on the same tab re-hydrates the
// PRIOR account's screen / Learn subtab / pending quiz review. The most sensitive
// is ralli_pending_quiz_review (a quizId + attemptId): even though get_quiz_review
// is auth-scoped server-side (no data leak), the stale intent must never survive
// an account switch — it would drop the new user onto a review deep-link for an
// attempt that isn't theirs.
//
// This test asserts the structural invariant: a single clearLearnNavSessionState()
// helper enumerates ALL the nav keys (incl. ralli_pending_quiz_review) and is
// invoked in EVERY sign-out path (real SIGNED_OUT handler + both demo paths), and
// that no sign-out path was left clearing only ralli_last_screen by hand.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// 1. The centralized helper exists and enumerates every account-scoped nav key.
const REQUIRED_KEYS = [
  "ralli_last_screen",         // via LAST_SCREEN_KEY constant
  "ralli_pending_quiz_review",
  "ralli_learn_filter",
  "ralli_learn_user_tab",
  "ralli_learn_admin_tab",
];
const helperIdx = src.indexOf("function clearLearnNavSessionState");
ok("clearLearnNavSessionState() helper is defined", helperIdx >= 0);

const keyListIdx = src.indexOf("const LEARN_NAV_SESSION_KEYS");
ok("LEARN_NAV_SESSION_KEYS list is defined", keyListIdx >= 0);
if (keyListIdx >= 0) {
  const listBlock = src.slice(keyListIdx, src.indexOf("]", keyListIdx) + 1);
  // ralli_last_screen is included via the LAST_SCREEN_KEY constant, not a literal.
  ok("nav-key list references LAST_SCREEN_KEY (ralli_last_screen)", /\bLAST_SCREEN_KEY\b/.test(listBlock));
  for (const k of REQUIRED_KEYS.filter(k => k !== "ralli_last_screen")) {
    ok(`nav-key list includes ${k}`, listBlock.includes(`"${k}"`));
  }
}

// 2. The security-relevant key is actually wiped by the helper body (the loop
//    removes every key in the list — assert the pending-review key is in scope).
if (helperIdx >= 0) {
  const helperBody = src.slice(helperIdx, src.indexOf("}", src.indexOf("{", helperIdx)) + 1);
  ok("helper iterates LEARN_NAV_SESSION_KEYS and removeItem()s them",
     /LEARN_NAV_SESSION_KEYS/.test(helperBody) && /removeItem\(/.test(helperBody));
}

// 3. Every sign-out path calls the helper. There are exactly three:
//    (a) real-user SIGNED_OUT auth event, (b) UserSettingsScreen demo onSignOut,
//    (c) sidebar sign-out button demo branch.
const helperCalls = (src.match(/clearLearnNavSessionState\(\)/g) || []).length;
ok("clearLearnNavSessionState() is called in all 3 sign-out paths (>=3 call sites)",
   helperCalls >= 3, `found ${helperCalls} call site(s)`);

// 4. The real SIGNED_OUT handler specifically clears nav state (not just React state)
//    before the hard redirect to /login.
const signedOutIdx = src.indexOf('event === "SIGNED_OUT"');
ok("SIGNED_OUT handler located", signedOutIdx >= 0);
if (signedOutIdx >= 0) {
  const block = src.slice(signedOutIdx, signedOutIdx + 1400);
  ok("SIGNED_OUT clears nav state before redirect",
     block.indexOf("clearLearnNavSessionState()") >= 0 &&
     block.indexOf("clearLearnNavSessionState()") < block.indexOf('window.location.replace("/login")'));
}

// 5. No sign-out path should be left removing ONLY ralli_last_screen by hand
//    (that was the original partial cleanup that leaked the other keys).
const strayLastScreenOnly = /sessionStorage\.removeItem\(LAST_SCREEN_KEY\)/.test(src);
ok("no sign-out path still hand-clears only LAST_SCREEN_KEY (all routed through helper)",
   !strayLastScreenOnly);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
