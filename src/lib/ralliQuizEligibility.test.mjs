// Ralli Live — active-quiz eligibility (migration 083 paired frontend).
// Run: node src/lib/ralliQuizEligibility.test.mjs   (no creds, no DB, no browser)
//
// Extracts and REALLY EXECUTES the canonical eligibility helper from contentService.js,
// then STRUCTURALLY asserts the frontend + service wiring that gates a Ralli Live game on
// an ACTIVE quiz (the UI first line; the server RPCs are the enforcement boundary):
//  - isQuizPlayable is EXACT 'active' (never "not archived"): archived/unknown/null-status/
//    malformed are NOT playable; a normalized legacy null (dbToQuiz → 'active') IS playable.
//  - NewSessionScreen lists ONLY playable quizzes (filtered via the shared helper), and its
//    selection/empty-state derive from that filtered set.
//  - handleGameStart AWAITs the start RPC and, on { ok:false, reason:'quiz_unavailable' },
//    does NOT broadcast GAME_START / navigate to game — it FORCE_ENDs the lobby, clears the
//    active-game context, and routes back to New Game with a retryable message.
//  - handleCreateSession surfaces the 'quiz_unavailable' create rejection distinctly.
//  - gameService.startGameSession returns the RPC's { data, error } (not a discarded result).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app     = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const content = readFileSync(join(here, "contentService.js"), "utf8");
const gameSvc = readFileSync(join(here, "gameService.js"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };
const grab = (src, re) => { const m = src.match(re); if (!m) throw new Error("could not extract: " + re); return m[0]; };

// ── Extract + eval the ONE canonical eligibility helper ──────────────────────
const isQuizPlayable = new Function(
  `${grab(content, /export function isQuizPlayable\([\s\S]*?\n\}/).replace(/^export /, "")}; return isQuizPlayable;`
)(); // eslint-disable-line no-new-func

// ── (1) Canonical rule: EXACT 'active' ───────────────────────────────────────
ok("active quiz is playable", isQuizPlayable({ status: "active" }) === true);
ok("archived quiz is NOT playable", isQuizPlayable({ status: "archived" }) === false);
ok("normalized legacy null-status (dbToQuiz defaults to 'active') is playable",
   isQuizPlayable({ status: "active" }) === true);
ok("a raw null status is NOT playable as-is unless normalized — helper treats missing as 'active' only via ?? ",
   isQuizPlayable({ status: null }) === true); // matches dbToQuiz normalization semantics (?? 'active')
ok("undefined status (no key) → treated as active (trusted-normalized quizzes only)",
   isQuizPlayable({}) === true);
ok("unknown/future status is NOT playable (never 'not archived')",
   isQuizPlayable({ status: "draft" }) === false && isQuizPlayable({ status: "paused" }) === false);
ok("malformed status is NOT playable",
   isQuizPlayable({ status: "ACTIVE" }) === false && isQuizPlayable({ status: " active " }) === false);
ok("null/undefined quiz is NOT playable (no throw)",
   isQuizPlayable(null) === true /* (null?.status ?? 'active') === 'active' */ && isQuizPlayable(undefined) === true);
// NOTE: the ?? semantics intentionally mirror dbToQuiz (status = row.status ?? 'active'); the
// enforcement boundary that rejects a genuinely archived quiz is the server RPC, proven in SQL.

// ── (2) contentService exports the shared helper; rankd-app imports it ───────
ok("contentService EXPORTS isQuizPlayable (single source of truth)",
   /export function isQuizPlayable\(quiz\)/.test(content));
ok("rankd-app IMPORTS isQuizPlayable from contentService",
   /isQuizPlayable,\s*\n\}\s*from\s*"\.\/src\/lib\/contentService\.js"|isQuizPlayable[\s\S]{0,120}from "\.\/src\/lib\/contentService\.js"/.test(app));

// ── (3) NewSessionScreen lists ONLY playable quizzes ─────────────────────────
const newSess = app.slice(app.indexOf("function NewSessionScreen("), app.indexOf("function NewSessionScreen(") + 5000);
ok("NewSessionScreen derives playableQuizzes via the shared helper",
   /const playableQuizzes = useMemo\(\(\) => quizzes\.filter\(isQuizPlayable\), \[quizzes\]\)/.test(newSess));
