/**
 * Ralli Content Service
 *
 * CRUD for tenant-scoped courses, lessons, quizzes, and lesson completions.
 * All functions return { data, error } — callers decide how to handle errors.
 *
 * Shape contracts:
 *   Lesson  → { id, title, description, type, duration, xp, status, videoUrl, notes }
 *   Course  → { id, title, description, lessonIds, emoji, color, status }
 *   Quiz    → { id, name, questions, status, is_favorite/favorite, tags, createdAt }
 *
 * DB ↔ App normalisation is handled here so callers receive consistent shapes.
 *
 * @module contentService
 */

import { supabase } from "./supabase.js";
import { isQualifyingEvent } from "./assignmentEngine.js";

// ─────────────────────────────────────────────────────────────────────────────
// LESSONS
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a DB row → app lesson shape */
function dbToLesson(row) {
  return {
    id:          row.id,
    title:       row.title,
    description: row.description ?? "",
    type:        row.type ?? "text",
    duration:    row.duration ?? "",
    xp:          row.xp ?? 100,
    status:      row.status ?? "active",
    content:     row.content ?? {},           // full JSONB — body, imageUrl, front/back, question, etc.
    videoUrl:    row.content?.videoUrl ?? "", // kept for backward compat
    notes:       row.content?.notes    ?? "", // kept for backward compat
    createdAt:   row.created_at,
    updatedAt:   row.updated_at ?? null,      // authoritative "Last Updated" (surfaced in the UI)
  };
}

/** Normalise an app lesson → DB insert/update payload */
function lessonToDb(lesson, tenantId, userId) {
  return {
    tenant_id:   tenantId,
    title:       lesson.title,
    description: lesson.description ?? null,
    type:        lesson.type ?? "text",
    duration:    lesson.duration ?? null,
    xp:          lesson.xp ?? 100,
    status:      lesson.status ?? "active",
    content:     lesson.content ?? {},        // store the full content object as authored
    created_by:  userId ?? null,
    updated_at:  new Date().toISOString(),
  };
}

/**
 * Fetch all lessons for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getTenantLessons(tenantId) {
  const { data, error } = await supabase
    .from("tenant_lessons")
    .select("*")
    .eq("tenant_id", tenantId)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  return { data: data ? data.map(dbToLesson) : null, error };
}

/**
 * Upsert a lesson (insert if no id, update if id present).
 * Returns the saved lesson in app shape.
 * @param {string} tenantId
 * @param {Object} lesson
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function upsertLesson(tenantId, lesson, userId) {
  const payload = lessonToDb(lesson, tenantId, userId);

  if (lesson.id && !lesson.id.startsWith("ll")) {
    // Existing DB row — update
    const { data, error } = await supabase
      .from("tenant_lessons")
      .update(payload)
      .eq("id", lesson.id)
      .select()
      .single();
    return { data: data ? dbToLesson(data) : null, error };
  } else {
    // New lesson — insert
    const { data, error } = await supabase
      .from("tenant_lessons")
      .insert(payload)
      .select()
      .single();
    return { data: data ? dbToLesson(data) : null, error };
  }
}

/**
 * Delete a lesson by id.
 * @param {string} lessonId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteLesson(lessonId) {
  // Hard delete goes through delete_lesson() (063), which BLOCKS deletion when
  // the lesson still has assignments, completions, or course references — so a
  // reference is never silently orphaned. Managers should archive instead.
  const { data, error } = await supabase.rpc("delete_lesson", { p_lesson_id: lessonId });
  return { data, error };
}


// ─────────────────────────────────────────────────────────────────────────────
// COURSES
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a DB row → app course shape */
function dbToCourse(row) {
  return {
    id:             row.id,
    title:          row.title,
    description:    row.description ?? "",
    lessonIds:      row.lesson_ids ?? [],
    lessonSchedule: row.lesson_schedule ?? {}, // { [lessonId]: { available_after_days: number } }
    emoji:          row.emoji ?? "📚",
    color:          row.color ?? "#FF6B35",
    status:         row.status ?? "active",
    createdAt:      row.created_at,
    updatedAt:      row.updated_at ?? null,    // authoritative "Last Updated" (surfaced in the UI)
  };
}

/** Normalise an app course → DB payload */
function courseToDb(course, tenantId, userId) {
  return {
    tenant_id:       tenantId,
    title:           course.title,
    description:     course.description ?? null,
    lesson_ids:      course.lessonIds ?? [],
    lesson_schedule: course.lessonSchedule ?? {},
    emoji:           course.emoji ?? null,
    color:           course.color ?? null,
    status:          course.status ?? "active",
    created_by:      userId ?? null,
    updated_at:      new Date().toISOString(),
  };
}

/**
 * Fetch all courses for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getTenantCourses(tenantId) {
  const { data, error } = await supabase
    .from("tenant_courses")
    .select("*")
    .eq("tenant_id", tenantId)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  return { data: data ? data.map(dbToCourse) : null, error };
}

/**
 * Upsert a course.
 * @param {string} tenantId
 * @param {Object} course
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function upsertCourse(tenantId, course, userId) {
  const payload = courseToDb(course, tenantId, userId);

  if (course.id && !course.id.startsWith("lc")) {
    const { data, error } = await supabase
      .from("tenant_courses")
      .update(payload)
      .eq("id", course.id)
      .select()
      .single();
    return { data: data ? dbToCourse(data) : null, error };
  } else {
    const { data, error } = await supabase
      .from("tenant_courses")
      .insert(payload)
      .select()
      .single();
    return { data: data ? dbToCourse(data) : null, error };
  }
}

/**
 * Delete a course by id.
 * @param {string} courseId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteCourse(courseId) {
  // Hard delete goes through delete_course() (063), which BLOCKS deletion when
  // the course still has assignments — references are never silently orphaned.
  const { data, error } = await supabase.rpc("delete_course", { p_course_id: courseId });
  return { data, error };
}


// ─────────────────────────────────────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Coerce one answer option to a plain string.
 * Handles: string, null/undefined (→ ""), object with any of the known
 * text-carrier keys (text, label, answer, option, value), anything else (String()).
 * Uses || not ?? so empty-string values fall through to the next candidate.
 */
function normalizeOption(opt) {
  if (typeof opt === "string") return opt.trim();
  if (opt === null || opt === undefined) return "";
  if (typeof opt === "object") {
    return String(
      opt.text || opt.label || opt.answer || opt.option || opt.value || ""
    ).trim();
  }
  return String(opt).trim();
}

/**
 * Normalise one question to the canonical shape.
 * • text / q  → both set to the same non-empty string (uses || so "" falls through)
 * • options   → selected from the first non-empty source across options / answers /
 *               choices, then every element coerced to a plain string.
 *
 * Critically: Array.isArray([]) === true, so an empty options array must NOT be
 * preferred over a populated answers/choices array.  We use length > 0 to guard.
 * Scoring (correct index) is preserved unchanged.
 */
function normalizeQuestion(q) {
  const canonical = q.text || q.q || "";
  const result = { ...q, q: canonical, text: canonical };

  // Pick the first source that is actually a non-empty array.
  const rawOptions =
    (Array.isArray(q.options)  && q.options.length  > 0 && q.options)  ||
    (Array.isArray(q.answers)  && q.answers.length  > 0 && q.answers)  ||
    (Array.isArray(q.choices)  && q.choices.length  > 0 && q.choices)  ||
    [];

  result.options = rawOptions.map(normalizeOption);
  return result;
}

