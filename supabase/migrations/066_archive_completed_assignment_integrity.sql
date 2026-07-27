-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 066 — Archive must not cancel COMPLETED assignments (ADDITIVE forward)
--
-- DEFECT (found in live QA, present since 063/065): archive_lesson / archive_course
-- / archive_quiz cancel EVERY assignment row with cancelled_at IS NULL — including
-- rows the learner had already COMPLETED/PASSED. That (a) inflated the archive
-- "cancelled" count (e.g. a quiz reported 11 cancelled when only 2 were unresolved
-- and 9 were completed), and (b) rewrote completed history to cancelled_reason
-- 'content_archived', so the manager's completed scores/results read as
-- "Content Archived" instead of Completed.
--
-- 063 and 065 are APPLIED and IMMUTABLE. This forward migration:
--   1. CREATE OR REPLACEs the three archive_* RPCs so their cancellation UPDATE
--      cancels ONLY UNRESOLVED instances, using the CANONICAL, instance-aware
--      completion rule per content type (the same rule 064 unassign_assignment and
--      the assignment engine use), evaluated against EACH ROW's own assigned_at:
--        • lesson — completed iff a lesson_completions row exists at/after assigned_at.
--        • course — completed iff ALL member lessons are completed at/after assigned_at.
--        • quiz   — completed iff a PASSING attempt exists at/after assigned_at.
--      Completed rows stay active (cancelled_at NULL) → they keep resolving to
--      Completed with their scores; only not_started / in_progress / failed / partial
--      / overdue rows become 'content_archived'. The returned cancelled_assignments
--      count is now the true unresolved count.
--   2. Runs a ONE-TIME, IDEMPOTENT repair of history already damaged by the old
--      behavior: for rows cancelled with reason 'content_archived' that were in fact
--      COMPLETED before their own cancelled_at, it clears the wrongful cancellation
--      (cancelled_at / cancelled_reason / cancelled_by → NULL) so they read Completed
--      again. It touches ONLY individual rows completed-before-cancel; it never alters
--      manager_unassigned / content_missing / content_unavailable_backfill / genuinely
--      unresolved rows, and never crosses a tenant. Re-running is a no-op (repaired
--      rows no longer carry cancelled_reason='content_archived').
--
-- A repaired completed row is never actionable current work (a completed instance is
-- resolved by definition), so restoring it cannot resurface archived content in a
-- learner's To Do. Manager history shows Completed; the learner current-work selector
-- continues to exclude archived content from actionable work (unchanged).
--
-- Reuses canonical logic; adds no divergent rules. No table drops, no history
-- deletion, tenant isolation preserved. Does NOT edit any applied migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. archive_quiz — cancel only UNRESOLVED (no passing attempt >= assigned_at)
CREATE OR REPLACE FUNCTION public.archive_quiz(p_quiz_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_status text; v_cancelled int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'archive_quiz: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'archive_quiz: only managers may archive content';
  END IF;
  SELECT tenant_id, status INTO v_tenant, v_status
    FROM public.tenant_quizzes WHERE id = p_quiz_id FOR UPDATE;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'archive_quiz: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'archive_quiz: quiz not in caller tenant';
  END IF;
  IF v_status = 'archived' THEN
    RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', 'archived',
                              'cancelled_assignments', 0, 'already_archived', true);
  END IF;

  UPDATE public.tenant_quizzes SET status = 'archived', updated_at = now() WHERE id = p_quiz_id;

  -- Cancel only UNRESOLVED rows: no PASSING attempt at/after this row's assigned_at.
  -- Completed (passed) rows stay active so they keep reading Completed with scores.
  UPDATE public.tenant_assignments ta
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE ta.tenant_id = v_tenant AND ta.content_type = 'quiz' AND ta.content_id = p_quiz_id::text
      AND ta.cancelled_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.quiz_attempts qa
        WHERE qa.quiz_id = p_quiz_id
          AND qa.user_id = (ta.assigned_to->>'userId')::uuid
          AND qa.passed IS TRUE
          AND qa.created_at >= ta.assigned_at
      );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', 'archived',
                            'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_quiz(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_quiz(uuid) TO authenticated;

