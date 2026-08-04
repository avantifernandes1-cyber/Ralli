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

// ── Host reveal cutover: durable submissions are the ONLY scoring input ───────
ok("18 doReveal is async and invokes rpc_begin_question_reveal for the current question",
   /const doReveal = async \(\) =>/.test(host) && /const rev = await beginQuestionReveal\(sessionDbId, qIdx\)/.test(host));
ok("19 reveal grades the CANONICAL roster's durable submissions via reconcileReveal (shared grader), not chAnswers",
   /reconcileReveal\(\{[\s\S]{0,160}submissions: rev\.data\.submissions[\s\S]{0,120}gradeAnswer/.test(host) && /import \{ reconcileReveal \} from "\.\/src\/lib\/revealReconcile\.js"/.test(app));
ok("20 results are PERSISTED (recordQuestionResults) BEFORE publishReveal (broadcast)",
   /const persist = await recordQuestionResults\(sessionDbId, qIdx, answerRows\)[\s\S]{0,1600}publishReveal\(payload, newScores\)/.test(host) &&
   host.indexOf("recordQuestionResults(sessionDbId, qIdx, answerRows)") < host.indexOf("publishReveal(payload, newScores)"));
ok("19b reveal grades gradedQuestion (host-local, never the learner-broadcast payload)", /question: gradedQuestion,/.test(host));
ok("21 reveal/persist FAILURE blocks reveal + advance and is retryable (no broadcast)",
   /if \(persist\.error\) \{ hasRevealedRef\.current = false; setRevealErr\(true\); return; \}/.test(host) &&
   /if \(rev\.error && rev\.error\.code !== RPC_MISSING\) \{ hasRevealedRef\.current = false; setRevealErr\(true\); return; \}/.test(host));
ok("22 graceful fallback to legacy realtime path ONLY when the 084 RPCs are absent (pre-apply)",
   /else: RPC_MISSING \(pre-084\)/.test(host));
ok("23 auto-reveal + answered count come from rpc_answer_progress (server), not chAnswers/presence",
   /const answeredCount = answerProgress \? answerProgress\.answered : Object\.keys\(chAnswers\)\.length/.test(host) &&
   /const playerCount   = answerProgress \? Math\.max\(answerProgress\.active, 1\) : /.test(host) &&
   /getAnswerProgress\(sessionDbId, qIdx\)/.test(host));
ok("24 server progress resets each question (no premature auto-reveal from a stale count)",
   /useEffect\(\(\) => \{ setAnswerProgress\(null\); \}, \[qIdx\]\)/.test(host));
ok("25 host surfaces a retryable reveal error (revealErr banner + Retry reveal → doReveal)",
   /\{revealErr && \(/.test(host) && /setRevealErr\(false\); doReveal\(\)/.test(host));

// ── Learner reconnect restore ────────────────────────────────────────────────
ok("26 learner reconnect restores its OWN durable submission (rpc_my_submission) and re-locks",
   /getMySubmission\(sessionDbId, qi\)\.then\(/.test(player) && /if \(stale \|\| error \|\| !data\?\.found\) return;/.test(player));
ok("27 restore preserves every type incl Slider 0 (numeric_value != null), never resubmits",
   /t === "slider" && data\.numeric_value != null\) \{ setSliderValue\(Number\(data\.numeric_value\)\)/.test(player) &&
   /t === "match" && Array\.isArray\(data\.answer_json\)/.test(player) && !/submitGameAnswer/.test(player.slice(player.indexOf("getMySubmission"), player.indexOf("getMySubmission") + 700)));

// ── Open-ended durable cutover ────────────────────────────────────────────────
ok("29 open-review response list is built from canonical roster + durable submissions, not chAnswers",
   /const buildOpenResponses = \(\) => \{[\s\S]{0,260}openReveal\?\.roster/.test(host) &&
   /const openResponses = buildOpenResponses\(\);/.test(host));
ok("30 doReveal(open) fetches durable roster+responses via beginQuestionReveal; error blocks (retryable)",
   /if \(q\.type === "open"\)[\s\S]{0,400}const rev = await beginQuestionReveal\(sessionDbId, qIdx\)[\s\S]{0,220}setOpenReveal\(\{ roster: rev\.data\.roster/.test(host) &&
   /hasRevealedRef\.current = false; setRevealErr\(true\); return;   \/\/ do not advance to review/.test(host));
ok("31 doOpenGradeDone grades EVERY canonical member (openGrades keyed by player_id); unanswered present",
   /const doOpenGradeDone = async \(\) =>/.test(host) &&
   /const correct = openGrades\[m\.id\] === "correct"/.test(host) &&
   /text: textByPlayer\.get\(String\(m\.id\)\) \?\? null/.test(host));
ok("32 open results PERSIST (recordQuestionResults) BEFORE publishReveal; failure blocks reveal",
   /if \(sessionDbId && openReveal\) \{[\s\S]{0,240}const persist = await recordQuestionResults\(sessionDbId, qIdx, answerRows\)[\s\S]{0,120}if \(persist\.error\) \{ setRevealErr\(true\); return; \}[\s\S]{0,120}publishReveal\(\{ isOpen: true \}/.test(host));
ok("33 open grade buttons keyed by stable player_id (never array index)",
   /const grade = openGrades\[r\.playerId\]/.test(host) &&
   /\{ \.\.\.g, \[r\.playerId\]: g\[r\.playerId\] === "correct"/.test(host) && !/openGrades\[i\];/.test(host.slice(host.indexOf("open-review"), host.indexOf("open-review") + 4000)));
ok("34 host refresh during open-review restores durable open state via rpc_host_game_state",
   /phase !== "open-review" \|\| openReveal\) return;[\s\S]{0,160}getHostGameState\(sessionDbId\)[\s\S]{0,160}setOpenReveal\(\{ roster: data\.roster/.test(host));

// ── Rollout compatibility: fail-closed start is a structured {ok:false}, not an exception ─────
ok("35 fail-closed start returns {ok:false, no_eligible_learners} (old-client-safe), handled in the app",
   /'no_eligible_learners'/.test(readFileSync(join(here, "..", "..", "supabase", "migrations", "084_ralli_canonical_roster_durable_answers.sql"), "utf8")) &&
   /startData\.reason === "no_eligible_learners"/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