/** Normalise a DB row → app quiz shape.
 *  Uses || not ?? because ?? does not fall through on "" (empty string).
 *  A prior normalisation pass may have written text:"" to the DB; || handles that correctly. */
function dbToQuiz(row) {
  return {
    id:         row.id,
    name:       row.name,
    questions:  (row.questions ?? []).map(normalizeQuestion),
    status:     row.status ?? "active",
    favorite:   row.is_favorite ?? false,
    tags:       row.tags ?? [],
    // passing_score is nullable — quizzes created before migration 043 have
    // no value here and correctly fall back to the global default (90) at
    // grading time (see scoringService.SCORING.quiz.passingScore /
    // rankd-app.jsx's `quiz.passingScore ?? 90`). Do NOT default it here —
    // that would silently change existing quizzes' effective passing score.
    passingScore: typeof row.passing_score === "number" ? row.passing_score : null,
    // Server-computed, questions-only revision hash (migration 054). The quiz-
    // taking flow submits the revision it loaded so the server can reject a
    // submission graded against questions that changed mid-attempt.
    questionRevision: row.question_revision ?? null,
    createdAt:  row.created_at ? new Date(row.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—",
  };
}

/** Normalise an app quiz → DB payload.
 *  Writes both `q` and `text` to the canonical text value so the DB is
 *  always consistent regardless of which field the builder or seed data wrote.
 *  Also coerces all options to plain strings so the DB never stores
 *  null/object elements that would render as blank buttons. */
function quizToDb(quiz, tenantId, userId) {
  return {
    tenant_id:   tenantId,
    name:        quiz.name,
    questions:   (quiz.questions ?? []).map(normalizeQuestion),
    status:      quiz.status ?? "active",
    is_favorite: quiz.favorite ?? quiz.is_favorite ?? false,
    tags:        quiz.tags ?? [],
    // Only write passing_score when the builder explicitly set one (new
    // quizzes default to 100 in QuizBuilderScreen — see rankd-app.jsx).
    // Editing an existing quiz that has no passingScore keeps writing null
    // rather than inventing a value, so we never silently change a legacy
    // quiz's effective passing score (which stays on the 90 fallback).
    passing_score: typeof quiz.passingScore === "number" ? quiz.passingScore : null,
    created_by:  userId ?? null,
    updated_at:  new Date().toISOString(),
  };
}

/**
 * Fetch all quizzes for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getTenantQuizzes(tenantId) {
  const { data, error } = await supabase
    .from("tenant_quizzes")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  return { data: data ? data.map(dbToQuiz) : null, error };
}

/**
 * Fetch a single quiz by id — used by post-game analytics to resolve the
 * canonical question set (text, type, correct answer/options/pairs/
 * tolerance) for a completed Ralli Live session via game_sessions.quiz_id.
 * Returns { data: null } (not an error) if the quiz was deleted since the
 * session was played — callers should treat that as "answer detail
 * unavailable" rather than a hard failure.
 * @param {string} quizId
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function getQuizById(quizId) {
  if (!quizId) return { data: null, error: null };
  const { data, error } = await supabase
    .from("tenant_quizzes")
    .select("*")
    .eq("id", quizId)
    .maybeSingle();
  return { data: data ? dbToQuiz(data) : null, error };
}

/**
 * Upsert a quiz. Detects new vs existing by whether id looks like a legacy string.
 * @param {string} tenantId
 * @param {Object} quiz
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function upsertQuiz(tenantId, quiz, userId) {
  const payload = quizToDb(quiz, tenantId, userId);
  // Only treat as existing DB row if id is a real UUID returned from a prior insert.
  // Date.now() timestamps, "quiz_*", "sq_*", and any other non-UUID strings → INSERT.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isLegacyId = !quiz.id || !UUID_RE.test(quiz.id);

  if (!isLegacyId && quiz.id) {
    // UUID — update existing
    const { data, error } = await supabase
      .from("tenant_quizzes")
      .update(payload)
      .eq("id", quiz.id)
      .select()
      .single();
    return { data: data ? dbToQuiz(data) : null, error };
  } else {
    // New record — insert and return with DB-assigned UUID
    const { data, error } = await supabase
      .from("tenant_quizzes")
      .insert(payload)
      .select()
      .single();
    return { data: data ? dbToQuiz(data) : null, error };
  }
}

/**
 * Delete a quiz by id.
 * @param {string} quizId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteQuiz(quizId) {
  const { error } = await supabase
    .from("tenant_quizzes")
    .delete()
    .eq("id", quizId);
  return { error };
}


// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENTS — unified engine
//
// Every assignment row is user-level: assigned_to is always
// { type: 'individual', userId, userName }. Team/group targets fan out to one
// row per eligible member at creation time. `source_type`/`source_id`/
// `source_label` preserve where the assignment came from (an individual pick,
// a team, an org-wide group, or a future automation) so reporting, auditing,
// and bulk management stay possible without re-deriving it from assigned_to.
//
// Legacy rows created before this engine existed may still have
// assigned_to.type === 'team' | 'group' (one row covering a whole team/org).
// Those are left untouched and keep rendering via the dynamic
// membership-expansion path already in rankd-app.jsx (resolveAssignedUsers).
// Only new writes go through createAssignments() below.
//
// "Active" = assigned, in_progress, or overdue (i.e. not resolved). A user
// whose assignment for this content is resolved — quiz passed, quiz failed,
// lesson completed, or course completed — is eligible to be assigned again;
// a user with an ACTIVE one is not. Assignment age never matters, and there's
// no separate "cancelled/expired" assignment state in this schema today.
// Enforced here at the application layer (see 026_assignments_update_rls.sql's
// note) because resolution is derived from quiz_attempts / lesson_completions,
// which Postgres can't reference from a table constraint on tenant_assignments.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a DB row → app assignment shape */
function dbToAssignment(row) {
  return {
    id:             row.id,
    contentType:    row.content_type,
    contentId:      row.content_id,
    assignedTo:     row.assigned_to ?? {},
    dueAt:          row.due_at ?? "Open",
    required:       row.required ?? false,
    assignedBy:     row.assigned_by ?? null,
    source: {
      type:  row.source_type ?? "individual",
      id:    row.source_id ?? null,
      label: row.source_label ?? null,
    },
    assignedAt:     row.assigned_at
      ? new Date(row.assigned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "—",
    assignedAtRaw:  row.assigned_at ?? null, // ISO string — used for availability date math
    // Cancellation (063): set when the assigned content was archived/removed.
    // A cancelled assignment is preserved for history but never counts as
    // active/overdue/pending and never blocks reassignment.
    cancelledAt:     row.cancelled_at ?? null,
    cancelledReason: row.cancelled_reason ?? null,
  };
}

/**
 * Fetch all assignments for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getTenantAssignments(tenantId, { includeCancelled = false } = {}) {
  // Cancelled assignments (063) are excluded by default so they never count as
  // active/overdue/pending anywhere (learner lists, Home/To-Do, dashboard KPIs).
  // The manager historical view passes includeCancelled:true to surface them as
  // "Unavailable — content archived/removed".
  let q = supabase
    .from("tenant_assignments")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("assigned_at", { ascending: false });
  if (!includeCancelled) q = q.is("cancelled_at", null);
  const { data, error } = await q;
  return { data: data ? data.map(dbToAssignment) : null, error };
}

/**
 * Subscribe to tenant_assignments changes (INSERT/UPDATE/DELETE) for one
 * tenant, so a manager creating/editing/removing an assignment shows up for
 * everyone watching without a manual refresh (Task 12).
 *
 * Tenant-scoped two ways: the Postgres `filter` below narrows which change
 * events even reach this channel, and — the real security boundary —
 * Realtime respects the table's RLS `tenant_assignments_select` policy
 * (017_tenant_assignments.sql), so a client can never receive a row for a
 * tenant it isn't allowed to SELECT, filter or no filter. A cross-tenant
 * `ralli_admin` caller (who can SELECT every tenant per that same policy)
 * intentionally only gets this one tenant's events, matching every other
 * tenant-scoped read in this file.
 *
 * `scope` disambiguates the channel name per caller (e.g. "home", "learn",
 * "quizzes-user", "quizzes-tracking") so multiple screens can each hold
 * their own independent subscription for the same tenant without colliding
 * on one shared channel topic.
 *
 * `onChange` is debounced (400ms of quiet) rather than called once per raw
 * event — a single manager action can fan out to many rows at once (team/org
 * assignment, Task 10's createAssignments()), which would otherwise fire the
 * caller's refetch once per inserted row instead of once for the whole
 * change.
 *
 * Returns a plain cleanup function (not the raw channel) — call it on
 * unmount/dependency-change. It cancels any pending debounced refetch and
 * removes the channel, so a component that unmounts mid-debounce can never
 * fire a refetch (and any resulting setState) after it's gone.
 *
 * @param {string} tenantId
 * @param {string} scope - short, unique-per-caller label for the channel name
 * @param {() => void} onChange - called (no payload — callers just refetch) after a burst of INSERT/UPDATE/DELETE events settles
 * @returns {() => void} cleanup — call on unmount
 */
export function subscribeToTenantAssignments(tenantId, scope, onChange) {
  let debounceTimer = null;
  const debouncedOnChange = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(onChange, 400);
  };
  const channel = supabase
    .channel(`tenant_assignments:${scope}:${tenantId}`)
    .on(
      "postgres_changes",
      {
        event:  "*",
        schema: "public",
        table:  "tenant_assignments",
        filter: `tenant_id=eq.${tenantId}`,
      },
      debouncedOnChange
    )
    .subscribe();
  return () => {
    clearTimeout(debounceTimer);
    supabase.removeChannel(channel);
  };
}

/**
 * Resolve a target (individual/team/group) into the candidate { userId, userName }
 * pairs it fans out to. Queried fresh from Supabase so it always reflects
 * current team/org membership at assign time (or at eligibility-check time).
 *
 * Individual targets are never trusted blindly: assignedTo.userId is verified
 * against `profiles` for this exact tenant_id, and inactive/suspended profiles
 * are excluded — same as team/group. An invalid target (wrong tenant, doesn't
 * exist, inactive, or suspended) resolves to an empty candidate list, which
 * createAssignments() turns into a clear `blocked` result rather than a
 * silent no-op or a cross-tenant write.
 */
async function resolveTargetCandidates(tenantId, assignedTo) {
  const targetType = assignedTo?.type;

  if (targetType === "individual") {
    if (!assignedTo.userId) return [];
    const { data: profile } = await supabase
      .from("profiles")
      .select("id, name, email, status")
      .eq("id", assignedTo.userId)
      .eq("tenant_id", tenantId)
      .maybeSingle();
    if (!profile || profile.status === "inactive" || profile.status === "suspended") return [];
    return [{ userId: profile.id, userName: assignedTo.userName || profile.name || profile.email?.split("@")[0] || "User" }];
  }

  if (targetType === "team") {
    if (!assignedTo.teamId) return [];
    const { data } = await supabase
      .from("profiles")
      .select("id, name, email")
      .eq("tenant_id", tenantId)
      .eq("team_id", assignedTo.teamId)
      .not("status", "in", "(inactive,suspended)");
    return (data ?? []).map(p => ({ userId: p.id, userName: p.name ?? p.email?.split("@")[0] ?? "User" }));
  }

  if (targetType === "group") {
    const { data } = await supabase
      .from("profiles")
      .select("id, name, email, role")
      .eq("tenant_id", tenantId)
      .not("status", "in", "(inactive,suspended)")
      .not("role", "in", "(ralli_admin,orgAdmin)");
    return (data ?? []).map(p => ({ userId: p.id, userName: p.name ?? p.email?.split("@")[0] ?? "User" }));
  }

  return [];
}

/**
 * Which candidate users have EVER resolved this piece of content, at any
 * point in time — content-level, with no reference to which assignment
 * instance is being evaluated. Mirrors _content_completed_user_ids() in SQL.
 *
 * Not used for assignment eligibility by any content type anymore — quiz
 * (migration 036), lesson, and course (migration 037) all use their
 * assignment-instance-aware counterpart instead (getQuizAssignmentActiveUserIds
 * / getLessonAssignmentActiveUserIds / getCourseAssignmentActiveUserIds),
 * because "completed ever" incorrectly treats a stale, pre-reassignment
 * completion as resolving a brand-new assignment. Kept as a correct,
 * tenant-safe read-only utility for "has this user ever finished X at all"
 * style reporting, where assignment timing genuinely doesn't matter.
 * @returns {Promise<Set<string>>} profile IDs
 */
async function getCompletedUserIds(tenantId, contentType, contentId) {
  if (contentType === "quiz") {
    const { data } = await supabase
      .from("quiz_attempts")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .eq("quiz_id", contentId);
    return new Set((data ?? []).map(r => r.user_id));
  }

  if (contentType === "lesson") {
    const { data } = await supabase
      .from("lesson_completions")
      .select("profile_id")
      .eq("tenant_id", tenantId)
      .eq("lesson_id", contentId);
    return new Set((data ?? []).map(r => r.profile_id));
  }

  if (contentType === "course") {
    const { data: course } = await supabase
      .from("tenant_courses")
      .select("lesson_ids")
      .eq("id", contentId)
      .eq("tenant_id", tenantId) // defense in depth — don't rely on RLS alone for tenant scoping
      .maybeSingle();
    const lessonIds = course?.lesson_ids ?? [];
    if (lessonIds.length === 0) return new Set();
    const { data: completions } = await supabase
      .from("lesson_completions")
      .select("profile_id, lesson_id")
      .eq("tenant_id", tenantId)
      .in("lesson_id", lessonIds);
    const doneByUser = new Map();
    for (const row of completions ?? []) {
      const set = doneByUser.get(row.profile_id) ?? new Set();
      set.add(row.lesson_id);
      doneByUser.set(row.profile_id, set);
    }
    const completed = new Set();
    for (const [userId, doneLessons] of doneByUser) {
      if (doneLessons.size >= lessonIds.length) completed.add(userId);
    }
    return completed;
  }

  return new Set();
}

/**
 * Assignment-instance-aware version of "who currently blocks a new quiz
 * assignment" — mirrors _quiz_assignment_active_user_ids() in
 * 036_assignment_aware_quiz_eligibility.sql exactly, field for field, so this
 * JS path and the live RPC enforcement never silently diverge.
 *
 * getCompletedUserIds()'s quiz branch answers "has this user EVER attempted
 * this quiz" — content-level, with no reference to which assignment is being
 * evaluated. That permanently exempted a user from duplicate-blocking after
 * their very first attempt, even for a brand-new, untouched reassignment
 * created afterward (see migration 036's header for the full story; this is
 * the JS mirror of that fix, not a second copy of the old check).
 *
 * For every user ever targeted by any assignment row for this quiz (expanded
 * through resolveTargetCandidates() — the same expansion
 * _assignment_target_user_ids() does in SQL, covering new per-user rows and
 * legacy team/group aggregate rows identically), finds their most recent
 * assigned_at across all rows that target them, then checks for a
 * quiz_attempts row created at or after that timestamp. A user with no such
 * qualifying attempt is still active.
 * @returns {Promise<Set<string>>} profile IDs still active (unresolved) for this quiz
 */
async function getQuizAssignmentActiveUserIds(tenantId, contentId) {
  const { data: rows } = await supabase
    .from("tenant_assignments")
    .select("assigned_to, assigned_at")
    .eq("tenant_id", tenantId)
    .eq("content_type", "quiz")
    .eq("content_id", contentId)
    .is("cancelled_at", null);   // cancelled assignments never block reassignment (063)

  const latestAssignedAtByUser = new Map();
  for (const row of rows ?? []) {
    const candidates = await resolveTargetCandidates(tenantId, row.assigned_to);
    for (const c of candidates) {
      const prev = latestAssignedAtByUser.get(c.userId);
      if (!prev || new Date(row.assigned_at) > new Date(prev)) latestAssignedAtByUser.set(c.userId, row.assigned_at);
    }
  }
  if (latestAssignedAtByUser.size === 0) return new Set();

  const { data: attempts } = await supabase
    .from("quiz_attempts")
    .select("user_id, created_at")
    .eq("tenant_id", tenantId)
    .eq("quiz_id", contentId)
    .in("user_id", [...latestAssignedAtByUser.keys()]);

  const active = new Set();
  for (const [userId, latestAssignedAt] of latestAssignedAtByUser) {
    const resolved = (attempts ?? []).some(at => at.user_id === userId && isQualifyingEvent(at.created_at, latestAssignedAt));
    if (!resolved) active.add(userId);
  }
  return active;
}

/**
 * Assignment-instance-aware version of "who currently blocks a new lesson
 * assignment" — mirrors _lesson_assignment_active_user_ids() in
 * 037_assignment_aware_lesson_course_eligibility.sql exactly, field for
 * field, so this JS path and the live RPC enforcement never silently
 * diverge. Lesson counterpart to getQuizAssignmentActiveUserIds() above —
 * see that function's docstring for the full "why" (same bug, same fix
 * shape, just lesson_completions.completed_at in place of
 * quiz_attempts.created_at).
 * @returns {Promise<Set<string>>} profile IDs still active (unresolved) for this lesson
 */
async function getLessonAssignmentActiveUserIds(tenantId, contentId) {
  const { data: rows } = await supabase
    .from("tenant_assignments")
    .select("assigned_to, assigned_at")
    .eq("tenant_id", tenantId)
    .eq("content_type", "lesson")
    .eq("content_id", contentId)
    .is("cancelled_at", null);   // cancelled assignments never block reassignment (063)

  const latestAssignedAtByUser = new Map();
  for (const row of rows ?? []) {
    const candidates = await resolveTargetCandidates(tenantId, row.assigned_to);
    for (const c of candidates) {
      const prev = latestAssignedAtByUser.get(c.userId);
      if (!prev || new Date(row.assigned_at) > new Date(prev)) latestAssignedAtByUser.set(c.userId, row.assigned_at);
    }
  }
  if (latestAssignedAtByUser.size === 0) return new Set();

  const { data: completions } = await supabase
    .from("lesson_completions")
    .select("profile_id, completed_at")
    .eq("tenant_id", tenantId)
    .eq("lesson_id", contentId)
    .in("profile_id", [...latestAssignedAtByUser.keys()]);

  const active = new Set();
  for (const [userId, latestAssignedAt] of latestAssignedAtByUser) {
    const resolved = (completions ?? []).some(c => c.profile_id === userId && isQualifyingEvent(c.completed_at, latestAssignedAt));
    if (!resolved) active.add(userId);
  }
  return active;
}

/**
 * Assignment-instance-aware version of "who currently blocks a new course
 * assignment" — mirrors _course_assignment_active_user_ids() in
 * 037_assignment_aware_lesson_course_eligibility.sql exactly. A user is
 * still active unless EVERY one of the course's lessons has a completion
 * dated at/after their most recent course assignment's assigned_at — an old
 * completion from before that assignment does not count toward resolving it.
 * @returns {Promise<Set<string>>} profile IDs still active (unresolved) for this course
 */
async function getCourseAssignmentActiveUserIds(tenantId, contentId) {
  const { data: course } = await supabase
    .from("tenant_courses")
    .select("lesson_ids")
    .eq("id", contentId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  const lessonIds = course?.lesson_ids ?? [];
  if (lessonIds.length === 0) return new Set(); // missing/cross-tenant/empty course — nobody is "active"

  const { data: rows } = await supabase
    .from("tenant_assignments")
    .select("assigned_to, assigned_at")
    .eq("tenant_id", tenantId)
    .eq("content_type", "course")
    .eq("content_id", contentId)
    .is("cancelled_at", null);   // cancelled assignments never block reassignment (063)

  const latestAssignedAtByUser = new Map();
  for (const row of rows ?? []) {
    const candidates = await resolveTargetCandidates(tenantId, row.assigned_to);
    for (const c of candidates) {
      const prev = latestAssignedAtByUser.get(c.userId);
      if (!prev || new Date(row.assigned_at) > new Date(prev)) latestAssignedAtByUser.set(c.userId, row.assigned_at);
    }
  }
  if (latestAssignedAtByUser.size === 0) return new Set();

  const { data: completions } = await supabase
    .from("lesson_completions")
    .select("profile_id, lesson_id, completed_at")
    .eq("tenant_id", tenantId)
    .in("lesson_id", lessonIds)
    .in("profile_id", [...latestAssignedAtByUser.keys()]);

  const active = new Set();
  for (const [userId, latestAssignedAt] of latestAssignedAtByUser) {
    const qualifyingLessons = new Set(
      (completions ?? [])
        .filter(c => c.profile_id === userId && isQualifyingEvent(c.completed_at, latestAssignedAt))
        .map(c => c.lesson_id)
    );
    const resolved = qualifyingLessons.size >= lessonIds.length;
    if (!resolved) active.add(userId);
  }
  return active;
}

/**
 * Which candidate users currently hold an ACTIVE assignment (assigned /
 * in_progress / overdue) for this content. Covers both new-style per-user
 * rows and legacy team/group aggregate rows, so duplicate prevention is
 * correct regardless of when the existing assignment was created.
 *
 * All three content types are assignment-instance-aware: quiz via
 * getQuizAssignmentActiveUserIds(), lesson via
 * getLessonAssignmentActiveUserIds(), course via
 * getCourseAssignmentActiveUserIds(). An old completion from before the
 * user's current assignment never resolves it, matching the equivalent SQL
 * enforced by create_assignments_atomic().
 *
 * NOT used by createAssignments() anymore — a read-then-act check here is
 * inherently racy under concurrent calls (see 034_atomic_assignment_engine.sql).
 * createAssignments() delegates the check-then-insert to the
 * create_assignments_atomic() RPC, which does it inside one locked
 * transaction. This function is kept as a correct, tenant-safe read-only
 * utility — used by AssignContentModal (rankd-app.jsx) to show managers each
 * candidate's active/eligible status BEFORE they submit, and by any future
 * "who's currently active on X" report. Read-only preview only; the atomic
 * RPC above remains the sole source of truth for enforcement at submit time.
 * @returns {Promise<Map<string, { assignmentId: string, dueAt: string|null, required: boolean }>>}
 */
export async function getActiveAssignmentsByUser(tenantId, contentType, contentId) {
  const { data: rows } = await supabase
    .from("tenant_assignments")
    .select("id, assigned_to, due_at, required")
    .eq("tenant_id", tenantId)
    .eq("content_type", contentType)
    .eq("content_id", contentId)
    .is("cancelled_at", null);   // cancelled assignments are not active (063)

  const activeIds =
    contentType === "quiz"   ? await getQuizAssignmentActiveUserIds(tenantId, contentId)
  : contentType === "lesson" ? await getLessonAssignmentActiveUserIds(tenantId, contentId)
  :                             await getCourseAssignmentActiveUserIds(tenantId, contentId);
  const activeByUser = new Map();

  for (const row of rows ?? []) {
    const candidates = await resolveTargetCandidates(tenantId, row.assigned_to);
    for (const c of candidates) {
      if (!activeIds.has(c.userId)) continue; // resolved — doesn't block reassignment
      if (!activeByUser.has(c.userId)) {
        activeByUser.set(c.userId, { assignmentId: row.id, dueAt: row.due_at, required: row.required });
      }
    }
  }
  return activeByUser;
}

/**
 * Unified assignment engine. Fans out team/group targets to one row per
 * eligible member; skips members who already hold an active assignment for
 * this content; lets completed members be reassigned. Individual targets
 * that are invalid (wrong tenant, inactive/suspended, or already actively
 * assigned) come back as `blocked: true` so the caller can explain why.
 *
 * The eligibility check and the inserts happen atomically inside the
 * create_assignments_atomic() RPC (034_atomic_assignment_engine.sql),
 * serialized per tenant+content via a transaction-scoped advisory lock — this
 * function does NOT do its own read-then-insert, so concurrent calls for the
 * same content can't both see "no active assignment" and both write.
 *
 * @param {string} tenantId
 * @param {{ contentType: 'quiz'|'lesson'|'course', contentId: string, assignedTo: Object, dueAt?: string, required?: boolean }} assignment
 * @param {string} [assignedByUserId]
 * @returns {Promise<{
 *   data: Object[],
 *   error: Object|null,
 *   assignedCount: number,
 *   skippedCount: number,
 *   skipped: Array<{ userId: string, userName: string, reason: string, dueAt: string|null }>,
 *   blocked: boolean,
 * }>}
 */
export async function createAssignments(tenantId, assignment, assignedByUserId) {
  const assignedTo = assignment.assignedTo ?? {};
  const targetType  = assignedTo.type ?? "individual";

  // Resolves + validates the target (tenant match, inactive/suspended
  // exclusion for every target type, including individual — see
  // resolveTargetCandidates()). Safe to do outside the lock: team/group
  // membership isn't what races here: it's the per-user active-assignment
  // check, which the RPC below makes atomic.
  const candidates = await resolveTargetCandidates(tenantId, assignedTo);

  if (candidates.length === 0) {
    // An individual target that resolved to zero candidates means the
    // requested user doesn't exist in this tenant, or is inactive/suspended —
    // that's a blocked error, not a silent no-op. An empty team/group (no
    // eligible members) is not an error, just nothing to do.
    if (targetType === "individual") {
      return {
        data: [], error: null, assignedCount: 0, skippedCount: 1,
        skipped: [{ userId: assignedTo.userId ?? null, userName: assignedTo.userName ?? "", reason: "invalid_target", dueAt: null }],
        blocked: true,
      };
    }
    return { data: [], error: null, assignedCount: 0, skippedCount: 0, skipped: [], blocked: false };
  }

  const dueAt       = assignment.dueAt && assignment.dueAt !== "Open" ? assignment.dueAt : null;
  const sourceId    = targetType === "team" ? assignedTo.teamId : targetType === "group" ? assignedTo.orgId : null;
  const sourceLabel = targetType === "team" ? (assignedTo.teamName ?? null) : null;

  const { data, error } = await supabase.rpc("create_assignments_atomic", {
    p_tenant_id:    tenantId,
    p_content_type: assignment.contentType,
    p_content_id:   assignment.contentId,
    p_candidates:   candidates,
    p_due_at:       dueAt,
    p_required:     assignment.required ?? false,
    p_assigned_by:  assignedByUserId ?? null,
    p_source_type:  targetType,
    p_source_id:    sourceId,
    p_source_label: sourceLabel,
  });

  if (error) {
    // 23505 (unique_violation) shouldn't happen under the advisory lock, but
    // handle it gracefully rather than surfacing a raw DB error if it ever
    // does (e.g. a future constraint, or an exact-duplicate retried request).
    if (error.code === "23505") {
      return {
        data: [], error: null, assignedCount: 0, skippedCount: candidates.length,
        skipped: candidates.map(c => ({ userId: c.userId, userName: c.userName, reason: "already_assigned", dueAt: null })),
        blocked: targetType === "individual",
      };
    }
    console.error("[contentService] create_assignments_atomic failed:", error);
    return { data: [], error, assignedCount: 0, skippedCount: 0, skipped: [], blocked: false };
  }

  const created       = data?.created ?? [];
  const skipped       = data?.skipped ?? [];
  const assignedCount = data?.assignedCount ?? created.length;
  const skippedCount  = data?.skippedCount ?? skipped.length;
  const blocked       = targetType === "individual" && assignedCount === 0 && skippedCount > 0;

  return {
    data: created.map(dbToAssignment),
    error: null,
    assignedCount,
    skippedCount,
    skipped,
    blocked,
  };
}

/**
 * Delete an assignment by id.
 * @param {string} assignmentId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteAssignment(assignmentId) {
  const { error } = await supabase
    .from("tenant_assignments")
    .delete()
    .eq("id", assignmentId);
  return { error };
}


// ─────────────────────────────────────────────────────────────────────────────
// ARCHIVE / RESTORE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Soft-archive a course (sets status = 'archived').
 * @param {string} courseId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function archiveCourse(courseId) {
  // archive_course() (063) archives AND cancels the course's active assignments
  // in one server-side step, so no assignment is left stranded.
  const { data, error } = await supabase.rpc("archive_course", { p_course_id: courseId });
  return { data, error };
}

/**
 * Soft-archive a lesson (sets status = 'archived').
 * @param {string} lessonId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function archiveLesson(lessonId) {
  // archive_lesson() (063) archives AND cancels the lesson's active assignments,
  // and BLOCKS archival while the lesson belongs to an active course (the manager
  // must remove it from the course first) — so an active course can never contain
  // an archived member. On block it returns an error the caller surfaces.
  const { data, error } = await supabase.rpc("archive_lesson", { p_lesson_id: lessonId });
  return { data, error };
}

/**
 * Restore a course from archive (sets status = 'active').
 * @param {string} courseId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function restoreCourse(courseId) {
  const { error } = await supabase
    .from("tenant_courses")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", courseId);
  return { error };
}

/**
 * Restore a lesson from archive (sets status = 'active').
 * @param {string} lessonId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function restoreLesson(lessonId) {
  const { error } = await supabase
    .from("tenant_lessons")
    .update({ status: "active", updated_at: new Date().toISOString() })
    .eq("id", lessonId);
  return { error };
}

/**
 * Fetch all archived courses and lessons for a tenant.
 * Used by the manager Archived tab.
 * @param {string} tenantId
 * @returns {Promise<{ data: { courses: Object[], lessons: Object[] }|null, error: Object|null }>}
 */
export async function getArchivedContent(tenantId) {
  const [{ data: archivedCourses, error: ce }, { data: archivedLessons, error: le }] = await Promise.all([
    supabase
      .from("tenant_courses")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "archived")
      .order("updated_at", { ascending: false }),
    supabase
      .from("tenant_lessons")
      .select("*")
      .eq("tenant_id", tenantId)
      .eq("status", "archived")
      .order("updated_at", { ascending: false }),
  ]);
  return {
    data: {
      courses: archivedCourses ? archivedCourses.map(dbToCourse) : [],
      lessons: archivedLessons ? archivedLessons.map(dbToLesson) : [],
    },
    error: ce ?? le ?? null,
  };
}

/**
 * Fetch all lesson completions for a tenant's users.
 * Used by the manager Assignments tab to show per-rep completion status.
 * Managers and orgAdmins can read all rows (RLS policy on lesson_completions allows this).
 * @param {string} tenantId
 * @returns {Promise<{ data: Array<{ profileId: string, lessonId: string, completedAt: string }>|null, error: Object|null }>}
 */
export async function getTenantLessonCompletions(tenantId) {
  const { data, error } = await supabase
    .from("lesson_completions")
    .select("profile_id, lesson_id, completed_at")
    .eq("tenant_id", tenantId);
  return {
    data: data
      ? data.map(r => ({ profileId: r.profile_id, lessonId: r.lesson_id, completedAt: r.completed_at }))
      : null,
    error,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// LESSON COMPLETIONS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all lesson IDs the current user has completed.
 * Returns a Set of lesson ID strings.
 * @param {string} profileId
 * @returns {Promise<{ data: Set<string>|null, error: Object|null }>}
 */
export async function getLessonCompletions(profileId) {
  const { data, error } = await supabase
    .from("lesson_completions")
    .select("lesson_id")
    .eq("profile_id", profileId);
  return {
    data: data ? new Set(data.map(r => r.lesson_id)) : null,
    error,
  };
}

/**
 * Mark a lesson as complete for the current user.
 * Uses upsert — safe to call multiple times. completed_at is set explicitly
 * on every call (not left to the column default) because Supabase's upsert
 * only issues `DO UPDATE SET <columns in the payload>` — omitting completed_at
 * meant a RE-completion (e.g. after being reassigned the lesson) silently kept
 * the original completed_at from the user's very first completion, since
 * (profile_id, lesson_id) is UNIQUE and the row is updated in place, not
 * inserted again. That stale timestamp would then always read as "before" any
 * later reassignment's assigned_at, permanently hiding the new assignment as
 * unresolved even after the user genuinely redid it. See
 * _lesson_assignment_active_user_ids() (037_assignment_aware_lesson_course_eligibility.sql)
 * and getLessonAssignmentActiveUserIds() below, which both depend on
 * completed_at accurately reflecting the MOST RECENT completion.
 * @param {string} profileId
 * @param {string} lessonId
 * @param {string} [tenantId]
 * @returns {Promise<{ error: Object|null }>}
 */
export async function markLessonComplete(profileId, lessonId, tenantId = null) {
  // Server-authoritative (063): mark_lesson_complete() derives the tenant from the
  // authenticated learner + the referenced lesson and rejects a cross-tenant or
  // missing-content completion — the browser never supplies tenant_id. profileId/
  // tenantId args are retained for call-site compatibility but intentionally
  // ignored; identity comes from auth.uid() inside the RPC. Same single
  // (profile,lesson) completion row is upserted (completed_at refreshed).
  const { data, error } = await supabase.rpc("mark_lesson_complete", { p_lesson_id: lessonId });
  return { data, error };
}

/**
 * Fetch lesson completions for a single user, WITH timestamps — used wherever
 * completion needs to be compared against a specific assignment's assigned_at
 * (assignment-instance-aware eligibility/display). For plain "has this lesson
 * ever been completed" membership checks with no timing concern, use the
 * simpler getLessonCompletions() above instead.
 * @param {string} profileId
 * @returns {Promise<{ data: Map<string, string>|null, error: Object|null }>} lesson_id → completed_at (ISO string)
 */
export async function getLessonCompletionsWithDates(profileId) {
  const { data, error } = await supabase
    .from("lesson_completions")
    .select("lesson_id, completed_at")
    .eq("profile_id", profileId);
  return {
    data: data ? new Map(data.map(r => [r.lesson_id, r.completed_at])) : null,
    error,
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// QUIZ ATTEMPTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Persist a quiz attempt to Supabase.
 * Called immediately after scoring so insights have real accuracy data.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} quizId
 * @param {{ score: number, passed: boolean, answers: Array, attemptNum?: number }} attempt
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function saveQuizAttempt(tenantId, userId, quizId, attempt) {
  if (!tenantId || !userId || !quizId) return { data: null, error: new Error("Missing required params") };
  const { data, error } = await supabase
    .from("quiz_attempts")
    .insert({
      tenant_id:   tenantId,
      user_id:     userId,
      quiz_id:     quizId,
      score:       attempt.score ?? 0,
      passed:      attempt.passed ?? false,
      attempt_num: attempt.attemptNum ?? 1,
      answers:     attempt.answers ?? [],
    })
    .select()
    .maybeSingle();
  return { data, error };
}

/**
 * Sprint 3, Task 15 — atomic quiz completion.
 *
 * Persists the quiz attempt AND awards its XP in one database transaction
 * via the submit_quiz_attempt_atomic() RPC (039_atomic_quiz_completion.sql),
 * instead of the two independent, un-awaited client writes this replaced
 * (saveQuizAttempt() + scoringService.js's awardQuizPoints(), still exported
 * above/there for any other caller, but no longer used by the quiz-taking
 * flow). attempt_num is computed server-side under an advisory lock — never
 * trust a client-supplied count. Pass/fail itself is still decided entirely
 * client-side in QuizTakingView (unchanged) and simply carried through here.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} quizId
 * @param {{ score: number, passed: boolean, answers: Array }} attempt
 * @param {string} idempotencyKey - stable per quiz-taking session (see
 *   QuizTakingView's submissionIdRef) so a retry or double-click of the SAME
 *   submission never inserts a second attempt row or awards XP twice. A
 *   genuine retake uses a new key (new QuizTakingView mount).
 * @returns {Promise<{ data: { attempt: Object, pointsAwarded: number, alreadyRecorded: boolean }|null, error: Object|null }>}
 */
export async function submitQuizAttemptAtomic(tenantId, userId, quizId, attempt, idempotencyKey) {
  if (!tenantId || !userId || !quizId) return { data: null, error: new Error("Missing required params") };
  const { data, error } = await supabase.rpc("submit_quiz_attempt_atomic", {
    p_tenant_id:       tenantId,
    p_user_id:         userId,
    p_quiz_id:         quizId,
    p_score:           attempt.score ?? 0,
    p_passed:          attempt.passed ?? false,
    p_answers:         attempt.answers ?? [],
    p_idempotency_key: idempotencyKey ?? null,
  });
  return { data, error };
}

// ── Learner-safe quiz access (Answer Confidentiality — Stage 1, migration 055) ──
// Learners NEVER receive canonical answers. These RPCs are the only learner read
// path for quiz content/history; managers keep the full canonical reads above.

/** Sanitized library/assignment metadata for the caller — one call, no answer bodies. */
export async function listQuizzesForLearner() {
  const { data, error } = await supabase.rpc("list_quizzes_for_learner");
  return { data: data ?? null, error };
}

/** Playable, sanitized quiz (no answer keys) + question_revision for one assigned quiz. */
export async function getQuizForAttempt(quizId) {
  if (!quizId) return { data: null, error: new Error("Missing quizId") };
  const { data, error } = await supabase.rpc("get_quiz_for_attempt", { p_quiz_id: quizId });
  return { data: data ?? null, error };
}

/**
 * The caller's OWN quiz-attempt SUMMARIES (no answers, no snapshots, no other
 * users' rows) — for Home / To-Do / assignment status / history lists. Learner
 * screens use this instead of getUserQuizAttempts(), whose raw rows include the
 * answers JSON (legacy rows carry canonical `correct` there). Detailed review is
 * a separate, pass-gated call (getQuizReview).
 */
export async function getMyQuizAttemptsSafe() {
  const { data, error } = await supabase.rpc("list_my_quiz_attempts_safe");
  return { data: data ?? null, error };
}

/** The caller's own attempt history; canonical answers revealed only after an official pass. */
export async function getQuizReview(quizId) {
  if (!quizId) return { data: null, error: new Error("Missing quizId") };
  const { data, error } = await supabase.rpc("get_quiz_review", { p_quiz_id: quizId });
  return { data: data ?? null, error };
}

/**
 * Server-authoritative quiz submission (Input Authority Hardening — Area 1,
 * migration 054). Unlike submitQuizAttemptAtomic(), this does NOT trust a
 * client-computed score/passed: the server recomputes both from the canonical
 * questions (mirroring isAnswerCorrect), rejects a submission whose loaded
 * `expectedRevision` no longer matches the quiz (mid-attempt edit), and stamps
 * trusted provenance the client cannot forge. Identity is derived server-side
 * from auth.uid() — no user id is passed.
 *
 * Returns data.status: 'ok' (attempt persisted, use data.attempt/server_score)
 * or 'quiz_changed' (nothing persisted; caller should reload the quiz).
 *
 * @param {string} tenantId
 * @param {string} quizId
 * @param {Array}  answers            - [{ questionId, selected, ... }] in question order
 * @param {string} expectedRevision   - quiz.questionRevision loaded at attempt start
 * @param {string} idempotencyKey      - stable per quiz-taking session
 */
export async function submitQuizAttemptAtomicV2(tenantId, quizId, answers, expectedRevision, idempotencyKey) {
  if (!tenantId || !quizId) return { data: null, error: new Error("Missing required params") };
  const { data, error } = await supabase.rpc("submit_quiz_attempt_atomic_v2", {
    p_tenant_id:         tenantId,
    p_quiz_id:           quizId,
    p_answers:           answers ?? [],
    p_expected_revision: expectedRevision ?? null,
    p_idempotency_key:   idempotencyKey ?? null,
  });
  return { data, error };
}

/**
 * Fetch all quiz attempts for a user within a tenant.
 * Used by insightsService to compute quiz accuracy per topic.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getUserQuizAttempts(tenantId, userId) {
  const { data, error } = await supabase
    .from("quiz_attempts")
    .select("id, quiz_id, score, passed, attempt_num, answers, created_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  return { data, error };
}

/**
 * Fetch all quiz attempts for all users in a tenant.
 * Used by managers/admins for team-level insights, and by the manager
 * Quizzes screen to compute assignment status (assigned/in-progress/completed/overdue)
 * and to power the per-attempt answer drill-down (question, selected answer,
 * correct answer, correct/incorrect).
 *
 * @param {string} tenantId
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getTenantQuizAttempts(tenantId) {
  const { data, error } = await supabase
    .from("quiz_attempts")
    // grading_provenance/verified_revision let the manager drill-down tell a
    // trusted (server_v2, snapshot-backed) attempt from a legacy one, so it can
    // reveal the immutable historical answer key instead of guessing.
    .select("id, user_id, quiz_id, score, passed, attempt_num, answers, created_at, grading_provenance, verified_revision")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  return { data, error };
}

/**
 * Immutable per-attempt solution snapshots for a set of attempts, keyed by
 * attempt_id. Managers/admins read these directly (RLS: quiz_attempt_solutions
 * qas_select_manager). This is the manager drill-down's ONLY source of the
 * historical answer key — never the quiz's current mutable questions — so a
 * quiz edited after the attempt can't retroactively rewrite what the rep was
 * graded against. Attempts without a snapshot (legacy) simply won't appear in
 * the returned map, and the UI degrades honestly.
 *
 * @param {string[]} attemptIds
 * @returns {Promise<{ data: Object<string, Array>|null, error: Object|null }>}
 */
export async function getAttemptSolutions(attemptIds) {
  const ids = Array.isArray(attemptIds) ? attemptIds.filter(Boolean) : [];
  if (ids.length === 0) return { data: {}, error: null };
  const { data, error } = await supabase
    .from("quiz_attempt_solutions")
    .select("attempt_id, solution")
    .in("attempt_id", ids);
  if (error) return { data: null, error };
  const byAttempt = {};
  for (const row of data ?? []) byAttempt[String(row.attempt_id)] = row.solution;
  return { data: byAttempt, error: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// BATTLE CARDS
// Replaces localStorage-only storage. All tenant members can read; only
// managers/admins can write. Shape mirrors the in-app BC object:
//   Category: { id, label, description }
//   Card:     { id, categoryId, title, subtitle, summary, strength, weakness,
//               ourWin, talkTrack, tags, content: [{heading,body}] }
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a DB category row → app shape */
function dbToCategory(row) {
  return {
    id:          row.id,
    label:       row.label,
    description: row.description ?? "",
  };
}

/** Normalise app category → DB insert/update shape */
function categoryToDb(tenantId, cat, userId) {
  return {
    tenant_id:   tenantId,
    label:       cat.label,
    description: cat.description ?? "",
    created_by:  userId ?? null,
    updated_at:  new Date().toISOString(),
  };
}

/** Normalise a DB card row → app shape */
function dbToCard(row) {
  return {
    id:          row.id,
    categoryId:  row.category_id ?? "",
    title:       row.title,
    subtitle:    row.subtitle ?? "",
    summary:     row.summary ?? "",
    strength:    row.strength ?? "",
    weakness:    row.weakness ?? "",
    ourWin:      row.our_win ?? "",
    talkTrack:   row.talk_track ?? "",
    tags:        row.tags ?? [],
    content:     row.content ?? [],
    updatedAt:   row.updated_at?.split("T")[0] ?? "",
  };
}

/** Normalise app card → DB insert/update shape */
function cardToDb(tenantId, card, userId) {
  return {
    tenant_id:   tenantId,
    category_id: card.categoryId || null,
    title:       card.title,
    subtitle:    card.subtitle ?? "",
    summary:     card.summary ?? "",
    strength:    card.strength ?? "",
    weakness:    card.weakness ?? "",
    our_win:     card.ourWin ?? "",
    talk_track:  card.talkTrack ?? "",
    tags:        card.tags ?? [],
    content:     card.content ?? [],
    created_by:  userId ?? null,
    updated_at:  new Date().toISOString(),
  };
}

/**
 * Fetch all battle card categories for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getTenantBcCategories(tenantId) {
  if (!tenantId) return { data: [], error: null };
  const { data, error } = await supabase
    .from("tenant_bc_categories")
    .select("id, label, description")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: true });
  return { data: data ? data.map(dbToCategory) : null, error };
}

/**
 * Fetch all battle cards for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getTenantBattleCards(tenantId) {
  if (!tenantId) return { data: [], error: null };
  const { data, error } = await supabase
    .from("tenant_battle_cards")
    .select("id, category_id, title, subtitle, summary, strength, weakness, our_win, talk_track, tags, content, updated_at")
    .eq("tenant_id", tenantId)
    .order("title", { ascending: true });
  return { data: data ? data.map(dbToCard) : null, error };
}

/**
 * Create or update a battle card category.
 * If cat.id is a UUID (from DB), updates. Otherwise inserts (new category).
 *
 * @param {string} tenantId
 * @param {{ id?: string, label: string, description?: string }} cat
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function saveBcCategory(tenantId, cat, userId) {
  const isExisting = cat.id && !cat.id.startsWith("cat_") && cat.id.length === 36;
  const payload = categoryToDb(tenantId, cat, userId);

  if (isExisting) {
    const { data, error } = await supabase
      .from("tenant_bc_categories")
      .update(payload)
      .eq("id", cat.id)
      .eq("tenant_id", tenantId)
      .select("id, label, description")
      .single();
    return { data: data ? dbToCategory(data) : null, error };
  } else {
    const { data, error } = await supabase
      .from("tenant_bc_categories")
      .insert(payload)
      .select("id, label, description")
      .single();
    if (error) return { data: null, error };
    if (data) return { data: dbToCategory(data), error: null };
    // Supabase can return null data when RLS blocks the post-insert SELECT.
    // Fall back to a separate SELECT to retrieve the newly-created row.
    const { data: fetched } = await supabase
      .from("tenant_bc_categories")
      .select("id, label, description")
      .eq("tenant_id", tenantId)
      .eq("label", cat.label)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { data: fetched ? dbToCategory(fetched) : null, error: null };
  }
}

/**
 * Delete a battle card category by ID.
 * Cards in this category will have category_id set to NULL (ON DELETE SET NULL).
 *
 * @param {string} tenantId
 * @param {string} catId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteBcCategory(tenantId, catId) {
  const { error } = await supabase
    .from("tenant_bc_categories")
    .delete()
    .eq("id", catId)
    .eq("tenant_id", tenantId);
  return { error };
}

/**
 * Create or update a battle card.
 * If card.id is a UUID (from DB), updates. Otherwise inserts.
 *
 * @param {string} tenantId
 * @param {Object} card
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function saveBattleCard(tenantId, card, userId) {
  const isExisting = card.id && !card.id.startsWith("bc_") && card.id.length === 36;
  const payload = cardToDb(tenantId, card, userId);

  const selectCols = "id, category_id, title, subtitle, summary, strength, weakness, our_win, talk_track, tags, content, updated_at";

  if (isExisting) {
    const { data, error } = await supabase
      .from("tenant_battle_cards")
      .update(payload)
      .eq("id", card.id)
      .eq("tenant_id", tenantId)
      .select(selectCols)
      .single();
    return { data: data ? dbToCard(data) : null, error };
  } else {
    const { data, error } = await supabase
      .from("tenant_battle_cards")
      .insert(payload)
      .select(selectCols)
      .single();
    return { data: data ? dbToCard(data) : null, error };
  }
}

/**
 * Delete a battle card by ID.
 *
 * @param {string} tenantId
 * @param {string} cardId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function deleteBattleCard(tenantId, cardId) {
  const { error } = await supabase
    .from("tenant_battle_cards")
    .delete()
    .eq("id", cardId)
    .eq("tenant_id", tenantId);
  return { error };
}

// ─────────────────────────────────────────────────────────────────────────────
// USER PROFILE PREFERENCES
// nickname, avatar_emoji, profile_pic_url, notif_prefs — previously localStorage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a user's profile preferences in Supabase.
 * Accepts a partial object — only the provided keys are written.
 *
 * @param {string} userId
 * @param {{ nickname?: string, avatarEmoji?: string, profilePicUrl?: string, notifPrefs?: Object }} prefs
 * @returns {Promise<{ error: Object|null }>}
 */
export async function updateUserProfile(userId, prefs = {}) {
  if (!userId) return { error: null };

  const update = {};
  if (prefs.nickname    !== undefined) update.nickname         = prefs.nickname    || null;
  if (prefs.avatarEmoji !== undefined) update.avatar_emoji     = prefs.avatarEmoji || null;
  if (prefs.profilePicUrl !== undefined) update.profile_pic_url = prefs.profilePicUrl || null;
  if (prefs.notifPrefs  !== undefined) update.notif_prefs      = prefs.notifPrefs;

  if (Object.keys(update).length === 0) return { error: null };

  const { error } = await supabase
    .from("profiles")
    .update(update)
    .eq("id", userId);
  return { error };
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENT VISIBILITY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark the current time as when the user last viewed their HomeScreen assignments.
 * Called on HomeScreen mount for real users.
 * Enables "NEW" badge logic: any assignment assigned after this timestamp is new on next login.
 *
 * @param {string} userId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function updateLastSeenAssignmentsAt(userId) {
  if (!userId) return { error: null };
  const { error } = await supabase
    .from("profiles")
    .update({ last_seen_assignments_at: new Date().toISOString() })
    .eq("id", userId);
  if (error) console.error("[contentService] updateLastSeenAssignmentsAt failed:", error);
  return { error };
}
