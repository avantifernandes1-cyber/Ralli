-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 064 — Manager Unassign (ADDITIVE forward migration)
--
-- Lets a manager/admin UNASSIGN one learner's active assignment: a soft,
-- history-preserving cancellation (reusing 063's cancelled_* model), never a
-- hard delete. Distinct from Archive (063): archive removes CONTENT and cancels
-- ALL its active assignments (reason 'content_archived'); unassign cancels ONE
-- selected learner's assignment (reason 'manager_unassigned') and attributes it
-- to the acting manager.
--
-- Does NOT edit any applied migration (017 table/policies, 034 atomic engine,
-- 036/037 eligibility, 063 lifecycle). Changes:
--
--   1. tenant_assignments.cancelled_by uuid NULL (additive) — WHO unassigned,
--      for a trustworthy audit trail. FK profiles(id) ON DELETE SET NULL, the
--      SAME retention model 017 uses for assigned_by: deleting a profile nulls
--      the attribution but never destroys the assignment-history row. Archive-
--      driven cancellations (063) leave cancelled_by NULL — they are a content
--      action, not an individual manager's, so we never falsely attribute one.
--
--   2. unassign_assignment(p_assignment_id uuid) — SECURITY DEFINER RPC. The
--      reason is SERVER-CONTROLLED ('manager_unassigned'); no free-form client
--      reason. Row-locked (FOR UPDATE), canonical manager/admin authorization,
--      tenant-scoped, instance-aware completion gate, idempotent.
--
--   3. Closes the manager/client HARD-DELETE path on tenant_assignments: drops
--      the 017 DELETE RLS policy and REVOKEs DELETE from authenticated/anon, so
--      no normal app path can destroy assignment history. Tenant offboarding
--      still cascades via the tenants FK (referential action, RLS-independent),
--      and service_role retains privileged maintenance access (bypasses RLS) —
--      the only remaining delete authority, reserved for out-of-band ops.
--
-- No table drops, no history deletion, tenant isolation preserved throughout.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Audit column: who unassigned (additive, nullable) ─────────────────────
ALTER TABLE public.tenant_assignments
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.tenant_assignments.cancelled_by IS
  'The manager/admin who unassigned this assignment (reason manager_unassigned). NULL for archive-driven or backfill cancellations (a content action, not an individual). ON DELETE SET NULL: removing a profile clears attribution but preserves the history row.';

-- ── 2. unassign_assignment — cancel ONE learner''s active assignment ─────────
-- Completion is determined with the CANONICAL, instance-aware rule per content
-- type, evaluated against THIS row''s own assigned_at (the instance):
--   • lesson — reuses public._lesson_assignment_active_user_ids(): the learner
--     is "active" (unresolved) iff there is no lesson_completions row at/after
--     the instance''s assigned_at. Not active ⇒ completed ⇒ refuse.
--   • course — reuses public._course_assignment_active_user_ids(): active iff
--     fewer than all member lessons are completed at/after assigned_at. A
--     partially-done course is still active (in_progress) and CAN be unassigned;
--     only a fully-complete course is refused.
--   • quiz   — the _quiz_..._active helper treats ANY attempt (pass OR fail) as
--     resolving active state, which is correct for reassignment eligibility but
--     would wrongly treat an in_progress (failed) quiz as done. So the
--     completed-gate uses the canonical PASS predicate (matching
--     resolveQuizAssignment''s "completed"): completed iff a PASSING attempt
--     exists at/after assigned_at. A failed-only quiz is in_progress and CAN be
--     unassigned.
-- CAN be unassigned: not_started / in_progress (incl. failed quiz, partial
-- course) / overdue. CANNOT: completed (lesson done, course fully done, quiz
-- passed). Already cancelled ⇒ idempotent no-op.
CREATE OR REPLACE FUNCTION public.unassign_assignment(p_assignment_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row        public.tenant_assignments%ROWTYPE;
  v_role       text;
  v_user_id    uuid;
  v_active     boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'unassign_assignment: must be authenticated';
  END IF;

  -- Canonical manager/admin authority — identical to 063 archive_* and the
  -- 017/026/034 assignment-management rule (includes 'manager'); ralli_admin/
  -- superadmin handled via is_ralli_admin().
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin', 'manager')) THEN
    RAISE EXCEPTION 'unassign_assignment: only managers may unassign assignments';
  END IF;

  -- (1) Resolve by exact id AND (2) lock THAT row for the transaction, so a
  -- concurrent double-unassign serializes: the second waits, then sees the row
  -- already cancelled and returns the idempotent no-op below.
  SELECT * INTO v_row FROM public.tenant_assignments
    WHERE id = p_assignment_id FOR UPDATE;

  -- (4) Honest not-found.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unassign_assignment: assignment not found';
  END IF;

  -- (3) Tenant scope — a non-ralli-admin may only act within their own tenant.
  IF NOT (public.is_ralli_admin() OR v_row.tenant_id = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'unassign_assignment: assignment is not in your tenant';
  END IF;

  -- (5) Idempotent — already cancelled (unassigned OR archived): return the
  -- EXISTING attribution unchanged. Never overwrite cancelled_by/at/reason, so
  -- the original ender and time are preserved.
  IF v_row.cancelled_at IS NOT NULL THEN
    RETURN jsonb_build_object(
      'assignment_id',   v_row.id,
      'status',          'already_cancelled',
      'cancelled_at',    v_row.cancelled_at,
      'cancelled_by',    v_row.cancelled_by,
      'cancelled_reason',v_row.cancelled_reason
    );
  END IF;

  -- Per-learner rows only. create_assignments_atomic (034) fans out EVERY
  -- team/group/all-users assignment into one individual row per learner
  -- (assigned_to.type='individual', its own id/userId/assigned_at), preserving
  -- the origin in source_type/source_id/source_label. So a team-ORIGINATED row
  -- is type='individual' and IS unassignable here — cancelling it touches only
  -- that learner and never mutates the team or a teammate's row. What we refuse
  -- is a genuine SHARED aggregate row (assigned_to.type in 'team'/'group'/'all'),
  -- where one row represents many learners and cancelling it would unassign all
  -- of them. (Such rows are legacy — the engine no longer creates them; the UI
  -- also hides Unassign on them.) (9) Never affect another learner.
  IF COALESCE(v_row.assigned_to->>'type', '') <> 'individual'
     OR (v_row.assigned_to->>'userId') IS NULL THEN
    RAISE EXCEPTION 'unassign_assignment: this is a shared team/group assignment row; only individual per-learner assignments can be unassigned';
  END IF;
  v_user_id := (v_row.assigned_to->>'userId')::uuid;

  -- (6) Canonical, instance-aware completion — scoped to THIS row''s assigned_at.
  IF v_row.content_type = 'lesson' THEN
    v_active := NOT EXISTS (
      SELECT 1 FROM public.lesson_completions lc
      WHERE lc.tenant_id = v_row.tenant_id
        AND lc.lesson_id = v_row.content_id
        AND lc.profile_id = v_user_id
        AND lc.completed_at >= v_row.assigned_at
    );
  ELSIF v_row.content_type = 'course' THEN
    -- Fully complete ⇒ not active. Reuse the canonical member-completion count.
    DECLARE v_lesson_ids jsonb; v_done int;
    BEGIN
      SELECT lesson_ids INTO v_lesson_ids FROM public.tenant_courses
        WHERE id = v_row.content_id::uuid AND tenant_id = v_row.tenant_id;
      IF v_lesson_ids IS NULL OR jsonb_array_length(v_lesson_ids) = 0 THEN
        v_active := TRUE;  -- empty/missing course can never be "completed"
      ELSE
        SELECT COUNT(DISTINCT lc.lesson_id) INTO v_done
          FROM public.lesson_completions lc
          WHERE lc.tenant_id = v_row.tenant_id
            AND lc.profile_id = v_user_id
            AND lc.lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
            AND lc.completed_at >= v_row.assigned_at;
        v_active := v_done < jsonb_array_length(v_lesson_ids);
      END IF;
    END;
  ELSIF v_row.content_type = 'quiz' THEN
    v_active := NOT EXISTS (
      SELECT 1 FROM public.quiz_attempts qa
      WHERE qa.tenant_id = v_row.tenant_id
        AND qa.quiz_id = v_row.content_id::uuid
        AND qa.user_id = v_user_id
        AND qa.passed IS TRUE
        AND qa.created_at >= v_row.assigned_at
    );
  ELSE
    RAISE EXCEPTION 'unassign_assignment: unsupported content_type %', v_row.content_type;
  END IF;

  -- (7) Refuse a completed assignment. (8) Only active/in_progress/overdue pass.
  IF NOT v_active THEN
    RAISE EXCEPTION 'unassign_assignment: cannot unassign a completed assignment';
  END IF;

  -- Cancel exactly this one row. Server-controlled reason + actor attribution.
  UPDATE public.tenant_assignments
     SET cancelled_at     = now(),
         cancelled_reason = 'manager_unassigned',
         cancelled_by     = auth.uid()
   WHERE id = v_row.id;

  RETURN jsonb_build_object(
    'assignment_id',   v_row.id,
    'status',          'unassigned',
    'cancelled_at',    now(),
    'cancelled_by',    auth.uid(),
    'cancelled_reason','manager_unassigned'
  );
END $$;

REVOKE ALL ON FUNCTION public.unassign_assignment(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.unassign_assignment(uuid) TO authenticated;

-- ── 3. Close the manager/client HARD-DELETE path on assignment history ───────
-- The 017 "tenant_assignments_delete" policy let any in-tenant manager/admin
-- DELETE assignment rows (the old client "Remove" → contentService.deleteAssignment
-- → raw DELETE). Unassign replaces it, so remove the destructive capability at
-- BOTH layers: drop the policy and revoke the table grant. With RLS enabled and
-- no DELETE policy, authenticated DELETEs are denied regardless of grant; the
-- REVOKE is belt-and-suspenders. Tenant deletion still cascades via the tenants
-- FK (ON DELETE CASCADE, a referential action not gated by RLS); service_role
-- retains delete for privileged out-of-band maintenance (bypasses RLS).
DROP POLICY IF EXISTS "tenant_assignments_delete" ON public.tenant_assignments;
REVOKE DELETE ON public.tenant_assignments FROM authenticated;
REVOKE DELETE ON public.tenant_assignments FROM anon;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
--   DROP FUNCTION IF EXISTS public.unassign_assignment(uuid);
--   -- Optional (column is harmless to keep; dropping loses only post-064 "who
--   -- unassigned" attribution, never cancelled_at/reason or any live row):
--   -- ALTER TABLE public.tenant_assignments DROP COLUMN IF EXISTS cancelled_by;
--   -- To restore the old hard-delete capability (NOT recommended):
--   -- GRANT DELETE ON public.tenant_assignments TO authenticated;
--   -- CREATE POLICY "tenant_assignments_delete" ON public.tenant_assignments
--   --   FOR DELETE TO authenticated USING (
--   --     get_my_role() IN ('ralli_admin','orgAdmin','manager')
--   --     AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id()));
