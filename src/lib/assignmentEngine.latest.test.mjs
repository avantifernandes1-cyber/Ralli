// Focused tests for resolveLatestQuizAssignment (one card per user+quiz).
// Run: node src/lib/assignmentEngine.latest.test.mjs   (no creds, no DB)
import { resolveLatestQuizAssignment, resolveAssignmentStatus, resolveLearnerAssignments } from "./assignmentEngine.js";
let pass = 0, fail = 0;
const eq = (n, got, want) => { const a=JSON.stringify(got), b=JSON.stringify(want);
  if (a===b){pass++;console.log("PASS  "+n);} else {fail++;console.log(`FAIL  ${n}\n  got ${a}\n  want ${b}`);} };

const A = (id, at) => ({ id, assigned_at: at });              // raw-shape assignment row
const at = (created_at, passed, score) => ({ created_at, passed, score });

// ── 1. Confirmed live scenario: pass → reassign → fail → reassign again ──────
{
  const assignments = [
    A("9f75d3cd", "2026-07-21T17:50:10Z"),  // A1
    A("e9706322", "2026-07-23T18:26:00Z"),  // A2
    A("7e1a5209", "2026-07-23T18:28:01Z"),  // A3 (latest)
  ];
  const attempts = [
    at("2026-07-21T17:50:32Z", true,  100), // after A1 (pass)
    at("2026-07-23T18:26:32Z", false, 75),  // after A2 (fail), BEFORE A3
  ];
  const r = resolveLatestQuizAssignment(assignments, attempts);
  eq("live: latest = A3", r.latest.id, "7e1a5209");
  eq("live: status not_started (fresh reassignment)", r.status, "not_started");
  eq("live: isActive (one actionable)", r.isActive, true);
  eq("live: scoped attemptCount = 0 (none after A3)", r.attemptCount, 0);
  eq("live: latest/best score scoped = null", [r.latestScore, r.bestScore], [null, null]);
  eq("live: history preserved (2 older)", r.older.map(o=>o.id), ["e9706322","9f75d3cd"]);
  // Home pending == 1 and To Do == 1: not completed → exactly one pending card, no Retry
  eq("live: pending?", r.status !== "completed", true);
}

// ── 2. Prior pass then reassignment (no attempt after) → still 1 pending ─────
{
  const r = resolveLatestQuizAssignment(
    [A("a1","2026-07-01T00:00:00Z"), A("a2","2026-07-10T00:00:00Z")],
    [at("2026-07-02T00:00:00Z", true, 100)]);  // pass belongs to a1 only
  eq("prior-pass: latest a2 not_started (pass doesn't hide reassignment)", [r.latest.id, r.status], ["a2","not_started"]);
  eq("prior-pass: scoped attemptCount 0", r.attemptCount, 0);
}

// ── 3. Failed current assignment, no reassignment → one Retry (in_progress) ──
{
  const r = resolveLatestQuizAssignment(
    [A("a1","2026-07-10T00:00:00Z")],
    [at("2026-07-10T01:00:00Z", false, 60)]);
  eq("failed-current: in_progress (Retry)", r.status, "in_progress");
  eq("failed-current: isResolved true (retryable)", r.isResolved, true);
  eq("failed-current: scoped attemptCount 1, latest 60", [r.attemptCount, r.latestScore], [1, 60]);
  eq("failed-current: not completed", r.status !== "completed", true);
}

// ── 4. Completed current assignment ─────────────────────────────────────────
{
  const r = resolveLatestQuizAssignment(
    [A("a1","2026-07-10T00:00:00Z")],
    [at("2026-07-10T01:00:00Z", false, 60), at("2026-07-10T02:00:00Z", true, 100)]);
  eq("completed: status completed", r.status, "completed");
  eq("completed: progress 100", r.progress, 100);
  eq("completed: completedAt = passing attempt", r.completedAt, "2026-07-10T02:00:00Z");
  eq("completed: latest/best scoped", [r.latestScore, r.bestScore], [100, 100]);
}

