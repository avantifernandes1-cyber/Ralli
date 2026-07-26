/**
 * Ralli Resolved Assignment Engine
 *
 * The single, shared definition of:
 *   - Is a specific assignment instance ACTIVE for a specific user?
 *   - Is it RESOLVED?
 *   - Is the user ELIGIBLE FOR REASSIGNMENT?
 *
 * Before this module existed, HomeScreen, LearnScreen's manager Assignments
 * tab, QuizTrackingPanel (QuizzesScreen), and RepDrillDownModal each
 * re-derived this independently in rankd-app.jsx — comparing timestamps,
 * completion records, and attempts on their own. That let the definitions
 * quietly drift: QuizTrackingPanel and RepDrillDownModal were marking a quiz
 * "Completed"/"Passed" off ANY historical passed attempt, with no check that
 * the pass happened after the CURRENT assignment was created — so a brand
 * new reassignment of a previously-passed quiz could display as already
 * done. RepDrillDownModal never resolved courses at all.
 *
 * Every consumer now calls into this module instead. It mirrors the SQL
 * engine (_quiz_assignment_active_user_ids / _lesson_assignment_active_user_ids
 * / _course_assignment_active_user_ids — migrations 036/037) field for
 * field: an event (quiz attempt / lesson completion) only resolves an
 * assignment INSTANCE if it occurred at or after that specific row's own
 * assigned_at. An older event, from before the current assignment was
 * created, never counts.
 *
 * "Active" = assigned, in_progress, or overdue (i.e. not resolved). A
 * resolved assignment — quiz passed, quiz failed, lesson completed, or
 * course completed — is eligible to be assigned again. This matches the
 * eligibility contract documented in contentService.js's ASSIGNMENTS header.
 *
 * @module assignmentEngine
 */

