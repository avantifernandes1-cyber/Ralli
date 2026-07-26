-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 065 — Quiz Archive / Restore + canonical content-assignability guard
-- (ADDITIVE forward migration)
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
-- It ALSO closes an authoritative-layer integrity gap that predates this work and
-- affects ALL Learn content (lesson/course/quiz), not just quizzes: an assignment
-- could be created against archived/missing/cross-tenant content, and — because
-- archive_* and create_assignments_atomic take DIFFERENT locks (archive locks the
-- content row; create_assignments_atomic takes only an advisory lock and never
-- checks content status) — a concurrent assign could slip a NEW active assignment
-- in AFTER an archive's cancellation update, defeating the archive. Section 7 adds
-- ONE canonical BEFORE INSERT guard on tenant_assignments that verifies the
-- referenced content exists, is in the assignment's tenant, and is 'active',
-- taking the SAME content-row lock the archive/restore RPCs use so the two
-- operations serialize. It applies to every insert path (create_assignments_atomic,
-- direct authenticated insert, any future server path) without duplicating the
-- assignment engine.
--
-- Does NOT edit any applied migration. All object changes are CREATE OR REPLACE
-- / additive constraint swap / policy+grant tightening / a new trigger. Changes:
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
--   6. Defense in depth: list_quizzes_for_learner() excludes archived quizzes so
--      the learner-safe catalog RPC itself never surfaces one (055/057 answer
--      confidentiality otherwise reproduced verbatim; this only NARROWS results).
--
--   7. Canonical content-assignability guard: _assert_assignment_content_assignable()
--      + a BEFORE INSERT trigger on tenant_assignments. For EVERY new lesson/course/
--      quiz row (cancelled_at NULL or not — no client-column carve-out) it row-locks
--      the referenced content FOR SHARE and requires it to EXIST, be in NEW.tenant_id,
--      and be status='active' — else it rejects (missing/archived/inactive/draft/
--      cross-tenant). FOR SHARE conflicts with the archive/restore row locks
--      (archive_quiz/restore_quiz use FOR UPDATE; archive_lesson/archive_course
--      issue an UPDATE = FOR NO KEY UPDATE), so an assign serializes with an
--      in-flight archive/restore of the same content, while two concurrent assigns
--      (FOR SHARE vs FOR SHARE) don't block each other — preserving
--      create_assignments_atomic's advisory-lock duplicate-active protection.
--
--   8. Closes the raw client INSERT path on tenant_assignments: drops the 017 INSERT
--      RLS policy and REVOKEs INSERT from authenticated/anon, so the ONLY assignment-
--      creation path is create_assignments_atomic (SECURITY DEFINER, owner postgres/
--      bypassrls) — which alone enforces instance-aware duplicate-active/eligibility
--      rules. service_role keeps INSERT for controlled maintenance.
--
--   9. One-time, idempotent, history-preserving cleanup: cancels active quiz
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

