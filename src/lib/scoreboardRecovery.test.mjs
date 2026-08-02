// EXECUTABLE tests for the shared scoreboard recovery contract (migration 081 client wiring).
// Run: node src/lib/scoreboardRecovery.test.mjs   — imports and EXECUTES the real pure helpers
// (no regex "the string exists" checks for the core decision).
import { scoreboardApplyDecision, durableRestoreDecision, scoreboardRows, scoreboardPublishKey } from "./scoreboardRecovery.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };

const board = (over = {}) => ({ session_id: "S", q_idx: 2, version: 5,
  entries: [{ id: "a", name: "Ann", emoji: null, score: 100, delta: 10, rank: 1 },
            { id: "b", name: "Bob", emoji: "X", score: 100, delta: 0, rank: 1 }], ...over });
const ctx = (over = {}) => ({ sessionDbId: "S", currentQIdx: 2, localPhase: "question", appliedVersion: -Infinity, ...over });

// 7. Normal realtime scoreboard applies (reveal/question @ qIdx 2, version 5)
ok("7 normal realtime scoreboard applies", (() => { const d = scoreboardApplyDecision(board(), ctx()); return d && d.version === 5 && d.entries.length === 2; })());
// 8. Same-version duplicate is harmless (dropped for realtime; no throw/corruption)
ok("8 same-version realtime duplicate dropped", scoreboardApplyDecision(board({ version: 5 }), ctx({ appliedVersion: 5 })) === null);
// 9. Older-version rejected
ok("9 older version rejected", scoreboardApplyDecision(board({ version: 3 }), ctx({ appliedVersion: 5 })) === null);
// 10. Old-qIdx event rejected after next question (client advanced to qIdx 3)
ok("10 old-qIdx event rejected after next question", scoreboardApplyDecision(board({ q_idx: 2 }), ctx({ currentQIdx: 3 })) === null);
// 11. Rejected after terminal state
ok("11a rejected when local phase ended", scoreboardApplyDecision(board(), ctx({ localPhase: "ended" })) === null);
ok("11b rejected when local phase canceled", scoreboardApplyDecision(board(), ctx({ localPhase: "canceled" })) === null);
ok("11c rejected when local phase completed", scoreboardApplyDecision(board(), ctx({ localPhase: "completed" })) === null);
// 12. Session mismatch rejected
ok("12 session mismatch rejected", scoreboardApplyDecision(board(), ctx({ sessionDbId: "OTHER" })) === null);
// initial-mount idempotent same-version reapply allowed (allowEqualVersion)
ok("initial-mount idempotent same-version reapply allowed", scoreboardApplyDecision(board({ version: 5 }), ctx({ appliedVersion: 5, allowEqualVersion: true })) !== null);
// unknown qIdx (currentQIdx null, e.g. fresh mount) → qIdx guard skipped, applies
ok("fresh mount (currentQIdx null) applies", scoreboardApplyDecision(board(), ctx({ currentQIdx: null })) !== null);
// malformed payloads
ok("malformed payloads rejected", scoreboardApplyDecision(null, ctx()) === null && scoreboardApplyDecision({ entries: 3 }, ctx()) === null);

// 1/2. durable restore applies when the session object agrees with its embedded payload
const session = (over = {}) => ({ id: "S", phase: "scoreboard", current_question_index: 2, scoreboard_version: 5, live_scoreboard: board(), ...over });
ok("1/2 durable restore applies (host+learner) when payload agrees with columns", (() => { const d = durableRestoreDecision(session()); return d && d.version === 5 && d.entries.length === 2; })());
ok("durable restore null when session not in scoreboard phase", durableRestoreDecision(session({ phase: "question" })) === null);
// 13. Durable payload/column disagreement rejected (version, qIdx, session)
ok("13a durable version disagreement rejected", durableRestoreDecision(session({ scoreboard_version: 9 })) === null);
ok("13b durable qIdx disagreement rejected", durableRestoreDecision(session({ current_question_index: 9 })) === null);
ok("13c durable session disagreement rejected", durableRestoreDecision(session({ live_scoreboard: board({ session_id: "OTHER" }) })) === null);
ok("durable restore null when no live_scoreboard", durableRestoreDecision(session({ live_scoreboard: null })) === null);

