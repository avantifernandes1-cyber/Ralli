-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 063 — Learn lifecycle integrity (ADDITIVE forward migration)
--
-- Closes the audited Learn integrity gaps without editing applied migrations
-- (034 atomic engine, 036/037 eligibility, 056/057 confidentiality, 058-062):
--
--   1. Archiving content now CANCELS its active assignments (soft, reversible,
--      history-preserving) instead of leaving them stranded — invisible to the
--      learner but perpetually "active/overdue" for the manager.
--   2. A cancelled assignment (cancelled_at set) never counts as active/overdue/
--      pending and never blocks reassignment. Restoring content does NOT reactivate
--      old cancelled assignments; the manager assigns again.
--   3. A lesson that belongs to an ACTIVE course cannot be archived (remove it from
--      the course first) — so an active course can never silently contain an
--      archived/missing member; the course's lesson_ids stays the one canonical
--      completion denominator.
--   4. Hard delete of a referenced lesson/course is blocked (assignments,
--      completions, or course membership) so references are never silently orphaned.
--   5. Lesson-completion tenant identity is server-authoritative: derived from the
--      authenticated learner + the referenced lesson; cross-tenant/missing-content
--      completions are rejected; a browser-supplied tenant_id is never trusted.
--   6. A one-time, idempotent, history-preserving cleanup cancels the confirmed
--      stranded/orphaned assignments (content already archived or deleted).
--
-- Tenant isolation preserved throughout. No table drops, no history deletion.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Cancellation marker on assignments (additive, nullable) ───────────────
ALTER TABLE public.tenant_assignments
  ADD COLUMN IF NOT EXISTS cancelled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_reason text;

COMMENT ON COLUMN public.tenant_assignments.cancelled_at IS
  'When set, the assignment is cancelled (content archived/removed): preserved for history, never active/overdue/pending, never blocks reassignment.';

-- ── 2. Eligibility helpers ignore cancelled rows ─────────────────────────────
-- Faithful supersets of 036/037: identical bodies + `AND ta.cancelled_at IS NULL`
-- in the targeted CTE. create_assignments_atomic (034) delegates to these, so
-- reassignment correctly ignores cancelled assignments with no change to that RPC.

CREATE OR REPLACE FUNCTION public._quiz_assignment_active_user_ids(p_tenant_id uuid, p_content_id text)
RETURNS SETOF uuid LANGUAGE sql STABLE
AS $function$
  WITH targeted AS (
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'quiz'
      AND ta.content_id = p_content_id
      AND ta.cancelled_at IS NULL
  ),
  latest AS (
    SELECT uid, MAX(assigned_at) AS latest_assigned_at FROM targeted GROUP BY uid
  )
  SELECT l.uid FROM latest l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.quiz_attempts qa
    WHERE qa.tenant_id = p_tenant_id AND qa.quiz_id = p_content_id::UUID
      AND qa.user_id = l.uid AND qa.created_at >= l.latest_assigned_at
  );
$function$;

CREATE OR REPLACE FUNCTION public._lesson_assignment_active_user_ids(p_tenant_id uuid, p_content_id text)
RETURNS SETOF uuid LANGUAGE sql STABLE
AS $function$
  WITH targeted AS (
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'lesson'
      AND ta.content_id = p_content_id
      AND ta.cancelled_at IS NULL
  ),
  latest AS (
    SELECT uid, MAX(assigned_at) AS latest_assigned_at FROM targeted GROUP BY uid
  )
  SELECT l.uid FROM latest l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.lesson_completions lc
    WHERE lc.tenant_id = p_tenant_id AND lc.lesson_id = p_content_id
      AND lc.profile_id = l.uid AND lc.completed_at >= l.latest_assigned_at
  );
$function$;

