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
  if (status !== "completed" && dueAt && dueAt !== "Open") {
    const d = new Date(dueAt);
    if (!isNaN(d) && d < new Date()) status = "overdue";
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
