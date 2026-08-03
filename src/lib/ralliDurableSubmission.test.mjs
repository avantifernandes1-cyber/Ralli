// Frontend regression guard for migration 084's client integration (canonical roster + durable
// answer submission). Run: node src/lib/ralliDurableSubmission.test.mjs
//
// THE BUGS THIS LOCKS OUT
//  - Answers must persist to the DB (rpc_submit_game_answer, player = auth.uid) BEFORE the learner
//    locks/broadcasts — a missed/forged broadcast can no longer lose or forge an answer.
//  - The host must seed scoring from the server CANONICAL roster, never a Q0 presence snapshot or
//    chAnswers keys — no durably-joined learner is silently dropped.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const svc = readFileSync(join(here, "gameService.js"), "utf8");
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const player = app.slice(app.indexOf("function KahootPlayerView("), app.length);
const host = app.slice(app.indexOf("function KahootHostView("), app.indexOf("function KahootPlayerView("));

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };

// ── Service layer: exact RPC wiring ──────────────────────────────────────────
ok("1 submitGameAnswer → rpc_submit_game_answer(p_session_id,p_question_idx,p_answer)",
   /export async function submitGameAnswer\(sessionId, questionIdx, answer\)/.test(svc) &&
   /rpc\("rpc_submit_game_answer", \{[\s\S]*p_session_id: sessionId, p_question_idx: questionIdx, p_answer: answer/.test(svc));
ok("2 beginQuestionReveal → rpc_begin_question_reveal",
   /export async function beginQuestionReveal\(sessionId, questionIdx\)/.test(svc) && /rpc\("rpc_begin_question_reveal"/.test(svc));
ok("3 getHostGameState → rpc_host_game_state", /export async function getHostGameState\(sessionId\)/.test(svc) && /rpc\("rpc_host_game_state"/.test(svc));
ok("4 getAnswerProgress → rpc_answer_progress", /export async function getAnswerProgress\(sessionId, questionIdx\)/.test(svc) && /rpc\("rpc_answer_progress"/.test(svc));
ok("5 submitGameAnswer never returns/derives a client player id (server auth.uid only)",
   !/p_player_id|player_id:/.test(svc.slice(svc.indexOf("submitGameAnswer"), svc.indexOf("submitGameAnswer") + 500)));

// ── Learner: durable-FIRST (persist → then lock → then broadcast) ────────────
ok("6 persistThenLock awaits submitGameAnswer and does NOT lock on failure",
   /const \{ ok \} = await submitGameAnswer\(sessionDbId, appliedQIdxRef\.current, payload\)/.test(player) &&
   /if \(!ok\) \{ setSubmitErr\(true\); return; \}/.test(player) &&
   /persistThenLock = async \(payload, lock, notify\)/.test(player));
ok("7 lock + broadcast happen ONLY after durable acceptance (in persistThenLock, after the ok gate)",
   /if \(!ok\) \{ setSubmitErr\(true\); return; \}[\s\S]{0,80}lock\(\);[\s\S]{0,40}broadcast\(notify\)/.test(player));
ok("8 MC/TF handler is durable-first ({option_idx})", /persistThenLock\(\{ option_idx: idx \}/.test(player));
ok("9 Slider handler is durable-first and preserves the value ({value: submitted})", /persistThenLock\(\{ value: submitted \}/.test(player));
ok("10 Matching handler is durable-first ({pairs:[{leftIdx,rightIdx}]})", /persistThenLock\(\{ pairs: matchPairs\.map\(mp => \(\{ leftIdx: mp\.leftIdx, rightIdx: mp\.rightIdx \}\)\) \}/.test(player));
ok("11 Type/Open handler is durable-first ({text}); button + Enter both route through it",
   /const handleTextSubmit = \(\) => \{/.test(player) && /persistThenLock\(\{ text \}/.test(player) &&
   /onClick=\{handleTextSubmit\}/.test(player) && /if \(e\.key === "Enter"\) handleTextSubmit\(\)/.test(player));
ok("12 NO learner handler locks+broadcasts an answer WITHOUT persisting first (old fire-and-forget gone)",
   !/setSelectedIdx\(idx\); setPhase\("answered"\);\s*\n\s*broadcast\(\{ type: GM\.ANSWER/.test(player) &&
   !/setSliderSubmitted\(true\); setPhase\("answered"\);\s*\n\s*broadcast\(\{ type: GM\.ANSWER/.test(player));

// ── Host: canonical roster is membership truth (not Q0 presence / chAnswers keys) ──
ok("13 host holds a canonical roster ref + seeds score rows from it", /const canonicalRosterRef = useRef\(\[\]\)/.test(host) && /const rosterScoreRows = \(\) =>/.test(host));
ok("14 countdown seeds scores from the canonical roster (rosterScoreRows), NOT chPlayers directly",
   /if \(phase === "countdown" && \(qIdx === 0 \|\| scores\.length === 0\)\) setScores\(rosterScoreRows\(\)\)/.test(host) &&
   !/setScores\(chPlayers\.map\(p => \(\{ \.\.\.p, score: 0 \}\)\)\);?\s*\n\s*\}, \[chPlayers\.length, restoreState\]/.test(host));
ok("15 host fetches the canonical roster (rpc_host_game_state) and merges every member into scores",
   /getHostGameState\(sessionDbId\)\.then\(/.test(host) && /canonicalRosterRef\.current = data\.roster/.test(host) &&
   /for \(const m of data\.roster\) if \(!byId\.has\(m\.id\)\)/.test(host));
ok("16 rosterScoreRows falls back to presence only when no canonical roster (graceful pre-084)",
   /if \(r && r\.length\) return r\.map\(m => \(\{ id: m\.id[\s\S]{0,120}return chPlayers\.map\(p => \(\{ \.\.\.p, score: 0 \}\)\)/.test(host));
// start RPC returns the canonical roster (additive), used by the host.
ok("17 startGameSession returns the RPC data incl. canonical roster", /rpc\("rpc_start_session"[\s\S]{0,600}return \{ data, error \}/.test(svc) && /data\.roster` is the immutable canonical roster/.test(svc));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
