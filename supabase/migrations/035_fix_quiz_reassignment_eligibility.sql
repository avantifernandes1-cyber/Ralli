-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 035: Fix quiz reassignment eligibility — failed attempts wrongly
-- block reassignment forever.
-- Run after 034_atomic_assignment_engine.sql.
--
-- Bug:
--   _content_completed_user_ids() (034_atomic_assignment_engine.sql) only
--   treated a user as "done" with a quiz — and therefore eligible to be
--   reassigned — when they had a quiz_attempts row with passed = true. A user
--   who attempted the quiz and FAILED (passed = false) was never removed from
--   create_assignments_atomic()'s v_active_ids set, so they stayed "blocked"
--   from reassignment indefinitely, even though their assignment was finished
--   (just unsuccessfully). Editing the quiz afterward didn't change any of
--   this — upsertQuiz() updates tenant_quizzes in place and never changes the
--   quiz id, so this was never a content/version-identifier issue. It was
--   purely the pass/fail filter in this one helper function.
--
-- Fix:
--   For content_type = 'quiz', a user counts as resolved (no longer blocking
--   reassignment) once they have ANY quiz_attempts row for that quiz — pass
--   or fail. Quiz attempts in this app are atomic and final: a row is only
--   written once a quiz is fully submitted (see QuizTakingView's onComplete →
--   saveQuizAttempt in rankd-app.jsx), there is no partial/in-progress
--   attempt row and no attempt-count cap in the schema today. So "has an
--   attempt at all" is exactly "no longer assigned/open/in-progress/awaiting
--   completion" for quizzes — it covers passed, failed, and (implicitly)
--   "exhausted the attempts they took" in one condition, with no separate
--   attempt-limit feature needed. Assignment age is still never a factor —
--   this function has never filtered by date and this migration doesn't add
--   one. Lesson and course branches are unchanged; they already had no
--   pass/fail concept to begin with.
--
-- Scope note: this only replaces the SQL helper. create_assignments_atomic()
-- itself is untouched — it already correctly treats "not completed" (per
-- this helper) as active, so broadening what counts as completed here is
-- sufficient. The JS mirror, getCompletedUserIds() in
-- src/lib/contentService.js, gets the equivalent fix in the same change so
-- the (currently unused-on-the-live-path, kept for future reporting) JS
-- helper doesn't silently diverge from what the RPC actually enforces.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._content_completed_user_ids(p_tenant_id UUID, p_content_type TEXT, p_content_id TEXT)
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_lesson_ids   JSONB;
  v_lesson_count INT;
BEGIN
  IF p_content_type = 'quiz' THEN
    -- Any recorded attempt (passed or failed) resolves the assignment —
    -- was previously "AND passed = true", which left failed users blocked
    -- from reassignment forever. See migration header for the full story.
    RETURN QUERY
      SELECT DISTINCT user_id FROM public.quiz_attempts
      WHERE tenant_id = p_tenant_id AND quiz_id = p_content_id::UUID;
    RETURN;
  END IF;

  IF p_content_type = 'lesson' THEN
    RETURN QUERY
      SELECT DISTINCT profile_id FROM public.lesson_completions
      WHERE tenant_id = p_tenant_id AND lesson_id = p_content_id;
    RETURN;
  END IF;

  IF p_content_type = 'course' THEN
    SELECT lesson_ids INTO v_lesson_ids
      FROM public.tenant_courses
      WHERE id = p_content_id::UUID AND tenant_id = p_tenant_id; -- tenant-scoped, same fix as getCompletedUserIds()

    IF v_lesson_ids IS NULL OR jsonb_array_length(v_lesson_ids) = 0 THEN
      RETURN; -- missing/cross-tenant/empty course — nobody counts as complete
    END IF;
    v_lesson_count := jsonb_array_length(v_lesson_ids);

    RETURN QUERY
      SELECT profile_id
      FROM public.lesson_completions
      WHERE tenant_id = p_tenant_id
        AND lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
      GROUP BY profile_id
      HAVING COUNT(DISTINCT lesson_id) >= v_lesson_count;
    RETURN;
  END IF;

  RETURN;
END;
$$;

-- Function signature and grants are unchanged from 034 (CREATE OR REPLACE
-- keeps SECURITY INVOKER / STABLE / the PUBLIC revoke already in place) — no
-- re-grant needed.

-- ── Verify ────────────────────────────────────────────────────────────────────
-- A user with a FAILED attempt is no longer in the active set:
-- SELECT * FROM public._content_completed_user_ids('<tenant>', 'quiz', '<quizId>');
-- -- Expect: includes user_ids with only passed=false attempts, not just passed=true.
--
-- End-to-end: after this migration, a manager can call create_assignments_atomic
-- (or createAssignments() from the app) for a user whose only prior attempt on
-- this quiz has passed = false, and get assignedCount = 1 (not skipped).