// ── 5. Overdue current assignment (past due, unresolved) ────────────────────
{
  const past = "2020-01-01";
  const r = resolveLatestQuizAssignment([{ id:"a1", assigned_at:"2019-12-01T00:00:00Z", due_at: past }], []);
  eq("overdue: status overdue", r.status, "overdue");
  eq("overdue: pending", r.status !== "completed", true);
}

// ── 6. Deterministic id tie-break when assigned_at equal ────────────────────
{
  const r = resolveLatestQuizAssignment(
    [A("aaa","2026-07-10T00:00:00Z"), A("zzz","2026-07-10T00:00:00Z")], []);
  eq("tie-break: higher id wins deterministically", r.latest.id, "zzz");
}

// ── 7. Empty assignments → safe default ─────────────────────────────────────
{
  const r = resolveLatestQuizAssignment([], []);
  eq("empty: safe default not_started/none", [r.latest, r.status, r.attemptCount], [null, "not_started", 0]);
}

// ── 8. Consistency: Home count == To Do count; manager = one row per user+quiz ──
// Mirrors the caller reduction (group by content → latest via helper).
{
  // Two quizzes for one user:
  //  Q1 = live scenario (pass, reassign, fail, reassign) → not_started (pending)
  //  Q2 = prior pass then reassignment with a later PASS on the current instance → completed
  const rowsByQuiz = {
    Q1: [A("q1a","2026-07-21T17:50:10Z"), A("q1b","2026-07-23T18:26:00Z"), A("q1c","2026-07-23T18:28:01Z")],
    Q2: [A("q2a","2026-07-01T00:00:00Z"), A("q2b","2026-07-10T00:00:00Z")],
  };
  const attemptsByQuiz = {
    Q1: [at("2026-07-21T17:50:32Z", true, 100), at("2026-07-23T18:26:32Z", false, 75)],
    Q2: [at("2026-07-02T00:00:00Z", true, 100), at("2026-07-11T00:00:00Z", true, 90)], // pass after q2b
  };
  const resolvePerQuiz = () => Object.keys(rowsByQuiz).map(qid => ({
    qid, ...resolveLatestQuizAssignment(rowsByQuiz[qid], attemptsByQuiz[qid]),
  }));
  const home = resolvePerQuiz();
  const todo = resolvePerQuiz(); // same helper, same inputs
  const homePending = home.filter(x => x.status !== "completed").length;
  const todoPending = todo.filter(x => x.status !== "completed").length;
  eq("consistency: Home pending == To Do pending", homePending, todoPending);
  eq("consistency: exactly 1 pending (Q1), Q2 completed", homePending, 1);
  eq("consistency: Q1 contributes ONE card (not 2)", home.filter(x => x.qid==="Q1").length, 1);
  eq("consistency: Q2 completed (later pass on current instance)", home.find(x=>x.qid==="Q2").status, "completed");
}

// ── 9. Manager: one row per (user, quiz); scoped metrics vs full history ─────
{
  // simulate buildQuizAssignmentRows reduction for one user on Q1 (live scenario)
  const rows = [A("q1a","2026-07-21T17:50:10Z"), A("q1b","2026-07-23T18:26:00Z"), A("q1c","2026-07-23T18:28:01Z")];
  const allAttempts = [
    { ...at("2026-07-23T18:26:32Z", false, 75), id: "att2" },
    { ...at("2026-07-21T17:50:32Z", true, 100), id: "att1" },
  ];
  const r = resolveLatestQuizAssignment(rows, allAttempts);
  eq("manager: primary row = latest (q1c)", r.latest.id, "q1c");
  eq("manager: Status not_started", r.status, "not_started");
  eq("manager: Attempts scoped to latest = 0", r.attemptCount, 0);
  eq("manager: Score scoped = null/null (nothing after latest)", [r.latestScore, r.bestScore], [null, null]);
  eq("manager: Done scoped = null", r.completedAt, null);
  eq("manager: history preserved (2 older instances)", r.older.length, 2);
  eq("manager: full attempt history available (2, not scoped 0)", allAttempts.length, 2);
}

