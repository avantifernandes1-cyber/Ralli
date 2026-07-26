-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 065 — Quiz Archive / Restore (ADDITIVE forward migration)
--
-- Brings quizzes to lifecycle parity with lessons/courses (063): a quiz is
-- ARCHIVED (soft, reversible) instead of hard-deleted. Archiving preserves every
-- attempt, score, XP award, result, review, immutable snapshot, tag, and
-- analytics row — it only removes the quiz from active circulation and cancels
-- its still-active assignments (history-preserving, reusing 063's cancelled_*
-- model). The permanent-DELETE path that let a manager destroy a quiz (and, via
-- it, orphan assignments/attempts) is closed at both layers, exactly as 064 did
-- for tenant_assignments.
--
-- Does NOT edit any applied migration. All object changes are CREATE OR REPLACE
-- / additive constraint swap / policy+grant tightening. Changes:
--
--   1. tenant_quizzes.status CHECK gains 'archived' (was active|inactive|draft).
--      Additive: no existing row changes; only a new legal value is permitted.
--
--   2. archive_quiz(p_quiz_id uuid) — SECURITY DEFINER. Canonical manager/admin
--      auth (is_ralli_admin() OR role IN orgAdmin,manager), tenant-scoped,
--      row-locked, idempotent. Sets status='archived' and cancels that quiz's
--      still-active assignments with a SERVER-controlled reason 'content_archived'
--      and server timestamp. Never touches attempts/scores/XP/reviews/snapshots.
--
--   3. restore_quiz(p_quiz_id uuid) — reverse of archive: status back to 'active',
--      returning the quiz to the active library and allowing fresh reassignment.
--      It deliberately does NOT reactivate the assignments archive cancelled
--      (those stay cancelled history) and does NOT rewrite any past result.
--
--   4. delete_quiz(p_quiz_id uuid) — the ONLY remaining (restricted, documented)
--      hard-delete path. Mirrors 063 delete_lesson/delete_course: it REFUSES to
--      delete a quiz that has ANY assignment (active or cancelled) or ANY attempt,
--      directing the caller to archive instead — so a hard delete can never
--      silently orphan history. The manager UI no longer calls this at all.
--
--   5. Closes the raw manager/client HARD-DELETE on tenant_quizzes: drops the
--      DELETE RLS policy and REVOKEs DELETE from authenticated/anon. With RLS on
--      and no DELETE policy, direct table DELETEs are denied regardless of grant;
--      the REVOKE is belt-and-suspenders. Tenant offboarding still cascades via
--      the tenants FK; service_role retains privileged delete (bypasses RLS).
--
--   6. One-time, idempotent, history-preserving cleanup: cancels active quiz
--      assignments whose quiz row no longer exists (reason 'content_missing').
--      Rows are preserved (never deleted), no title is fabricated, and re-running
--      is a no-op (only rows with cancelled_at IS NULL are touched).
--
-- No table drops, no history deletion, tenant isolation preserved throughout.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Extend the status CHECK to allow 'archived' (additive) ────────────────
ALTER TABLE public.tenant_quizzes DROP CONSTRAINT IF EXISTS tenant_quizzes_status_check;
ALTER TABLE public.tenant_quizzes
  ADD CONSTRAINT tenant_quizzes_status_check
  CHECK (status = ANY (ARRAY['active'::text, 'inactive'::text, 'draft'::text, 'archived'::text]));

-- ── 2. archive_quiz — archive + cancel its still-active assignments ──────────
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

  -- Resolve + lock THIS quiz row so a concurrent archive/restore serializes.
  SELECT tenant_id, status INTO v_tenant, v_status
    FROM public.tenant_quizzes WHERE id = p_quiz_id FOR UPDATE;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'archive_quiz: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'archive_quiz: quiz not in caller tenant';
  END IF;

  -- Idempotent: already archived ⇒ no-op success (never re-cancel or overwrite).
  IF v_status = 'archived' THEN
    RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', 'archived',
                              'cancelled_assignments', 0, 'already_archived', true);
  END IF;

  UPDATE public.tenant_quizzes SET status = 'archived', updated_at = now() WHERE id = p_quiz_id;

  -- Cancel every still-active assignment for this quiz — server-controlled
  -- reason + timestamp. Preserves the rows (cancelled_at/reason only).
  UPDATE public.tenant_assignments
    SET cancelled_at = now(), cancelled_reason = 'content_archived'
    WHERE tenant_id = v_tenant AND content_type = 'quiz' AND content_id = p_quiz_id::text
      AND cancelled_at IS NULL;
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;

  RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', 'archived',
                            'cancelled_assignments', v_cancelled);