// ─────────────────────────────────────────────────────────────────────────────
// SHARED TIMESTAMP GATE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Does `eventAtIso` (a quiz attempt's created_at, or a lesson completion's
 * completed_at) qualify as resolving an assignment whose own timestamp is
 * `assignedAtRaw`? Mirrors the SQL engine's `completed_at/created_at >=
 * assigned_at` gate exactly.
 *
 * tenant_assignments.assigned_at is NOT NULL in the schema (see
 * 017_tenant_assignments.sql), so a missing assignedAtRaw is defensive-only
 * and should never be reachable in production. When it does happen, this
 * gate is permissive (any real event qualifies) rather than permanently
 * unresolved — matching the majority of the pre-engine implementations
 * (LearnScreen's assignments tab for all three content types, and
 * HomeScreen's lesson/course branches).
 *
 * @param {string|null|undefined} eventAtIso
 * @param {string|null|undefined} assignedAtRaw
 * @returns {boolean}
 */
export function isQualifyingEvent(eventAtIso, assignedAtRaw) {
  if (!eventAtIso) return false;
  if (!assignedAtRaw) return true; // defensive only — assigned_at is NOT NULL
  const eventMs = new Date(eventAtIso).getTime();
  const assignedMs = new Date(assignedAtRaw).getTime();
  if (Number.isNaN(eventMs) || Number.isNaN(assignedMs)) return false;
  return eventMs >= assignedMs;
}

/** Pull assigned_at off either an app-shape assignment (assignedAtRaw) or a raw DB row (assigned_at). */
function assignedAtOf(assignment) {
  return assignment?.assignedAtRaw ?? assignment?.assigned_at ?? null;
}

/** Pull due_at off either an app-shape assignment (dueAt) or a raw DB row (due_at). */
function dueAtOf(assignment) {
  return assignment?.dueAt ?? assignment?.due_at ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED DUE-DATE BOUNDARY (Assignment Experience Priority 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Days until a due date, at LOCAL-DAY granularity — the single due-date
 * comparison shared by every consumer: this module's own "overdue" override
 * below, and rankd-app.jsx's learner-facing getDueStatus() ("Due today" /
 * "Due in N days" / "Overdue" badges) and RepDrillDownModal's days-overdue
 * badge. Both sides of the comparison are normalized to local midnight, so
 * "today" is never overdue and a due date boundary reads identically
 * regardless of what time of day or which timezone it's evaluated in.
 *
 * Previously this engine compared raw timestamps directly
 * (`new Date(dueAt) < new Date()`), which — because a date-only due_at like
 * "2026-07-21" parses as UTC midnight — could mark an assignment "Overdue"
 * several hours before its due day had even started in the viewer's local
 * time, while getDueStatus()'s own local-midnight math still correctly
 * showed "Due today" for the identical assignment. A manager on the
 * Leadership Dashboard or Rep Drill-down could see "Overdue" for the exact
 * assignment a rep's Home screen showed as "Due today." This function is now
 * the one place that logic lives.
 *
 * @param {string|null|undefined} dueAtStr - "YYYY-MM-DD" or ISO date string; "Open" or falsy means no due date (never overdue, returns null)
 * @param {Date} [now] - injectable for tests; defaults to current local time
 * @returns {number|null} negative = overdue by that many days, 0 = due today, positive = days remaining, null = no due date
 */
export function daysUntilDue(dueAtStr, now = new Date()) {
  if (!dueAtStr || dueAtStr === "Open") return null;
  const due = new Date(dueAtStr);
  if (isNaN(due.getTime())) return null;
  const n = new Date(now); n.setHours(0, 0, 0, 0);
  const d = new Date(due); d.setHours(0, 0, 0, 0);
  return Math.round((d.getTime() - n.getTime()) / 86400000);
}

/** Is this due date in the past (local-day granularity)? Due-today is never overdue. */
function isPastDueDate(dueAtStr, now = new Date()) {
  const diff = daysUntilDue(dueAtStr, now);
  return diff != null && diff < 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// PER-CONTENT-TYPE RESOLUTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a QUIZ assignment instance for one user.
 * A qualifying attempt (pass OR fail — matching create_assignments_atomic's
 * "any attempt resolves it" rule) makes the assignment RESOLVED (eligible
 * for reassignment). It only reads "completed" for display once a
 * qualifying attempt has actually PASSED.
 *
 * @param {{assignedAtRaw?: string, assigned_at?: string}} assignment
 * @param {Array<{created_at: string, passed: boolean}>} attempts - this user's attempts on this quiz (any order)
 * @returns {{ isResolved: boolean, status: 'not_started'|'in_progress'|'completed', progress: number, completedAt: string|null }}
 */
export function resolveQuizAssignment(assignment, attempts = []) {
  const assignedAtRaw = assignedAtOf(assignment);
  const qualifying = attempts.filter(at => isQualifyingEvent(at.created_at, assignedAtRaw));
  const qualifyingPasses = qualifying.filter(at => at.passed);

  const isResolved = qualifying.length > 0;
  const isPassed = qualifyingPasses.length > 0;

  const status = isPassed ? "completed" : qualifying.length > 0 ? "in_progress" : "not_started";
  const completedAt = isPassed
    ? qualifyingPasses.map(at => at.created_at).sort()[0] // earliest qualifying pass
    : null;

  // Quiz progress is binary (0 or 100) by convention across every consumer —
  // there's no partial-credit display for a quiz mid-attempt.
  return { isResolved, status, progress: isPassed ? 100 : 0, completedAt };
}

/**
 * Resolve a LESSON assignment instance for one user.
 *
 * @param {{assignedAtRaw?: string, assigned_at?: string}} assignment
 * @param {string|null|undefined} completedAt - this user's completed_at for this lesson, if any
 * @returns {{ isResolved: boolean, status: 'not_started'|'completed', progress: number, completedAt: string|null }}
 */
export function resolveLessonAssignment(assignment, completedAt) {
  const assignedAtRaw = assignedAtOf(assignment);
  const isResolved = isQualifyingEvent(completedAt, assignedAtRaw);
  return {
    isResolved,
    status: isResolved ? "completed" : "not_started",
    progress: isResolved ? 100 : 0,
    completedAt: isResolved ? completedAt : null,
  };
}

/**
 * Resolve a COURSE assignment instance for one user. Resolved only once
 * EVERY lesson in the course has a qualifying completion.
 *
 * @param {{assignedAtRaw?: string, assigned_at?: string}} assignment
 * @param {string[]} lessonIds - all lesson ids in the course
 * @param {Map<string,string>} completedAtByLesson - lessonId -> completedAt for this user
 * @returns {{ isResolved: boolean, status: 'not_started'|'in_progress'|'completed', progress: number, completedAt: string|null }}
 */
export function resolveCourseAssignment(assignment, lessonIds = [], completedAtByLesson = new Map()) {
  const assignedAtRaw = assignedAtOf(assignment);
  const doneLessonIds = lessonIds.filter(id => isQualifyingEvent(completedAtByLesson.get(id), assignedAtRaw));
  const progress = lessonIds.length ? Math.round((doneLessonIds.length / lessonIds.length) * 100) : 0;
  const isResolved = lessonIds.length > 0 && doneLessonIds.length >= lessonIds.length;

  let completedAt = null;
  if (isResolved) {
    const dates = doneLessonIds.map(id => completedAtByLesson.get(id)).filter(Boolean).sort();
    completedAt = dates[dates.length - 1] ?? null;
  }

  return {
    isResolved,
    status: isResolved ? "completed" : progress > 0 ? "in_progress" : "not_started",
    progress,
    completedAt,
  };
}

/**
 * Unified entry point — dispatches to the right resolver by content type and
 * applies the "overdue" override shared by every manager-facing status
 * table: a not-yet-completed assignment past its due date reads as overdue
 * regardless of not_started/in_progress. Never overrides "completed".
 *
 * `data` shape depends on contentType:
 *   quiz:   { attempts: Array<{created_at, passed}> }
 *   lesson: { completedAt: string|null }
 *   course: { lessonIds: string[], completedAtByLesson: Map<string,string> }
 *
 * @param {'quiz'|'lesson'|'course'} contentType
 * @param {Object} assignment
 * @param {Object} data
 * @returns {{ isResolved: boolean, isActive: boolean, status: 'not_started'|'in_progress'|'completed'|'overdue', progress: number, completedAt: string|null }}
 */
export function resolveAssignmentStatus(contentType, assignment, data = {}) {
  // Cancelled assignments (063: content archived/removed) are history only —
  // never active/overdue/pending, never resolved-for-reassignment. The data
  // source already excludes them from active views; this is a defensive guard
  // for any caller that passes a cancelled row (e.g. the manager historical view).
  if (assignment?.cancelledAt) {
    return { isResolved: false, isActive: false, status: "cancelled", progress: 0, completedAt: null };
  }
  let result;
  if (contentType === "quiz") {
    result = resolveQuizAssignment(assignment, data.attempts ?? []);
  } else if (contentType === "lesson") {
    result = resolveLessonAssignment(assignment, data.completedAt ?? null);
  } else if (contentType === "course") {
    result = resolveCourseAssignment(assignment, data.lessonIds ?? [], data.completedAtByLesson ?? new Map());
  } else {
    result = { isResolved: false, status: "not_started", progress: 0, completedAt: null };
  }

  let status = result.status;
  const dueAt = dueAtOf(assignment);
  if (status !== "completed" && isPastDueDate(dueAt)) {
    status = "overdue";
  }

  return { ...result, status, isActive: !result.isResolved };
}

/**
 * Is this user eligible to be assigned this content again? Identical to
 * isResolved — a named alias kept for readability at reassignment-eligibility
 * call sites.
 *
 * @param {'quiz'|'lesson'|'course'} contentType
 * @param {Object} assignment
 * @param {Object} data
 * @returns {boolean}
 */
export function isEligibleForReassignment(contentType, assignment, data = {}) {
  return resolveAssignmentStatus(contentType, assignment, data).isResolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// LATEST-ASSIGNMENT DEDUPE (one actionable quiz per user + quiz)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given every quiz assignment row that targets ONE user for ONE quiz (an
 * original plus any reassignments), plus that user's attempts on that quiz,
 * collapse them to the single LATEST applicable assignment and resolve it.
 *
 * Why: a resolved-by-failure or previously-passed assignment stays in
 * tenant_assignments as history, and a manager may reassign after resolution.
 * Surfacing every row independently double-counts one quiz (Home over-counts;
 * a stale lifetime pass makes To Do hide a new reassignment). This is the one
 * shared reduction so Home, Quizzes → To Do, and the manager table agree.
 *
 * It does NOT re-implement resolution — status/progress/completedAt come from
 * resolveAssignmentStatus(), and the attempt gate is the same isQualifyingEvent()
 * every other consumer uses. History is preserved: the older rows come back in
 * `older`, and the caller keeps the full attempt list for drill-down.
 *
 * Deterministic selection: newest `assigned_at`, tie-broken by descending id,
 * so the same set always collapses to the same row.
 *
 * Metrics are scoped to the latest assignment's window (attempts at/after its
 * assigned_at) — a "Not Started" reassignment never shows a prior instance's
 * score/attempts as if they belonged to it.
 *
 * @param {Array<Object>} assignments - quiz assignment rows (app or raw shape) for ONE user + quiz
 * @param {Array<{created_at: string, passed: boolean, score?: number}>} attempts - that user's attempts on that quiz
 * @returns {{
 *   latest: Object|null, older: Array<Object>,
 *   status: 'not_started'|'in_progress'|'completed'|'overdue', isActive: boolean, isResolved: boolean,
 *   progress: number, completedAt: string|null,
 *   scopedAttempts: Array<Object>, attemptCount: number, latestScore: number|null, bestScore: number|null
 * }}
 */
export function resolveLatestQuizAssignment(assignments = [], attempts = []) {
  if (!assignments || assignments.length === 0) {
    return {
      latest: null, older: [],
      status: "not_started", isActive: false, isResolved: false,
      progress: 0, completedAt: null,
      scopedAttempts: [], attemptCount: 0, latestScore: null, bestScore: null,
    };
  }

  const sorted = [...assignments].sort((a, b) => {
    const ta = new Date(assignedAtOf(a) ?? 0).getTime();
    const tb = new Date(assignedAtOf(b) ?? 0).getTime();
    if (tb !== ta) return tb - ta;                       // newest assigned_at first
    return String(b?.id ?? "").localeCompare(String(a?.id ?? "")); // deterministic id tie-break
  });
  const latest = sorted[0];
  const older  = sorted.slice(1);

  const resolved = resolveAssignmentStatus("quiz", latest, { attempts });

  const assignedAtRaw  = assignedAtOf(latest);
  const scopedAttempts = (attempts ?? [])
    .filter(at => isQualifyingEvent(at.created_at, assignedAtRaw))
    .slice()
    .sort((x, y) => new Date(y.created_at).getTime() - new Date(x.created_at).getTime()); // newest first
  const attemptCount = scopedAttempts.length;
  const latestScore  = scopedAttempts[0]?.score ?? null;
  const bestScore    = scopedAttempts.length ? Math.max(...scopedAttempts.map(at => at.score ?? 0)) : null;

  return {
    latest, older,
    status: resolved.status, isActive: resolved.isActive, isResolved: resolved.isResolved,
    progress: resolved.progress, completedAt: resolved.completedAt,
    scopedAttempts, attemptCount, latestScore, bestScore,
  };
}

/**
 * THE canonical learner "current work" selector — the single source of truth
 * shared by Home (Assigned Learning) and Learner Learn (Assigned/All, To Do,
 * Completed). Collapses every content type to ONE current card per
 * (contentType, contentId): the LATEST assignment instance, resolved to its
 * status by the same engine used everywhere else. Cancelled instances are
 * excluded (they are history, not current work). Missing/deleted content is
 * kept but flagged `missing` so the UI can render a non-clickable honest card
 * rather than dropping it silently or linking to nothing.
 *
 * Guarantees the caller can rely on:
 *   - one entry per content (no duplicate current cards, no historical dupes)
 *   - status ∈ not_started | in_progress | completed | overdue
 *   - `isCompleted` splits the set into exactly Completed vs To Do, so
 *     All === To Do ∪ Completed, To Do === not_started + in_progress + overdue.
 *
 * @param {Array<Object>} assignments  this learner's assignment rows (all instances)
 * @param {Object} ctx { completedAtByLesson:Map, quizAttempts:[], courses:[], lessons:[], quizzes:[] }
 * @returns {Array<{ contentType, contentId, assignment, content, missing, status, progress, completedAt, isCompleted, isToDo, isOverdue }>}
 */
export function resolveLearnerAssignments(assignments = [], ctx = {}) {
  const { completedAtByLesson = new Map(), quizAttempts = [], courses = [], lessons = [], quizzes = [] } = ctx;
  const courseById = new Map(courses.map(c => [c.id, c]));
  const lessonById = new Map(lessons.map(l => [l.id, l]));
  const quizById   = new Map(quizzes.map(q => [q.id, q]));

  const groups = new Map(); // contentType:contentId -> instances[]
  for (const a of (assignments ?? [])) {
    if (a?.cancelledAt) continue; // current work excludes cancelled/unassigned
    const key = `${a.contentType}:${a.contentId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }

  const out = [];
  for (const instances of groups.values()) {
    const contentType = instances[0].contentType;
    const contentId   = instances[0].contentId;
    let latest, status, progress, completedAt;

    if (contentType === "quiz") {
      const r = resolveLatestQuizAssignment(instances, (quizAttempts ?? []).filter(at => at.quiz_id === contentId));
      latest = r.latest; status = r.status; progress = r.progress; completedAt = r.completedAt;
    } else {
      latest = instances.reduce((m, a) =>
        (new Date(assignedAtOf(a) ?? 0).getTime() >= new Date(assignedAtOf(m) ?? 0).getTime() ? a : m), instances[0]);
      if (contentType === "course") {
        const course   = courseById.get(contentId);
        const eligible = (course?.lessonIds ?? []).filter(id => lessonById.has(id)); // archived/missing members excluded from the denominator
        const r = resolveAssignmentStatus("course", latest, { lessonIds: eligible, completedAtByLesson });
        status = r.status; progress = r.progress; completedAt = r.completedAt;
      } else {
        const r = resolveAssignmentStatus("lesson", latest, { completedAt: completedAtByLesson.get(contentId) ?? null });
        status = r.status; progress = r.progress; completedAt = r.completedAt;
      }
    }

    const content = contentType === "course" ? courseById.get(contentId)
                  : contentType === "quiz"   ? quizById.get(contentId)
                  : lessonById.get(contentId);
    const isCompleted = status === "completed";
    out.push({
      contentType, contentId, assignment: latest, content: content ?? null, missing: !content,
      status, progress, completedAt,
      isCompleted, isToDo: !isCompleted, isOverdue: status === "overdue",
    });
  }
  return out;
}
