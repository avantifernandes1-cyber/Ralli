// Focused regressions for the Ralli Live active-roster + terminal fixes (after 8b47202):
// (1) explicit Leave drops the active-response denominator; (2) rejoin restores it + immediate refresh;
// (3) learners recover terminal state durably and always have an exit. Static assertions on rankd-app.jsx.
// Run: node src/lib/ralliActiveTerminal.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n); } };

// ── Defect 1 & 2: active-response denominator + active-scoped numerator ────────
ok("1 progress denominator is the ACTIVE participant set (not the immutable roster): excludes 'left'/'completed'",
   /if \(p\.status === "left" \|\| p\.status === "completed"\) return false/.test(app));
ok("2 active set requires a fresh heartbeat (HEARTBEAT_FRESH_MS), null beat = just-joined eligible",
   /if \(!p\.last_seen_at\) return true;[\s\S]{0,140}HEARTBEAT_FRESH_MS/.test(app));
ok("3 numerator is durable submissions BY active participants (getHostGameState ∩ activeIds), not all submissions",
   /getHostGameState\(sessionDbId\)/.test(app) &&
   /const answeredActive = activeIds\.filter\(id => answered\.has\(id\)\)\.length/.test(app));
ok("4 the progress poll recomputes when the participant set changes (dbParticipants dep) — Leave/rejoin",
   /setAnswerProgress\(\{ answered: answeredActive, active: activeIds\.length \}\)[\s\S]{0,400}\}, \[sessionDbId, phase, qIdx, Object\.keys\(chAnswers\)\.length, dbParticipants\]\)/.test(app));
ok("5 participant poll re-runs on a Presence change (chPlayers.length dep) for prompt Leave/rejoin reflection",
   /const interval = setInterval\(refreshRoster, 5000\)[\s\S]{0,400}\}, \[sessionDbId, chPlayers\.length\]\)/.test(app));

// ── Defect 3: durable terminal recovery + exit ────────────────────────────────
ok("6 in-game reconcile recovers terminal state from AUTHORITATIVE status (not just phase==='ended')",
   /if \(s\.status === "completed" \|\| s\.status === "ended" \|\| s\.status === "canceled"\) \{[\s\S]{0,260}setPhase\("ended"\);\s*return;/.test(app));
ok("7 terminal recovery populates the final board from the durable published scoreboard",
   /const finalBoard = durableRestoreDecision\(s\);[\s\S]{0,120}setFinalScores\(scoreboardRows\(finalBoard\.entries\)\)/.test(app));
ok("8 final leaderboard has an obvious exit action (Back to Ralli Games → onNav('rankd'))",
   /onClick=\{\(\) => onNav\("rankd"\)\}[\s\S]{0,220}Back to Ralli Games/.test(app));
ok("9 the intermediate scoreboard is never a dead end — it has a Leave affordance",
   /Waiting for host to continue…[\s\S]{0,320}setShowLeaveConfirm\(true\)[\s\S]{0,400}Leave game/.test(app));

// ── Defect 3: terminal persisted BEFORE broadcast ─────────────────────────────
ok("10 host awaits durable terminal persistence (endGameSession) inside handleGameEnd",
   /const handleGameEnd = async \(data\)/.test(app) &&
   /await endGameSession\(lobbyPin, \{/.test(app));
ok("11 doNext AWAITS onGameEnd BEFORE broadcasting GM.GAME_END (persist-before-broadcast)",
   /const ok = onGameEnd \? await onGameEnd\(\{[\s\S]{0,120}\}\) : true;\s*if \(ok === false\) return;\s*broadcast\(\{ type: GM\.GAME_END/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