-- ── 7. Canonical content-assignability guard (lesson / course / quiz) ────────
-- ONE authoritative BEFORE INSERT check on tenant_assignments, so an active
-- assignment can never be created against content that is missing, archived,
-- inactive, draft, or in another tenant — no matter the insert path
-- (create_assignments_atomic, a direct authenticated insert, or a future server
-- path). This does NOT duplicate the assignment engine; it complements it.
--
-- CONCURRENCY CONTRACT. The guard takes a SHARED row lock (FOR SHARE) on the
-- exact content row. The lifecycle RPCs take a conflicting lock on that same row
-- (archive_quiz/restore_quiz: explicit FOR UPDATE; archive_lesson/archive_course:
-- an UPDATE, i.e. FOR NO KEY UPDATE). FOR SHARE conflicts with both, so:
--   • assign-first  → archive waits for the insert's txn, then its cancellation
--                     UPDATE (WHERE cancelled_at IS NULL) sees and cancels the
--                     just-created row — no active assignment survives an archive;
--   • archive-first → the insert waits for the archive's txn, then re-reads the
--                     content as non-active and is REJECTED;
--   • restore-first → the insert waits, then sees status='active' and SUCCEEDS.
-- Two concurrent assigns (FOR SHARE vs FOR SHARE) are compatible, so they don't
-- block each other and create_assignments_atomic's advisory-lock + eligibility
-- duplicate-active protection is unchanged. No deadlock with that advisory lock:
-- the archive RPCs never take it, and the guard's FOR SHARE is only ever awaited
-- behind the archive's content-row lock — there is no lock cycle.
--
-- NO cancelled_at CARVE-OUT. The guard fires for EVERY inserted row regardless of
-- cancelled_at, because that column is client-supplied: exempting pre-cancelled
-- rows would let anyone with INSERT fabricate "historical" assignments against
-- missing/archived/inactive/draft/cross-tenant content. Audited: nothing legitimate
-- inserts a pre-cancelled row (create_assignments_atomic inserts only live rows; the
-- 063/065 cleanups are UPDATEs this INSERT-only trigger never sees). Combined with
-- §8 (raw client INSERT closed), the sole assignment-creation path is the
-- create_assignments_atomic RPC. A genuine future historical import is an explicitly
-- privileged maintenance action (e.g. owner-level ALTER TABLE … DISABLE TRIGGER),
-- never a client-controlled column value.
CREATE OR REPLACE FUNCTION public._assert_assignment_content_assignable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_status text;
BEGIN
  -- NO status/cancelled carve-out. EVERY new row — cancelled_at NULL or not — is
  -- validated, because cancelled_at is a client-supplied column: a carve-out on it
  -- would let anyone with INSERT fabricate "historical" assignment rows against
  -- missing/archived/inactive/draft/cross-tenant content. (Audited: no migration or
  -- RPC ever inserts a pre-cancelled row; create_assignments_atomic inserts only
  -- cancelled_at NULL live rows, and the 063/065 cleanups are UPDATEs that this
  -- INSERT-only trigger never sees, so nothing legitimate needs an exemption. A
  -- genuine future historical import must use a separate, explicitly privileged
  -- maintenance path — e.g. ALTER TABLE … DISABLE TRIGGER as owner — never a
  -- client-controlled column value.)
  --
  -- LOCK-THEN-CHECK. The FOR SHARE lock is taken on the content row by
  -- (id, tenant) with NO status predicate, so it matches — and therefore locks —
  -- the row whatever its CURRENT status. That is essential for serializing with
  -- a concurrent RESTORE (archived→active): a status='active' predicate would
  -- match zero rows while the row is still archived in this reader's snapshot,
  -- lock nothing, and let the assignment slip through. We read the status back
  -- and evaluate it only AFTER the lock is granted (i.e. after any in-flight
  -- archive/restore of this row has committed).
  IF NEW.content_type = 'quiz' THEN
    SELECT q.status INTO v_status FROM public.tenant_quizzes q
      WHERE q.id::text = NEW.content_id AND q.tenant_id = NEW.tenant_id
      FOR SHARE;
  ELSIF NEW.content_type = 'lesson' THEN
    SELECT l.status INTO v_status FROM public.tenant_lessons l
      WHERE l.id::text = NEW.content_id AND l.tenant_id = NEW.tenant_id
      FOR SHARE;
  ELSIF NEW.content_type = 'course' THEN
    SELECT c.status INTO v_status FROM public.tenant_courses c
      WHERE c.id::text = NEW.content_id AND c.tenant_id = NEW.tenant_id
      FOR SHARE;
  ELSE
    -- create_assignments_atomic already restricts content_type to the three Learn
    -- types; any other value is a no-op passthrough until the guard is extended.
    RETURN NEW;
  END IF;

  -- v_status IS NULL  → no row for (id, tenant): missing or cross-tenant.
  -- v_status <> 'active' → archived / inactive / draft. Both are rejected.
  IF v_status IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION
      'assignment blocked: % % is not an active in-tenant % (missing, archived, inactive, draft, or cross-tenant)',
      NEW.content_type, NEW.content_id, NEW.content_type
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public._assert_assignment_content_assignable() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS trg_assert_assignment_content_assignable ON public.tenant_assignments;
CREATE TRIGGER trg_assert_assignment_content_assignable
  BEFORE INSERT ON public.tenant_assignments
  FOR EACH ROW EXECUTE FUNCTION public._assert_assignment_content_assignable();

-- ── 8. Close the raw client INSERT path on tenant_assignments ────────────────
-- The section-7 trigger enforces CONTENT assignability, but the instance-aware
-- duplicate-active / reassignment-eligibility rules live in create_assignments_atomic
-- (034/036/037): advisory lock keyed on (tenant, content) + the _*_active_user_ids
-- helpers. A raw client INSERT bypasses those, so a manager with direct INSERT
-- could create duplicate active assignments the engine would have skipped. Since
-- EVERY legitimate assignment write already goes through create_assignments_atomic
-- (audited: no JS raw insert; the only INSERT INTO tenant_assignments in the schema
-- is inside that RPC), we remove the raw path exactly as 064 did for DELETE:
--   • drop the 017 INSERT RLS policy, and
--   • REVOKE INSERT from authenticated/anon.
-- create_assignments_atomic is SECURITY DEFINER owned by `postgres` (rolbypassrls),
-- and the table does not FORCE row security, so the RPC keeps inserting unaffected
-- by either change. service_role retains INSERT for controlled out-of-band
-- maintenance (bypasses RLS). With RLS on and no INSERT policy, an authenticated
-- direct INSERT is denied regardless of grant; the REVOKE is belt-and-suspenders.
DROP POLICY IF EXISTS "tenant_assignments_insert" ON public.tenant_assignments;
REVOKE INSERT ON public.tenant_assignments FROM authenticated;
REVOKE INSERT ON public.tenant_assignments FROM anon;

-- ── 9. One-time history-preserving cleanup of orphaned quiz assignments ──────
-- Cancels active quiz assignments whose quiz row no longer exists. Idempotent
-- (only untouched rows); rows are preserved, never deleted; no title fabricated.
-- Runs as the migration owner (bypasses the section-7 trigger anyway, since it is
-- an UPDATE, not an INSERT).
UPDATE public.tenant_assignments a
  SET cancelled_at = now(), cancelled_reason = 'content_missing'
  WHERE a.content_type = 'quiz'
    AND a.cancelled_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text = a.content_id);

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- To undo 065 (and only 065):
--   • DROP TRIGGER trg_assert_assignment_content_assignable ON public.tenant_assignments;
--     DROP FUNCTION public._assert_assignment_content_assignable();
--     (NOTE: dropping the guard re-opens the archive-vs-assign race — undo it only
--      alongside a replacement guard, never on its own.)
--   • to reopen the raw client INSERT (NOT recommended — reopens the duplicate-active
--     bypass): GRANT INSERT ON public.tenant_assignments TO authenticated;
--     CREATE POLICY "tenant_assignments_insert" ON public.tenant_assignments
--       FOR INSERT TO authenticated WITH CHECK (
--         get_my_role() IN ('ralli_admin','orgAdmin','manager')
--         AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id()));
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