END $$;
REVOKE ALL ON FUNCTION public.archive_quiz(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_quiz(uuid) TO authenticated;

-- ── 3. restore_quiz — return an archived quiz to the active library ──────────
-- Restores status to 'active' so the quiz can be assigned afresh. It does NOT
-- reactivate the assignments archive cancelled (those remain cancelled history)
-- and does NOT alter any past attempt/score/result.
CREATE OR REPLACE FUNCTION public.restore_quiz(p_quiz_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_status text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'restore_quiz: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'restore_quiz: only managers may restore content';
  END IF;

  SELECT tenant_id, status INTO v_tenant, v_status
    FROM public.tenant_quizzes WHERE id = p_quiz_id FOR UPDATE;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'restore_quiz: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'restore_quiz: quiz not in caller tenant';
  END IF;

  -- Idempotent: already active ⇒ no-op success.
  IF v_status <> 'archived' THEN
    RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', v_status, 'already_active', true);
  END IF;

  UPDATE public.tenant_quizzes SET status = 'active', updated_at = now() WHERE id = p_quiz_id;
  RETURN jsonb_build_object('quiz_id', p_quiz_id, 'status', 'active',
                            'reactivated_assignments', 0);
END $$;
REVOKE ALL ON FUNCTION public.restore_quiz(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.restore_quiz(uuid) TO authenticated;

-- ── 4. delete_quiz — restricted hard delete; refuses if referenced ───────────
-- The only remaining delete path, mirroring 063 delete_lesson/delete_course. It
-- refuses to delete a quiz that has ANY assignment (active OR cancelled — the
-- cancelled rows are history we must keep) or ANY attempt, so a hard delete can
-- never orphan assignments/attempts. Callers are told to archive instead. The
-- manager UI no longer invokes this; it exists only for a genuinely unused,
-- never-assigned quiz.
CREATE OR REPLACE FUNCTION public.delete_quiz(p_quiz_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'delete_quiz: must be authenticated'; END IF;
  v_role := public.get_my_role();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'delete_quiz: only managers may delete content';
  END IF;
  SELECT tenant_id INTO v_tenant FROM public.tenant_quizzes WHERE id = p_quiz_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'delete_quiz: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tenant = public.get_my_tenant_id()) THEN
    RAISE EXCEPTION 'delete_quiz: quiz not in caller tenant';
  END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_assignments a WHERE a.content_type='quiz' AND a.content_id=p_quiz_id::text)
     OR EXISTS (SELECT 1 FROM public.quiz_attempts qa WHERE qa.quiz_id = p_quiz_id)
  THEN
    RAISE EXCEPTION 'delete_quiz: this quiz has assignments or attempts. Archive it instead of deleting.';
  END IF;
  DELETE FROM public.tenant_quizzes WHERE id = p_quiz_id;
  RETURN jsonb_build_object('quiz_id', p_quiz_id, 'deleted', true);
END $$;
REVOKE ALL ON FUNCTION public.delete_quiz(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.delete_quiz(uuid) TO authenticated;

-- ── 5. Close the raw manager/client HARD-DELETE on tenant_quizzes ────────────
DROP POLICY IF EXISTS "tenant_quizzes_delete" ON public.tenant_quizzes;
REVOKE DELETE ON public.tenant_quizzes FROM authenticated;
REVOKE DELETE ON public.tenant_quizzes FROM anon;

-- ── 6. Defense in depth: archived quizzes leave the learner-safe catalog ─────
-- list_quizzes_for_learner() (055) gates on an assignment existing but never
-- filtered by quiz status. Home/To-Do already drop archived quizzes because
-- archive cancels their assignments (the current-work selector excludes
-- cancelled), and the client Knowledge Base filters status<>'active' — but we
-- also exclude archived quizzes here so the catalog RPC itself never surfaces
-- one. This only NARROWS results (strictly safer); the sanitized-metadata /
-- no-answer-key contract of 055/057 is preserved verbatim. Historical results
-- are unaffected: they come from quiz_attempts + get_quiz_review, not this list.
CREATE OR REPLACE FUNCTION public.list_quizzes_for_learner()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', tq.id, 'name', tq.name, 'status', tq.status,
           'tags', tq.tags, 'passing_score', tq.passing_score,
           'question_count', jsonb_array_length(COALESCE(tq.questions,'[]'::jsonb)),
           'question_revision', tq.question_revision
         ) ORDER BY tq.created_at DESC), '[]'::jsonb)
  INTO v_out
  FROM public.tenant_quizzes tq
  WHERE tq.tenant_id = v_tenant
    AND tq.status <> 'archived'
    AND public._quiz_learner_can_access(v_uid, tq.id);
  RETURN v_out;
END $$;

-- ── 7. One-time history-preserving cleanup of orphaned quiz assignments ──────
-- Cancels active quiz assignments whose quiz row no longer exists. Idempotent
-- (only untouched rows); rows are preserved, never deleted; no title fabricated.
UPDATE public.tenant_assignments a
  SET cancelled_at = now(), cancelled_reason = 'content_missing'
  WHERE a.content_type = 'quiz'
    AND a.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text = a.content_id);

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- To undo 065 (and only 065):
--   • DROP FUNCTION archive_quiz(uuid), restore_quiz(uuid), delete_quiz(uuid);
--   • CREATE OR REPLACE list_quizzes_for_learner() with the 055 body (drop the
--     `AND tq.status <> 'archived'` predicate);
--   • restore the status CHECK to active|inactive|draft ONLY AFTER re-activating
--     any 'archived' rows (else the constraint add fails);
--   • to restore the old hard-delete (NOT recommended):
--       GRANT DELETE ON public.tenant_quizzes TO authenticated;
--       CREATE POLICY "tenant_quizzes_delete" ON public.tenant_quizzes
--         FOR DELETE TO authenticated USING (
--           get_my_role() IN ('ralli_admin','orgAdmin','manager')
--           AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id()));
--   • the content_missing cancellations are data-preserving; leave them.
-- Never weakens 055/056/057 answer confidentiality. Tenant isolation unchanged.
