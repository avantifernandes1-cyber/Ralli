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
  const { error } = await supabase
    .from("tenant_lessons")
    .delete()
    .eq("id", lessonId);
  return { error };
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
  const { error } = await supabase
    .from("tenant_courses")
    .delete()
    .eq("id", courseId);
  return { error };
}


// ─────────────────────────────────────────────────────────────────────────────
// QUIZZES
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise a DB row → app quiz shape */
function dbToQuiz(row) {
  return {
    id:         row.id,
    name:       row.name,
    questions:  (row.questions ?? []).map(q => ({ ...q, text: q.text ?? q.q ?? "" })),
    status:     row.status ?? "active",
    favorite:   row.is_favorite ?? false,
    tags:       row.tags ?? [],
    createdAt:  row.created_at ? new Date(row.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—",
  };
}

/** Normalise an app quiz → DB payload */
function quizToDb(quiz, tenantId, userId) {
  return {
    tenant_id:   tenantId,
    name:        quiz.name,
    questions:   quiz.questions ?? [],
    status:      quiz.status ?? "active",
    is_favorite: quiz.favorite ?? quiz.is_favorite ?? false,
    tags:        quiz.tags ?? [],
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
// ASSIGNMENTS
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
    assignedAt:     row.assigned_at
      ? new Date(row.assigned_at).toLocaleDateString("en-US", { month: "short", day: "numeric" })
      : "—",
    assignedAtRaw:  row.assigned_at ?? null, // ISO string — used for availability date math
  };
}

/**
 * Fetch all assignments for a tenant.
 * @param {string} tenantId
 * @returns {Promise<{ data: Object[]|null, error: Object|null }>}
 */
export async function getTenantAssignments(tenantId) {
  const { data, error } = await supabase
    .from("tenant_assignments")
    .select("*")
    .eq("tenant_id", tenantId)
    .order("assigned_at", { ascending: false });
  return { data: data ? data.map(dbToAssignment) : null, error };
}

/**
 * Create a new assignment.
 * @param {string} tenantId
 * @param {Object} assignment - { contentType, contentId, assignedTo, dueAt, required }
 * @param {string} [userId]
 * @returns {Promise<{ data: Object|null, error: Object|null }>}
 */
export async function createAssignment(tenantId, assignment, userId) {
  const assignedTo = assignment.assignedTo ?? {};
  const targetType = assignedTo.type;
  const targetKey  = targetType === "team"       ? "teamId"
                   : targetType === "individual" ? "userId"
                   : targetType === "group"      ? "orgId"
                   : null;
  const targetId   = targetKey ? assignedTo[targetKey] : null;

  // Dedup: if the same content is already assigned to the same target, return the
  // existing row rather than inserting a duplicate.
  if (targetId) {
    const { data: existing } = await supabase
      .from("tenant_assignments")
      .select("*")
      .eq("tenant_id",           tenantId)
      .eq("content_type",        assignment.contentType)
      .eq("content_id",          assignment.contentId)
      .eq("assigned_to->>type",  targetType)
      .eq(`assigned_to->>${targetKey}`, targetId)
      .maybeSingle();
    if (existing) return { data: dbToAssignment(existing), error: null };
  }

  const { data, error } = await supabase
    .from("tenant_assignments")
    .insert({
      tenant_id:    tenantId,
      content_type: assignment.contentType,
      content_id:   assignment.contentId,
      assigned_to:  assignedTo,
      due_at:       assignment.dueAt && assignment.dueAt !== "Open" ? assignment.dueAt : null,
      required:     assignment.required ?? false,
      assigned_by:  userId ?? null,
    })
    .select()
    .single();
  return { data: data ? dbToAssignment(data) : null, error };
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
  const { error } = await supabase
    .from("tenant_courses")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", courseId);
  return { error };
}

/**
 * Soft-archive a lesson (sets status = 'archived').
 * @param {string} lessonId
 * @returns {Promise<{ error: Object|null }>}
 */
export async function archiveLesson(lessonId) {
  const { error } = await supabase
    .from("tenant_lessons")
    .update({ status: "archived", updated_at: new Date().toISOString() })
    .eq("id", lessonId);
  return { error };
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
 * Uses upsert — safe to call multiple times.
 * @param {string} profileId
 * @param {string} lessonId
 * @param {string} [tenantId]
 * @returns {Promise<{ error: Object|null }>}
 */
export async function markLessonComplete(profileId, lessonId, tenantId = null) {
  const { error } = await supabase
    .from("lesson_completions")
    .upsert(
      { profile_id: profileId, lesson_id: lessonId, tenant_id: tenantId },
      { onConflict: "profile_id,lesson_id" }
    );
  return { error };
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
 * Used by managers/admins for team-level insights.
 *
 * @param {string} tenantId
 * @returns {Promise<{ data: Array|null, error: Object|null }>}
 */
export async function getTenantQuizAttempts(tenantId) {
  const { data, error } = await supabase
    .from("quiz_attempts")
    .select("id, user_id, quiz_id, score, passed, attempt_num, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });
  return { data, error };
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