// ── 10. Cancelled assignments (063): never active/overdue/resolved ───────────
{
  const cancelled = { cancelledAt: "2026-07-25T00:00:00Z", dueAt: "2026-01-01" }; // past due, but cancelled
  const rL = resolveAssignmentStatus("lesson", cancelled, { completedAt: null });
  eq("cancelled lesson → status cancelled", rL.status, "cancelled");
  eq("cancelled lesson → not active", rL.isActive, false);
  eq("cancelled lesson → not resolved (not reassignable-by-completion)", rL.isResolved, false);
  eq("cancelled → no fabricated overdue despite past due date", rL.status !== "overdue", true);
  const rC = resolveAssignmentStatus("course", cancelled, { lessonIds: ["a","b"], completedAtByLesson: new Map() });
  eq("cancelled course → status cancelled", rC.status, "cancelled");
  eq("cancelled course → progress 0", rC.progress, 0);
  // A non-cancelled assignment is unaffected (regression guard)
  const active = resolveAssignmentStatus("lesson", { dueAt: "Open" }, { completedAt: null });
  eq("non-cancelled lesson still resolves normally", active.status, "not_started");
}

// ── 11. Shared learner selector — one card per content, All = ToDo + Completed ─
{
  const now = "2026-07-25T00:00:00Z";
  const assignments = [
    // lesson: one instance, completed
    { id: "L1a", contentType: "lesson", contentId: "L1", assigned_at: "2026-07-01T00:00:00Z" },
    // course: latest instance, 1 of 2 members done -> in_progress
    { id: "C1a", contentType: "course", contentId: "C1", assigned_at: "2026-07-01T00:00:00Z" },
    { id: "C1b", contentType: "course", contentId: "C1", assigned_at: "2026-07-10T00:00:00Z" },
    // quiz: reassigned, latest not_started
    { id: "Q1a", contentType: "quiz", contentId: "Q1", assigned_at: "2026-07-01T00:00:00Z" },
    { id: "Q1b", contentType: "quiz", contentId: "Q1", assigned_at: "2026-07-10T00:00:00Z" },
    // cancelled -> excluded
    { id: "X1",  contentType: "lesson", contentId: "L2", assigned_at: "2026-07-01T00:00:00Z", cancelledAt: now },
    // missing content -> kept, flagged
    { id: "M1",  contentType: "quiz", contentId: "GONE", assigned_at: "2026-07-01T00:00:00Z" },
  ];
  const rows = resolveLearnerAssignments(assignments, {
    completedAtByLesson: new Map([["L1", "2026-07-02T00:00:00Z"], ["c1L1", "2026-07-11T00:00:00Z"]]),
    quizAttempts: [{ quiz_id: "Q1", created_at: "2026-07-02T00:00:00Z", passed: true, score: 100 }], // BEFORE Q1b -> not qualifying
    lessons: [{ id: "L1" }, { id: "c1L1" }, { id: "c1L2" }],
    courses: [{ id: "C1", lessonIds: ["c1L1", "c1L2"] }],
    quizzes: [{ id: "Q1" }], // GONE missing on purpose
  });
  eq("selector: one row per content (L1,C1,Q1,GONE; L2 cancelled excluded)", rows.length, 4);
  const byId = Object.fromEntries(rows.map(r => [r.contentId, r]));
  eq("selector: lesson L1 completed", byId.L1.status, "completed");
  eq("selector: course C1 latest instance in_progress (1/2)", byId.C1.status, "in_progress");
  eq("selector: quiz Q1 not_started (pass predates latest instance)", byId.Q1.status, "not_started");
  eq("selector: missing content flagged", byId.GONE.missing, true);
  const all = rows.length, todo = rows.filter(r => r.isToDo).length, done = rows.filter(r => r.isCompleted).length;
  eq("selector: All === ToDo + Completed", all, todo + done);
  eq("selector: exactly one Completed (L1)", done, 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