-- ── 2. archive_lesson — cancel only UNRESOLVED (no completion >= assigned_at) ─
CREATE OR REPLACE FUNCTION public.archive_lesson(p_lesson_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_cancelled int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'archive_lesson: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'archive_lesson: only managers may archive content';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.tenant_lessons WHERE id = p_lesson_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'archive_lesson: lesson not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'archive_lesson: lesson not in caller tenant';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.tenant_courses c
    WHERE c.tenant_id = v_tenant AND c.status = 'active' AND c.lesson_ids ? p_lesson_id::text
  ) THEN
    RAISE EXCEPTION 'archive_lesson: this lesson belongs to an active course. Remove it from the course before archiving.';
  END IF;

  UPDATE public.tenant_lessons SET status = 'archived', updated_at = now() WHERE id = p_lesson_id;

  UPDATE public.tenant_assignments ta
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE ta.tenant_id = v_tenant AND ta.content_type = 'lesson' AND ta.content_id = p_lesson_id::text
      AND ta.cancelled_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.lesson_completions lc
        WHERE lc.tenant_id = ta.tenant_id
          AND lc.lesson_id = ta.content_id
          AND lc.profile_id = (ta.assigned_to->>'userId')::uuid
          AND lc.completed_at >= ta.assigned_at
      );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN jsonb_build_object('lesson_id', p_lesson_id, 'status', 'archived', 'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_lesson(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_lesson(uuid) TO authenticated;

-- ── 3. archive_course — cancel only UNRESOLVED (not fully complete) ──────────
CREATE OR REPLACE FUNCTION public.archive_course(p_course_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_cancelled int; v_lesson_ids jsonb; v_req int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'archive_course: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'archive_course: only managers may archive content';
  END IF;
  SELECT tenant_id, lesson_ids INTO v_tenant, v_lesson_ids FROM public.tenant_courses WHERE id = p_course_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'archive_course: course not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'archive_course: course not in caller tenant';
  END IF;
  v_req := jsonb_array_length(COALESCE(v_lesson_ids, '[]'::jsonb));

  UPDATE public.tenant_courses SET status = 'archived', updated_at = now() WHERE id = p_course_id;

  -- Completed iff the course has >=1 member lesson AND the learner completed ALL of
  -- them at/after this row's assigned_at. An empty course can never be completed, so
  -- its rows are always unresolved → cancelled.
  UPDATE public.tenant_assignments ta
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE ta.tenant_id = v_tenant AND ta.content_type = 'course' AND ta.content_id = p_course_id::text
      AND ta.cancelled_at IS NULL
      AND NOT (
        v_req > 0
        AND (
          SELECT count(DISTINCT lc.lesson_id) FROM public.lesson_completions lc
          WHERE lc.tenant_id = ta.tenant_id
            AND lc.profile_id = (ta.assigned_to->>'userId')::uuid
            AND lc.lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
            AND lc.completed_at >= ta.assigned_at
        ) = v_req
      );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN jsonb_build_object('course_id', p_course_id, 'status', 'archived', 'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_course(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_course(uuid) TO authenticated;

-- ── 4. ONE-TIME idempotent repair of history damaged by the old archive_* ────
-- Restore rows wrongly cancelled 'content_archived' that were COMPLETED before their
-- own cancelled_at. Individual rows only; completion is instance-aware and strictly
-- BEFORE the cancellation timestamp (so a completion after the archive never counts).
-- Clearing cancelled_* returns the row to a resolved Completed state (manager history
-- honest); a completed instance is never actionable, so no archived content resurfaces
-- as learner current work.

-- 4a. Quizzes: a passing attempt in [assigned_at, cancelled_at).
UPDATE public.tenant_assignments ta
  SET cancelled_at = NULL, cancelled_reason = NULL, cancelled_by = NULL
  WHERE ta.content_type = 'quiz'
    AND ta.cancelled_reason = 'content_archived' AND ta.cancelled_at IS NOT NULL
    AND ta.assigned_to->>'type' = 'individual' AND (ta.assigned_to->>'userId') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.quiz_attempts qa
      WHERE qa.quiz_id = ta.content_id::uuid
        AND qa.user_id = (ta.assigned_to->>'userId')::uuid
        AND qa.passed IS TRUE
        AND qa.created_at >= ta.assigned_at
        AND qa.created_at <  ta.cancelled_at
    );

-- 4b. Lessons: a completion in [assigned_at, cancelled_at).
UPDATE public.tenant_assignments ta
  SET cancelled_at = NULL, cancelled_reason = NULL, cancelled_by = NULL
  WHERE ta.content_type = 'lesson'
    AND ta.cancelled_reason = 'content_archived' AND ta.cancelled_at IS NOT NULL
    AND ta.assigned_to->>'type' = 'individual' AND (ta.assigned_to->>'userId') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.lesson_completions lc
      WHERE lc.tenant_id = ta.tenant_id
        AND lc.lesson_id = ta.content_id
        AND lc.profile_id = (ta.assigned_to->>'userId')::uuid
        AND lc.completed_at >= ta.assigned_at
        AND lc.completed_at <  ta.cancelled_at
    );

-- 4c. Courses: ALL member lessons completed in [assigned_at, cancelled_at).
UPDATE public.tenant_assignments ta
  SET cancelled_at = NULL, cancelled_reason = NULL, cancelled_by = NULL
  WHERE ta.content_type = 'course'
    AND ta.cancelled_reason = 'content_archived' AND ta.cancelled_at IS NOT NULL
    AND ta.assigned_to->>'type' = 'individual' AND (ta.assigned_to->>'userId') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.tenant_courses c
      WHERE c.id = ta.content_id::uuid
        AND jsonb_array_length(COALESCE(c.lesson_ids,'[]'::jsonb)) > 0
        AND (
          SELECT count(DISTINCT lc.lesson_id) FROM public.lesson_completions lc
          WHERE lc.tenant_id = ta.tenant_id
            AND lc.profile_id = (ta.assigned_to->>'userId')::uuid
            AND lc.lesson_id IN (SELECT jsonb_array_elements_text(c.lesson_ids))
            AND lc.completed_at >= ta.assigned_at
            AND lc.completed_at <  ta.cancelled_at
        ) = jsonb_array_length(c.lesson_ids)
    );

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- To undo 066 (and only 066):
--   • CREATE OR REPLACE archive_quiz/archive_lesson/archive_course with the 063/065
--     bodies (cancellation UPDATE predicate `cancelled_at IS NULL` only — the buggy
--     behavior; NOT recommended).
--   • The 4a/4b/4c repair is data-corrective and history-preserving; leaving it is
--     correct. (There is no automatic re-cancel; re-archiving with the buggy RPC
--     would re-damage the same rows.)
-- Never weakens 055/056/057 confidentiality or the 065 assignability guard. Tenant
-- isolation unchanged.