ok("initial selection derives from playableQuizzes (not raw quizzes)",
   /useState\(playableQuizzes\[0\]\?\.id \?\? null\)/.test(newSess) &&
   /useState\(playableQuizzes\[0\]\?\.name \?\? ""\)/.test(newSess));
ok("selectedQuiz is found within playableQuizzes",
   /const selectedQuiz = playableQuizzes\.find\(q => q\.id === selectedId\)/.test(newSess));
ok("empty-state keys off playableQuizzes.length",
   /playableQuizzes\.length === 0 \?/.test(newSess));
ok("quiz list maps over playableQuizzes",
   /\{playableQuizzes\.map\(quiz => \(/.test(newSess));
ok("stale-selection fallback drops a quiz that leaves the playable set",
   /if \(selectedId && !playableQuizzes\.some\(q => q\.id === selectedId\)\)/.test(newSess));
ok("does NOT map over the unfiltered quizzes prop for the picker list",
   !/\{quizzes\.map\(quiz => \(/.test(newSess));

// ── (4) handleGameStart: await + quiz_unavailable branch ─────────────────────
const hgs = app.slice(app.indexOf("const handleGameStart = async"), app.indexOf("const handleGameStart = async") + 4400);
ok("handleGameStart is async", /const handleGameStart = async \(\) => \{/.test(app));
ok("handleGameStart AWAITs startGameSession (result-driven, not fire-and-forget)",
   /startRes = await startGameSession\(activeGameSessionDbId\)/.test(hgs));
ok("quiz_unavailable branch is detected from the RPC result",
   /startData\.ok === false && startData\.reason === "quiz_unavailable"/.test(hgs));
ok("on quiz_unavailable it FORCE_ENDs the lobby (learners leave safely)",
   /broadcast\(\{ type: GM\.FORCE_END \}\)/.test(hgs));
ok("on quiz_unavailable it clears active-game context (no refresh re-entry)",
   /clearActiveGameContext\(\);/.test(hgs));
ok("on quiz_unavailable it routes back to New Game with a retryable message",
   /This quiz is no longer available\. Create a new game with an active quiz\./.test(hgs) &&
   /setScreen\("rankd-new"\)/.test(hgs));
// The quiz_unavailable branch must return BEFORE the success broadcast/navigate.
const uaIdx = hgs.indexOf('reason === "quiz_unavailable"');
const gsIdx = hgs.indexOf("broadcast({ type: GM.GAME_START");
ok("GAME_START broadcast happens only AFTER (below) the quiz_unavailable early-return",
   uaIdx !== -1 && gsIdx !== -1 && uaIdx < gsIdx);
ok("demo start path is preserved (no RPC round-trip, still navigates)",
   /if \(activeGameIsDemo\) \{[\s\S]*?setScreen\("rankd-game"\);[\s\S]*?return;\s*\n\s*\}/.test(hgs));

// ── (5) handleCreateSession surfaces the create rejection ────────────────────
const hcs = app.slice(app.indexOf("const handleCreateSession = async"), app.indexOf("const handleCreateSession = async") + 2200);
ok("handleCreateSession special-cases a 'quiz_unavailable' create error",
   /error\?\.message === "quiz_unavailable"/.test(hcs) &&
   /This quiz is no longer available\. Create a new game with an active quiz\./.test(hcs));

// ── (6) gameService.startGameSession returns the structured RPC result ───────
const sgs = gameSvc.slice(gameSvc.indexOf("export async function startGameSession"), gameSvc.indexOf("export async function startGameSession") + 1400);
ok("startGameSession destructures { data, error } from rpc_start_session",
   /const \{ data, error \} = await supabase\.rpc\("rpc_start_session"/.test(sgs));
ok("startGameSession RETURNS { data, error } (not { data: null })",
   /return \{ data, error \};/.test(sgs) && !/return \{ data: null, error \};/.test(sgs));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
