// Focused regressions for the Ralli Live realtime-lifecycle fixes (commit after 18c42d4):
// durable countdown recovery, lobby→game poll-nav Leave guard, and heartbeat-truth zero-player halt.
// Static source assertions against rankd-app.jsx — run: node src/lib/ralliLifecycleFixes.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n); } };

// ── Countdown durable recovery ────────────────────────────────────────────────
const hgs = app.slice(app.indexOf("const handleGameStart = async"), app.indexOf("const handleGameStart = async") + 7200);
ok("1 handleGameStart persists phase='countdown' durably at start (updateSessionPhase)",
   /updateSessionPhase\(activeGameSessionDbId, \{ phase: "countdown"/.test(hgs));
ok("2 the durable countdown persist happens BEFORE the GM.GAME_START broadcast",
   hgs.indexOf('phase: "countdown"') !== -1 &&
   hgs.indexOf('phase: "countdown"') < hgs.indexOf("broadcast({ type: GM.GAME_START"));
ok("3 learner reconcile can restore a countdown from durable phase==='countdown'",
   /if \(s\.phase === "countdown" &&[\s\S]{0,90}setPhase\("countdown"\)/.test(app));

// ── Lobby→game poll-nav Leave guard ───────────────────────────────────────────
// The durable status-poll fallback nav must set advancingToGameRef (like the broadcast path) so the
// lobby leave-on-unmount cleanup does NOT mark a still-connected learner 'left'.
const pollIdx = app.indexOf("Player: poll game_sessions.phase as countdown/start fallback");
const pollBlock = app.slice(pollIdx, pollIdx + 2000);
ok("4 durable poll-fallback nav sets advancingToGameRef before onNav('rankd-game')",
   /advancingToGameRef\.current = true; onNav\("rankd-game"\)/.test(pollBlock));
// The broadcast nav path already guarded it — ensure it still does (no regression).
ok("5 broadcast nav path still guards advancingToGameRef",
   /GM\.GAME_START\) \{ advancingToGameRef\.current = true; onNav\("rankd-game"\)/.test(app));
// The lobby cleanup still bails when advancing to the game (guard intact).
ok("6 lobby leave-on-unmount cleanup still bails when advancingToGameRef is set",
   /if \(advancingToGameRef\.current\) return;[\s\S]{0,200}markParticipantLeft\(sessionDbId, playerId\)/.test(app));

// ── Heartbeat-truth zero-player halt ──────────────────────────────────────────
// The halt fallback count must count a FRESH heartbeat regardless of status='left' (a spurious leave
// must not zero a demonstrably-connected learner). The halt count block is the `activeForHalt` filter.
const afhIdx = app.indexOf("const activeForHalt = data.filter");
const afhBlock = app.slice(afhIdx, afhIdx + 360);
ok("7 activeForHalt counts by heartbeat freshness (HEARTBEAT_FRESH_MS), null beat excluded",
   /if \(!p\.last_seen_at\) return false;[\s\S]{0,120}HEARTBEAT_FRESH_MS/.test(afhBlock));
ok("8 activeForHalt HONORS an explicit Leave (gates on status='left'); spurious-left is protected by raw Presence",
   /if \(!statusOk\) return false/.test(afhBlock) &&
   /const presenceActiveCount = chPlayers\.filter\(p => p\.id\)\.length/.test(app));
// The DISPLAY roster count (`active`) is separate and may still consider status — unchanged.
ok("9 the display roster count still exists (separate from the halt count)",
   /const active = data\.filter/.test(app));

// ── Reconnect must not auto-resume a paused game ──────────────────────────────
ok("10 host restore preserves the durable paused flag (no auto-resume on reconnect)",
   /setPaused\(sess\.paused \?\? false\)/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