CREATE OR REPLACE FUNCTION public._course_assignment_active_user_ids(p_tenant_id uuid, p_content_id text)
RETURNS SETOF uuid LANGUAGE plpgsql STABLE
AS $function$
DECLARE v_lesson_ids JSONB; v_lesson_count INT;
BEGIN
  SELECT lesson_ids INTO v_lesson_ids
    FROM public.tenant_courses WHERE id = p_content_id::UUID AND tenant_id = p_tenant_id;
  IF v_lesson_ids IS NULL OR jsonb_array_length(v_lesson_ids) = 0 THEN RETURN; END IF;
  v_lesson_count := jsonb_array_length(v_lesson_ids);

  RETURN QUERY
  WITH targeted AS (
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'course'
      AND ta.content_id = p_content_id
      AND ta.cancelled_at IS NULL
  ),
  latest AS (
    SELECT uid, MAX(assigned_at) AS latest_assigned_at FROM targeted GROUP BY uid
  )
  SELECT l.uid FROM latest l
  WHERE (
    SELECT COUNT(DISTINCT lc.lesson_id)
    FROM public.lesson_completions lc
    WHERE lc.tenant_id = p_tenant_id AND lc.profile_id = l.uid
      AND lc.lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
      AND lc.completed_at >= l.latest_assigned_at
  ) < v_lesson_count;
END;
$function$;

