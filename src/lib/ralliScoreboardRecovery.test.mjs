// Ralli Live durable scoreboard recovery (migration 081 paired frontend).
// Run: node src/lib/ralliScoreboardRecovery.test.mjs   (no creds, no DB, no browser)
//
// Extracts + REALLY EXECUTES the shared scoreboardApplyDecision guard, then STRUCTURALLY asserts
// the service + host publish + learner apply wiring (broadcast fast path; DB recovery source).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const gameSvc = readFileSync(join(here, "gameService.js"), "utf8");
let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };
const grab = (src, re) => { const m = src.match(re); if (!m) throw new Error("extract: " + re); return m[0]; };

// ── (1) Execute the shared apply-decision guard ──────────────────────────────
const decide = new Function(`${grab(app, /function scoreboardApplyDecision\([\s\S]*?\n\}/)}; return scoreboardApplyDecision;`)();
const payload = (over = {}) => ({ session_id: "S", q_idx: 2, version: 5, entries: [{ id: "a", score: 10 }], ...over });
ok("valid payload applies (entries+version)", (() => { const d = decide(payload(), { sessionDbId: "S", appliedVersion: -Infinity }); return d && d.version === 5 && d.entries.length === 1; })());
ok("session mismatch → null", decide(payload(), { sessionDbId: "OTHER", appliedVersion: -Infinity }) === null);
ok("older version than applied → null (monotonic)", decide(payload({ version: 3 }), { sessionDbId: "S", appliedVersion: 5 }) === null);
ok("equal version re-applies (idempotent restore == broadcast)", decide(payload({ version: 5 }), { sessionDbId: "S", appliedVersion: 5 }) !== null);
ok("newer version applies", decide(payload({ version: 9 }), { sessionDbId: "S", appliedVersion: 5 }) !== null);
ok("null / non-array / missing entries → null",
   decide(null, {}) === null && decide({ entries: 7 }, {}) === null && decide({ session_id: "S" }, {}) === null);
ok("no sessionDbId → session check skipped (still applies)", decide(payload(), { appliedVersion: -Infinity }) !== null);

// ── (2) gameService.publishScoreboard ────────────────────────────────────────
const sgs = gameSvc.slice(gameSvc.indexOf("export async function publishScoreboard"), gameSvc.indexOf("export async function publishScoreboard") + 900);
ok("publishScoreboard calls rpc_publish_scoreboard with session/qidx/scores/publish_key",
   /supabase\.rpc\("rpc_publish_scoreboard",\s*\{[\s\S]*p_session_id: sessionId,\s*p_qidx: qIdx,\s*p_scores: minimal,\s*p_publish_key: publishKey/.test(sgs));
ok("publishScoreboard accepts a publishKey param (idempotency)", /export async function publishScoreboard\(sessionId, qIdx, scores, publishKey\)/.test(sgs));
ok("publishScoreboard sends only minimal {id,score,delta} (no client names/avatars)",
   /minimal = \(scores \?\? \[\]\)\.map\(s => \(\{[\s\S]*id: s\.id, score: Number\(s\.score[\s\S]*delta: Number\(s\.delta/.test(sgs));
ok("publishScoreboard returns { data, error }", /return \{ data, error \};/.test(sgs));
ok("rankd-app imports publishScoreboard", /publishScoreboard,/.test(app));

// ── (3) Host publish cutover (KahootHostView) ────────────────────────────────
const host = app.slice(app.indexOf("function KahootHostView("), app.indexOf("function KahootPlayerView("));
ok("KahootHostView has toast in scope (useToast) — host publish-failure toast cannot throw",
   /function KahootHostView\([\s\S]{0,200}const toast\s*=\s*useToast\(\)/.test(host));
ok("host scoreboard button AWAITs publishScoreboard with a stable per-episode publish key",
   /const publishKey = `\$\{sessionDbId\}:q\$\{qIdx\}`;[\s\S]{0,120}await publishScoreboard\(sessionDbId, qIdx, minScores, publishKey\)/.test(host));
ok("host has an in-flight publish guard (double-click safe; DB idempotency authoritative)",
   /const publishingRef = useRef\(false\)/.test(host) && /if \(publishingRef\.current\) return;[\s\S]{0,80}publishingRef\.current = true;/.test(host));
ok("host broadcasts the RETURNED canonical board (not its raw input)",
   /broadcast\(\{ type: GM\.SCOREBOARD, board, isFinal: isFinalQ \}\)/.test(host));
ok("host demo path stays client-only (broadcasts raw scores, no RPC)",
   /if \(demoMode \|\| !sessionDbId\) \{[\s\S]{0,220}broadcast\(\{ type: GM\.SCOREBOARD, scores, isFinal: isFinalQ \}\)/.test(host));
ok("host publish failure preserves reveal (returns, no broadcast) + guarded toast",
   /if \(error \|\| !board\) \{[\s\S]{0,200}try \{ toast\.error[\s\S]{0,120}return;/.test(host));

// ── (4) Learner apply via the shared guard (broadcast + restore + monotonic ref) ──
const player = app.slice(app.indexOf("function KahootPlayerView("), app.indexOf("function KahootPlayerView(") + 30000);
ok("learner has a monotonic applied-version ref", /const appliedSbVersionRef = useRef\(-Infinity\)/.test(player));
ok("learner applyScoreboard uses the shared decision + sets ref + finalScores + phase",
   /const applyScoreboard = useCallback\(\(payload\) => \{[\s\S]{0,400}scoreboardApplyDecision\(payload, \{ sessionDbId, appliedVersion: appliedSbVersionRef\.current \}\)[\s\S]{0,200}appliedSbVersionRef\.current = d\.version;[\s\S]{0,80}setFinalScores\(d\.entries\);[\s\S]{0,40}setPhase\("scoreboard"\)/.test(player));
ok("learner realtime SCOREBOARD prefers canonical board via applyScoreboard, legacy scores fallback",
   /if \(chMsg\.type === GM\.SCOREBOARD\) \{[\s\S]{0,260}if \(chMsg\.board\) applyScoreboard\(chMsg\.board\)[\s\S]{0,120}else if \(chMsg\.scores\) setFinalScores\(chMsg\.scores\)/.test(player));
ok("learner durable restore applies live_scoreboard from the session row",
   /if \(s\.phase === "scoreboard"\) \{[\s\S]{0,500}applyScoreboard\(s\.live_scoreboard\);[\s\S]{0,80}setPhase\("scoreboard"\)/.test(player));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
