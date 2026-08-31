// Focused regressions for the final Ralli Live blockers (after 632f432):
// Blocker 1 — repeated-rejoin lost submission (fail-closed lock; Type button durable; retry UI).
// Blocker 2 — Type correctness agreement (host + learner read durable p.wasCorrect; grader is sound).
// Static source assertions on rankd-app.jsx + a live grader check. Run: node this-file.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { gradeAnswer } from "../../supabase/functions/_shared/gameGrading.js";
const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n); } };

// ── Blocker 1: never lock without a confirmed durable submission ──────────────
const ptl = app.slice(app.indexOf("const persistThenLock = async"), app.indexOf("const persistThenLock = async") + 1300);
ok("1 persistThenLock is FAIL-CLOSED: missing session/player id → retryable error, no optimistic lock",
   /if \(!sessionDbId \|\| !playerId\) \{ setSubmitErr\(true\); return; \}/.test(ptl));
ok("2 persistThenLock no longer wraps the submit in `if (sessionDbId && playerId)` (the fail-open skip)",
   !/if \(sessionDbId && playerId\) \{/.test(ptl));
ok("3 lock()/broadcast run only AFTER a successful submit (ok) — not reachable when submit is skipped",
   /const \{ ok \} = await submitGameAnswer\(sessionDbId, appliedQIdxRef\.current, payload\);[\s\S]{0,140}if \(!ok\) \{ setSubmitErr\(true\); return; \}[\s\S]{0,200}lock\(\);/.test(ptl));
ok("4 Type Submit button routes through the durable handleTextSubmit (no inline optimistic broadcast)",
   /<button onClick=\{handleTextSubmit\}/.test(app) &&
   !/setOpenSubmitted\(true\);\s*setPhase\("answered"\);\s*broadcast\(\{ type: GM\.ANSWER, playerId, name: playerName, text: openText\.trim\(\)/.test(app));
ok("5 a failed/stale submit shows a retryable error banner (submitErr is rendered, not just set)",
   /submitErr && phase === "question"[\s\S]{0,320}Couldn't save your answer/.test(app));
ok("6 submitErr is reset when a new question is applied (applyShowQuestion)",
   /setOpenSubmitted\(false\); setSubmitErr\(false\)/.test(app));

// ── Blocker 2: all views use the SAME durable correctness (no independent re-grade) ──
ok("7 learner reveal consumes durable p.wasCorrect (from reveal scores), not a local re-grade",
   /setIsCorrect\(chMsg\.isOpen \? null : \(me \? !!me\.wasCorrect : null\)\)/.test(app));
ok("8 learner reveal no longer re-grades Type against acceptedAnswers locally",
   !/revealCorrect = acc\.length > 0 && acc\.some\(a => openText\.toLowerCase\(\)\.trim\(\) === a\)/.test(app));
ok("9 host Type Player-Responses panel reads durable p.wasCorrect over the canonical roster scores",
   /const ans = revealSubs\?\.\[p\.id\] \?\? chAnswers\[p\.id\];\s*\/\/ display only[\s\S]{0,520}p\.wasCorrect \? "✓" : "✗"/.test(app));
ok("10 host Type panel no longer re-grades ephemeral chAnswers text against acceptedAnswers",
   !/const correct  = accepted\.length > 0 && accepted\.some\(a => \(ans\.text \?\? ""\)\.toLowerCase/.test(app));

// ── Blocker 2: the canonical grader is sound for the exact snapshot (trailing spaces) ──
const q = { type: "type", acceptedAnswers: ["great", "perfect", "so so ", "okay "] };
for (const a of ["great", "perfect", "so so", "okay"]) ok(`11 grader accepts "${a}" for the snapshot`, gradeAnswer(q, a).correct === true);
ok("12 grader is case/space tolerant (contract) — ' GREAT ' accepted", gradeAnswer(q, " GREAT ").correct === true);
ok("13 grader rejects a clearly-wrong answer", gradeAnswer(q, "nope").correct === false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
