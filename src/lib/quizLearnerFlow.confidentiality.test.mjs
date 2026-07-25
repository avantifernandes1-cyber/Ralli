// Repeatable confidentiality invariants for the learner quiz flow (Stage 1b).
// Run: node src/lib/quizLearnerFlow.confidentiality.test.mjs   (no creds, no DB)
//
// The Supabase client can't be imported headless (it needs import.meta.env), so
// instead of a runtime spy this asserts the source-level invariants that a
// `.questions` grep can't: that NO learner-reachable code fetches raw
// answer-bearing rows, full quiz questions, another learner's attempts, or the
// protected solution snapshots. It fails loudly if any of those are reintroduced.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app        = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const content    = readFileSync(join(here, "contentService.js"), "utf8");
const insights   = readFileSync(join(here, "insightsService.js"), "utf8");
const migration  = readFileSync(join(here, "..", "..", "supabase", "migrations", "055_learner_safe_quiz_access.sql"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond) => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n); } };

// Extract a function/hook body by brace-matching. Skips the parameter list
// first (so a destructured first param like `({ row, onBack })` isn't mistaken
// for the body), then brace-matches the real body block.
function body(src, decl) {
  const start = src.indexOf(decl);
  if (start < 0) return "";
  // Close the parameter list: match parens from the first '(' after the decl.
  let p = src.indexOf("(", start), pd = 0, k = p;
  for (; k < src.length; k++) { if (src[k] === "(") pd++; else if (src[k] === ")") { pd--; if (pd === 0) break; } }
  // The function body is the first '{' after the parameter list closes.
  let i = src.indexOf("{", k), depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i, j + 1); }
  }
  return src.slice(i);
}

// ── 1. The shared learner hook fetches SAFE summaries, not raw attempts ───────
{
  const hook = body(app, "function useSharedUserAssignmentData");
  ok("1a shared hook uses getMyQuizAttemptsSafe", hook.includes("getMyQuizAttemptsSafe("));
  ok("1b shared hook does NOT call getUserQuizAttempts", !hook.includes("getUserQuizAttempts("));
  ok("1c shared hook has no direct quiz_attempts SELECT", !hook.includes('.from("quiz_attempts")'));
}

// ── 2. The rep Progress screen fetches SAFE summaries too ────────────────────
{
  const prog = body(app, "function ProgressScreen");
  ok("2a ProgressScreen uses getMyQuizAttemptsSafe", prog.includes("getMyQuizAttemptsSafe("));
  ok("2b ProgressScreen does NOT call getUserQuizAttempts", !prog.includes("getUserQuizAttempts("));
}

// ── 3. getUserQuizAttempts is not called anywhere in the app (comment only) ──
{
  const calls = (app.match(/getUserQuizAttempts\(/g) || []).length;
  ok("3a no getUserQuizAttempts() call sites in app", calls === 0);
}

// ── 4. The safe RPC returns NO answers and is own-user-scoped ────────────────
{
  const createIdx = migration.indexOf("CREATE OR REPLACE FUNCTION public.list_my_quiz_attempts_safe");
  const fnBody = migration.slice(createIdx, migration.indexOf("REVOKE ALL ON FUNCTION public.list_my_quiz_attempts_safe", createIdx));
  ok("4a safe RPC selects no answers column", !/'answers'|\.answers|qa\.answers/.test(fnBody));
  ok("4b safe RPC filters user_id = auth.uid()", /WHERE qa\.user_id = v_uid/.test(fnBody));
  ok("4c safe RPC exposes no solution/correct", !/solution|acceptedAnswers|'correct'/.test(fnBody));
}

// ── 5. Learner contentService wrappers hit RPCs, not raw answer/question tables ─
{
  const wrap = (name) => body(content, `export async function ${name}(`);
  ok("5a getMyQuizAttemptsSafe → rpc", wrap("getMyQuizAttemptsSafe").includes('rpc("list_my_quiz_attempts_safe")'));
  ok("5b listQuizzesForLearner → rpc", wrap("listQuizzesForLearner").includes('rpc("list_quizzes_for_learner")'));
  ok("5c getQuizForAttempt → rpc", wrap("getQuizForAttempt").includes('rpc("get_quiz_for_attempt"'));
  ok("5d getQuizReview → rpc", wrap("getQuizReview").includes('rpc("get_quiz_review"'));
  // None of the learner wrappers read raw tables:
  ok("5e learner wrappers avoid raw quiz_attempts/tenant_quizzes",
    ["getMyQuizAttemptsSafe", "listQuizzesForLearner", "getQuizForAttempt", "getQuizReview"]
      .every(n => !wrap(n).includes('.from("quiz_attempts")') && !wrap(n).includes('.from("tenant_quizzes")')));
}

// ── 6. Snapshot table is read ONLY by the manager-scoped wrapper ─────────────
{
  const snapCalls = (app.match(/getAttemptSolutions\(/g) || []).length;
  const drill = body(app, "function QuizAttemptDrilldown");
  ok("6a getAttemptSolutions only used by manager drill-down", snapCalls === 1 && drill.includes("getAttemptSolutions("));
  ok("6b no direct quiz_attempt_solutions SELECT in app", !app.includes('.from("quiz_attempt_solutions")'));
}

// ── 7. Bootstrap catalog is role-gated (learner → metadata RPC only) ─────────
{
  ok("7a learner bootstrap uses listQuizzesForLearner", /role === "user"[\s\S]{0,200}listQuizzesForLearner\(/.test(app));
  ok("7b getTenantQuizzes reserved for the non-learner branch", /else \{[\s\S]{0,200}getTenantQuizzes\(tenantId\)/.test(app));
}

// ── 8. insightsService (learner-reachable) never reads the answers column ────
{
  const attemptSelects = insights.match(/\.from\("quiz_attempts"\)\s*\.select\(([^)]*)\)/g) || [];
  ok("8a insights has quiz_attempts selects to check", attemptSelects.length > 0);
  ok("8b no insights quiz_attempts select includes answers", attemptSelects.every(s => !s.includes("answers")));
  // getUserPerformance still reads own attempts directly, user-scoped.
  ok("8c getUserPerformance is user-scoped", body(insights, "export async function getUserPerformance(").includes('.eq("user_id"'));
  // Knowledge Heatmap (062): getRepTopicScores / getTopicHeatmap now delegate to
  // the canonical get_knowledge_heatmap RPC, which derives the caller's role and
  // tenant SERVER-side and returns only the caller's own scope for a learner —
  // strictly stronger than a client-side user_id filter, and it never does a raw
  // cross-user quiz_attempts read from the client.
  const repBody = body(insights, "export async function getRepTopicScores(");
  ok("8d getRepTopicScores uses the server-scoped canonical RPC", repBody.includes('rpc("get_knowledge_heatmap")'));
  ok("8e getRepTopicScores does no raw quiz_attempts read", !repBody.includes('.from("quiz_attempts")'));
  ok("8f getTopicHeatmap uses the server-scoped canonical RPC",
     body(insights, "export async function getTopicHeatmap(").includes('rpc("get_knowledge_heatmap")'));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
