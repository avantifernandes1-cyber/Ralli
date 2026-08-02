// Regression guard: a HOST who refreshes mid-game (e.g. on the intermediate scoreboard)
// must re-enter the exact active session, not land on the Ralli Live hub / Active Sessions
// list. Run: node src/lib/appHostGameRestore.test.mjs   (no creds, no DB, no browser)
//
// THE BUG THIS CATCHES
// The active-game reconnect pointer (ralli_active_game) was persisted ONLY for learners
// (gameRole === "user"), and the boot restore only reconnected in the standard-user branch
// via the learner-safe RPC. A host (admin-type profile, gameRole "admin") therefore never
// persisted the pointer and the admin boot branches never reconnected — so a host refresh
// fell through to restoredScreen ("rankd" hub) instead of reopening the live game. Learner
// recovery worked; host recovery did not. This asserts the two host-side boundaries are wired
// and, critically, that the learner path was NOT modified.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// ── WRITE side: persist gate now covers the host and tags the context with role ──
// Isolate the persist effect (the block that calls writeActiveGameContext).
const wIdx = src.indexOf("writeActiveGameContext({");
ok("writeActiveGameContext call site present", wIdx >= 0);
const persistBlock = src.slice(Math.max(0, wIdx - 500), wIdx + 400);
ok("1. persist gate admits BOTH host and learner (gameRole user||admin)",
   /gameRole === "user" \|\| gameRole === "admin"/.test(persistBlock));
ok("2. persisted context records role: gameRole (selects restore RPC on boot)",
   /role:\s*gameRole/.test(persistBlock));

// ── READ/ROUTE side: admin boot branches reconnect the host via the host-safe RPC ──
const hostReconnIdx = src.indexOf("Host active-game refresh reconnect");
ok("3. host reconnect block exists in the boot path", hostReconnIdx >= 0);
const boot = src.slice(hostReconnIdx, hostReconnIdx + 2600);
ok("4. host reconnect is gated to admin-type profiles",
   /isRalliAdmin\(profile\.role\) \|\| profile\.role === "orgAdmin"/.test(boot));
ok("5. host reconnect only fires for an admin-role context (hostCtx.role === \"admin\")",
   /hostCtx\.role === "admin"/.test(boot) && /hostCtx\.userId === profile\.id/.test(boot));
ok("6. host reconnect verifies via the HOST-safe RPC getSessionRestoreData (not the learner RPC)",
   /getSessionRestoreData\(hostCtx\.sessionDbId\)/.test(boot));
ok("7. host reconnect drops terminal/invalid sessions (never re-enter a finished game)",
   /status === "completed" \|\| s\.status === "canceled" \|\| s\.phase === "ended"/.test(boot) &&
   /clearActiveGameContext\(\)/.test(boot));
ok("8. host reconnect re-enters the game screen (rankd-game live, rankd-lobby if waiting)",
   /setActiveGameSessionDbId\(hostCtx\.sessionDbId\)/.test(boot) &&
   /setScreen\(live \? "rankd-game" : "rankd-lobby"\)/.test(boot));

// The admin branches must not override a successful host reconnect with the default screen.
ok("9. ralli-admin branch respects hostReconnected before setting a fallback screen",
   /if \(!hostReconnected\) setScreen\(restoredScreen \?\? defaultScreenForRestore\(true\)\)/.test(src));
ok("10. orgAdmin branch skips its fallback screen-set when a host game was reconnected",
   /Skipped entirely when a host game was just reconnected above\.[\s\S]{0,120}if \(!hostReconnected\)/.test(src));

// ── Learner path UNCHANGED (must not be touched by this fix) ──
ok("11. learner reconnect still uses the learner-safe RPC getPlayerSessionRestore (unmodified)",
   /getPlayerSessionRestore\(gameCtx\.sessionDbId\)/.test(src));
ok("12. learner reconnect still keyed on gameCtx.userId === profile.id (unmodified)",
   /gameCtx && gameCtx\.userId === profile\.id/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