// 14/15/16. host adapter preserves server order + ranks; null avatar; ties
const rows = scoreboardRows(board().entries);
ok("14 host adapter preserves server ORDER (Ann then Bob, as ranked)", rows[0].id === "a" && rows[1].id === "b");
ok("14b host adapter preserves server RANKS (no re-rank)", rows[0].rank === 1 && rows[1].rank === 1);
ok("16 ties preserved (both rank 1, equal scores)", rows[0].score === 100 && rows[1].score === 100 && rows[0].rank === rows[1].rank);
ok("15 null avatar preserved", rows[0].emoji === null);
ok("host adapter never invents a rank/name (passes them through)", scoreboardRows([{ id: "z", score: 5 }])[0].rank === null);

// 17/18. publish key stable per episode; new qIdx → new key
ok("17 publish key stable across retry/rerender (deterministic per session+qIdx)", scoreboardPublishKey("S", 2) === scoreboardPublishKey("S", 2) && scoreboardPublishKey("S", 2) === "S:q2");
ok("18 new qIdx gets a new key", scoreboardPublishKey("S", 2) !== scoreboardPublishKey("S", 3));

// ── Structural (wiring): host applies durable board; host doesn't republish on refresh; in-flight guard ──
const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "rankd-app.jsx"), "utf8");
const host = app.slice(app.indexOf("function KahootHostView("), app.indexOf("function KahootPlayerView("));
ok("3 host restore applies durable board (durableRestoreDecision + scoreboardRows→setScores)",
   /const hostBoard = durableRestoreDecision\(sess\);[\s\S]{0,120}setScores\(scoreboardRows\(hostBoard\.entries\)\)/.test(host));
ok("3b host answer-reconstruction is skipped when a durable board was restored (no re-rank)",
   /if \(!hostBoard && answers\.data\?\.length\)/.test(host));
ok("19/20 host publish is in-flight-guarded, keyed, awaited before broadcast",
   /if \(publishingRef\.current\) return;[\s\S]{0,300}const publishKey = scoreboardPublishKey\(sessionDbId, qIdx\);[\s\S]{0,220}await publishScoreboard\(sessionDbId, qIdx, minScores, publishKey\)[\s\S]{0,500}broadcast\(\{ type: GM\.SCOREBOARD, board/.test(host));
// 20. no broadcast before durable success — the failure branch returns before any broadcast.
ok("20 host failure returns before broadcast (no broadcast without durable success)",
   /if \(error \|\| !board\) \{[\s\S]{0,220}return;[\s\S]{0,60}\}[\s\S]{0,120}broadcast\(\{ type: GM\.SCOREBOARD, board/.test(host));
// gameService wrapper passes the publish key through.
const gsvc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "gameService.js"), "utf8");
ok("gameService.publishScoreboard passes p_publish_key",
   /export async function publishScoreboard\(sessionId, qIdx, scores, publishKey\)/.test(gsvc) &&
   /p_publish_key: publishKey/.test(gsvc));
const player = app.slice(app.indexOf("function KahootPlayerView("), app.indexOf("function KahootPlayerView(") + 30000);
ok("4/5/6 learner reconcile runs on mount, SUBSCRIBED, visibility, and focus (all recovery triggers)",
   /useEffect\(\(\) => \{ reconcile\(\); \}, \[sessionDbId, playerId\]\)/.test(player) &&
   /if \(chStatus === "SUBSCRIBED"\) reconcile\(\)/.test(player) &&
   /document\.visibilityState === "visible"\) reconcile\(\)/.test(player) &&
   /addEventListener\("focus", onVisible\)/.test(player));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
