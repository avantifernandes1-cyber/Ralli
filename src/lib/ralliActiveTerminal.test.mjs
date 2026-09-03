// Focused regressions for the Ralli Live active-roster + terminal fixes (after 8b47202):
// (1) explicit Leave drops the active-response denominator; (2) rejoin restores it + immediate refresh;
// (3) learners recover terminal state durably and always have an exit. Static assertions on rankd-app.jsx.
// Run: node src/lib/ralliActiveTerminal.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveHostPin } from "./hostPin.js";
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
   /const answeredActive = activeIds\.filter\(id => submitters\.has\(id\)\)\.length/.test(app));
ok("4 the progress poll recomputes when the participant set changes (dbParticipants dep) — Leave/rejoin",
   /setAnswerProgress\(\{ answered: answeredActive, active: activeIds\.length, qIdx: forQIdx \}\)[\s\S]{0,400}\}, \[sessionDbId, phase, qIdx, Object\.keys\(chAnswers\)\.length, dbParticipants\]\)/.test(app));
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

// ── Failure 1: current question reconciles immediately after a Leave (denominator dep) ────────
ok("12 auto-reveal effect depends on playerCount, so a denominator drop (Leave) immediately re-evaluates",
   /doReveal\(\);[\s\S]{0,500}\}, \[answeredCount, playerCount, phase, restoreState, halted, paused\]\)/.test(app));

// ── Failure 2: revision-guarded atomic progress snapshot (no out-of-order overwrite) ─────────
ok("13 progress refresh is revision-guarded: an older response is discarded (reqId !== latest)",
   /const reqId = \+\+progressReqRef\.current/.test(app) &&
   /if \(reqId !== progressReqRef\.current\) return;/.test(app));
ok("14 progress result is identity-guarded on the question it was requested for",
   /if \(\(data\.current_question_index \?\? forQIdx\) !== forQIdx\) return;/.test(app));
ok("15 progressReqRef is a monotonic ref (declared once)",
   /const progressReqRef = useRef\(0\)/.test(app));

// ── Failure 3: 0/0 display + presence-aware halt ──────────────────────────────
ok("16 denominator shows a genuine 0 active as 0 (no Math.max floor once the snapshot is loaded)",
   /const playerCount   = answerProgress \? answerProgress\.active : Math\.max\(chPlayers\.length, 1\)/.test(app));

// ── Host Game PIN (429bd0f): displayed value is derived from resolveHostPin(pin, restoredPin)
//    and shown across EVERY host phase, surviving a host refresh via the durable restored PIN.
//    These assert the CURRENT source/behavioral contract — the header no longer renders the raw
//    `pin` prop, so this file no longer requires the obsolete literal `{pin}` markup. ──────────
ok("17 host header imports resolveHostPin and derives the displayed value from resolveHostPin(pin, restoredPin)",
   /import \{ resolveHostPin \} from "\.\/src\/lib\/hostPin\.js"/.test(app) &&
   /const sessionPin = resolveHostPin\(pin, restoredPin\)/.test(app));
ok("18 the active gameplay header renders <HostGamePin pin={sessionPin} /> in the SAME control region as the players-answered count",
   /<HostGamePin pin=\{sessionPin\} \/>[\s\S]{0,400}\{answeredCount\}\/\{playerCount\}[\s\S]{0,140}players answered/.test(app));
ok("19 HostGamePin renders nothing when there is no PIN (no empty label)",
   /function HostGamePin\(\{ pin \}\) \{\s*if \(!pin\) return null;/.test(app));
ok("20 the durable restored-session PIN is captured as the fallback (setRestoredPin from the host restore)",
   /const \[restoredPin,\s*setRestoredPin\][\s\S]{0,80}useState\(null\)/.test(app) &&
   /if \(sess\.pin\) setRestoredPin\(sess\.pin\)/.test(app));
ok("21 PIN coverage across ALL host phases: open-review + scoreboard + question/reveal (HostGamePin), countdown (PIN: {sessionPin}), pause overlays (pinBlock)",
   (app.match(/<HostGamePin pin=\{sessionPin\} \/>/g) || []).length >= 3 &&
   /PIN: \{sessionPin\}/.test(app) &&
   /const pinBlock = sessionPin \? \(/.test(app) &&
   (app.match(/\{pinBlock\}/g) || []).length >= 2);
ok("22 pause overlays render the PIN only when it exists (pinBlock is sessionPin ? … : null)",
   /const pinBlock = sessionPin \? \([\s\S]{0,1000}\) : null;/.test(app));
// Behavioral contract of the resolver the header relies on (imported directly; no app code changed).
ok("23 resolveHostPin: empty live PIN + a restored PIN resolves to the restored value",
   resolveHostPin("", "492188") === "492188" && resolveHostPin(null, "492188") === "492188");
ok("24 resolveHostPin: live PIN preferred; both absent → null (so callers render no empty label)",
   resolveHostPin("492188", "999") === "492188" && resolveHostPin(null, null) === null && resolveHostPin("  ", "") === null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