-- ── 3. archive_lesson — block if in an active course; else archive + cancel ──
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
  UPDATE public.tenant_assignments
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE tenant_id = v_tenant AND content_type = 'lesson' AND content_id = p_lesson_id::text
      AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN jsonb_build_object('lesson_id', p_lesson_id, 'status', 'archived', 'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_lesson(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_lesson(uuid) TO authenticated;

-- ── 4. archive_course — archive + cancel its active course assignments ───────
CREATE OR REPLACE FUNCTION public.archive_course(p_course_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_cancelled int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'archive_course: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'archive_course: only managers may archive content';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.tenant_courses WHERE id = p_course_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'archive_course: course not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'archive_course: course not in caller tenant';
  END IF;
  UPDATE public.tenant_courses SET status = 'archived', updated_at = now() WHERE id = p_course_id;
  UPDATE public.tenant_assignments
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE tenant_id = v_tenant AND content_type = 'course' AND content_id = p_course_id::text
      AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  RETURN jsonb_build_object('course_id', p_course_id, 'status', 'archived', 'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_course(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_course(uuid) TO authenticated;

-- ── 5. delete_lesson / delete_course — block if referenced (no silent orphan) ─
CREATE OR REPLACE FUNCTION public.delete_lesson(p_lesson_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'delete_lesson: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'delete_lesson: only managers may delete content';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.tenant_lessons WHERE id = p_lesson_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'delete_lesson: lesson not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'delete_lesson: lesson not in caller tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_assignments a WHERE a.content_type='lesson' AND a.content_id=p_lesson_id::text)
     OR EXISTS (SELECT 1 FROM public.lesson_completions lc WHERE lc.lesson_id=p_lesson_id::text)
     OR EXISTS (SELECT 1 FROM public.tenant_courses c WHERE c.tenant_id=v_tenant AND c.lesson_ids ? p_lesson_id::text)
  THEN
    RAISE EXCEPTION 'delete_lesson: this lesson has assignments, completions, or course references. Archive it instead of deleting.';
  END IF;
  DELETE FROM public.tenant_lessons WHERE id = p_lesson_id;
  RETURN jsonb_build_object('lesson_id', p_lesson_id, 'deleted', true);
END $$;
REVOKE ALL ON FUNCTION public.delete_lesson(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_lesson(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.delete_course(p_course_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'delete_course: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'delete_course: only managers may delete content';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.tenant_courses WHERE id = p_course_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'delete_course: course not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'delete_course: course not in caller tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_assignments a WHERE a.content_type='course' AND a.content_id=p_course_id::text) THEN
    RAISE EXCEPTION 'delete_course: this course has assignments. Archive it instead of deleting.';
  END IF;
  DELETE FROM public.tenant_courses WHERE id = p_course_id;
  RETURN jsonb_build_object('course_id', p_course_id, 'deleted', true);
END $$;
REVOKE ALL ON FUNCTION public.delete_course(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_course(uuid) TO authenticated;

-- ── 6. mark_lesson_complete — server-authoritative tenant identity ───────────
-- Derives tenant from the caller's profile AND the referenced lesson; rejects a
-- cross-tenant or missing-content completion. Reuses the single (profile,lesson)
-- completion row; browser-supplied tenant_id is never trusted.
CREATE OR REPLACE FUNCTION public.mark_lesson_complete(p_lesson_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_lesson_tenant uuid; v_lesson_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'mark_lesson_complete: must be authenticated'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'mark_lesson_complete: caller has no active tenant'; END IF;
  SELECT tenant_id, status INTO v_lesson_tenant, v_lesson_status
    FROM public.tenant_lessons WHERE id = p_lesson_id;
  IF v_lesson_tenant IS NULL THEN RAISE EXCEPTION 'mark_lesson_complete: lesson not found'; END IF;
  IF v_lesson_tenant <> v_tenant THEN RAISE EXCEPTION 'mark_lesson_complete: cross-tenant completion rejected'; END IF;

  INSERT INTO public.lesson_completions (profile_id, lesson_id, tenant_id, completed_at)
    VALUES (v_uid, p_lesson_id::text, v_tenant, now())
    ON CONFLICT (profile_id, lesson_id)
      DO UPDATE SET completed_at = now(), tenant_id = EXCLUDED.tenant_id;
  RETURN jsonb_build_object('lesson_id', p_lesson_id, 'tenant_id', v_tenant, 'completed_at', now());
END $$;
REVOKE ALL ON FUNCTION public.mark_lesson_complete(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.mark_lesson_complete(uuid) TO authenticated;

-- ── 7. Server-authoritative tenant on the direct completion path (RLS) ───────
-- Even outside the RPC, a completion's tenant_id must equal the caller's tenant
-- (rejects a browser-forged/null tenant_id). profile_id self-check unchanged.
DROP POLICY IF EXISTS lesson_completions_insert ON public.lesson_completions;
CREATE POLICY lesson_completions_insert ON public.lesson_completions
  FOR INSERT TO authenticated
  WITH CHECK (profile_id = auth.uid() AND tenant_id = public.get_my_tenant_id());

-- ── 8. One-time history-preserving cleanup of stranded/orphaned assignments ──
-- Cancels lesson/course assignments whose content is archived or no longer exists.
-- Idempotent (only untouched rows); rows are preserved, never deleted.
UPDATE public.tenant_assignments a
  SET cancelled_at = now(), cancelled_reason = 'content_unavailable_backfill'
  WHERE a.cancelled_at IS NULL
    AND (
      (a.content_type = 'lesson'
        AND NOT EXISTS (SELECT 1 FROM public.tenant_lessons l WHERE l.id::text = a.content_id AND l.status = 'active'))
      OR
      (a.content_type = 'course'
        AND NOT EXISTS (SELECT 1 FROM public.tenant_courses c WHERE c.id::text = a.content_id AND c.status = 'active'))
    );

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- To undo 063 (and only 063):
--   • CREATE OR REPLACE the three _*_assignment_active_user_ids helpers with the
--     036/037 bodies (drop the `AND ta.cancelled_at IS NULL` predicate);
--   • DROP FUNCTION archive_lesson(uuid), archive_course(uuid), delete_lesson(uuid),
--     delete_course(uuid), mark_lesson_complete(uuid);
--   • restore the 017 lesson_completions_insert policy (WITH CHECK profile_id = auth.uid());
--   • the cancelled_at/cancelled_reason columns and the backfill are data-preserving
--     and can be left in place, or the columns dropped if truly reverting.
-- Never weakens 056/057. Tenant isolation unchanged.
