-- Repeatable tests for migration 065 (Quiz Archive / Restore).
-- Proves: a MANAGER (role 'manager') can archive a quiz — status→archived, its
-- still-active assignments cancelled with server reason 'content_archived', while
-- attempts/scores are preserved; a learner cannot; cross-tenant is refused;
-- archive is idempotent (already_archived, never re-cancels/overwrites); restore
-- returns status→active WITHOUT reactivating the cancelled assignments; restore
-- is idempotent; an archived quiz drops out of list_quizzes_for_learner even
-- though its (now-cancelled) assignment still grants access; delete_quiz refuses
-- a referenced quiz and succeeds only on a truly-unused one; the raw hard-delete
-- path is closed (grant revoked + policy dropped); the one-time orphan cleanup
-- cancels a quiz assignment whose quiz is missing with reason 'content_missing'.
-- Two tenants for isolation. One rolled-back transaction. Local only.
-- Expect "065 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000f9','authenticated','authenticated','qmgra@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000f1','authenticated','authenticated','ql1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000e8','authenticated','authenticated','qmgrb@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000f0','qta','QTA'),
 ('00000000-0000-0000-0000-0000000000e7','qtb','QTB');
UPDATE public.profiles SET role='manager', tenant_id='00000000-0000-0000-0000-0000000000f0', status='active', name='QMgrA' WHERE id='00000000-0000-0000-0000-0000000000f9';
UPDATE public.profiles SET role='user',    tenant_id='00000000-0000-0000-0000-0000000000f0', status='active', name='QL1'   WHERE id='00000000-0000-0000-0000-0000000000f1';
UPDATE public.profiles SET role='manager', tenant_id='00000000-0000-0000-0000-0000000000e7', status='active', name='QMgrB' WHERE id='00000000-0000-0000-0000-0000000000e8';

-- Quizzes (all active). QZA archived; QZB active/assigned; QZC used→delete refused; QZD unused→deletable.
INSERT INTO public.tenant_quizzes (id, tenant_id, name, status, passing_score) VALUES
 ('00000000-0000-0000-0000-0000000fa001','00000000-0000-0000-0000-0000000000f0','QZA','active',80),
 ('00000000-0000-0000-0000-0000000fa002','00000000-0000-0000-0000-0000000000f0','QZB','active',70),
 ('00000000-0000-0000-0000-0000000fa003','00000000-0000-0000-0000-0000000000f0','QZC','active',60),
 ('00000000-0000-0000-0000-0000000fa004','00000000-0000-0000-0000-0000000000f0','QZD','active',50);

-- Assignments to QL1 (individual). QZA + QZB active; QZC too (makes it referenced).
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000fb001','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f1","userName":"QL1"}'::jsonb, now()),
 ('00000000-0000-0000-0000-0000000fb002','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f1","userName":"QL1"}'::jsonb, now()),
 ('00000000-0000-0000-0000-0000000fb003','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa003','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f1","userName":"QL1"}'::jsonb, now());

-- QZA has a PASSED attempt — must be preserved across archive/restore.
INSERT INTO public.quiz_attempts (tenant_id, user_id, quiz_id, score, passed, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000fa001', 90, true, now());

-- ── 1. Manager archives QZA → status archived, assignment cancelled, attempt kept
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.archive_quiz('00000000-0000-0000-0000-0000000fa001');
  ASSERT r->>'status' = 'archived', '1. archived: '||r::text;
  ASSERT (r->>'cancelled_assignments')::int = 1, '1. one assignment cancelled: '||r::text;
  ASSERT (SELECT status FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa001') = 'archived', '1. quiz status archived';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb001') = 'content_archived', '1. server reason';
  ASSERT (SELECT cancelled_at     FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb001') IS NOT NULL, '1. cancelled_at set';
  ASSERT (SELECT count(*) FROM public.quiz_attempts WHERE quiz_id='00000000-0000-0000-0000-0000000fa001') = 1, '1. attempt preserved';
  RAISE NOTICE '1. manager archives quiz; assignment cancelled (content_archived); attempt kept: PASS';
END $$;

-- ── 2. Idempotent archive — already_archived, no re-cancel, no overwrite ─────
DO $$ DECLARE r jsonb; v_at timestamptz; BEGIN
  SELECT cancelled_at INTO v_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb001';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.archive_quiz('00000000-0000-0000-0000-0000000fa001');
  ASSERT (r->>'already_archived')::boolean = true, '2. already_archived: '||r::text;
  ASSERT (r->>'cancelled_assignments')::int = 0, '2. no re-cancel: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb001') = v_at, '2. cancelled_at unchanged';
  RAISE NOTICE '2. idempotent archive preserves original cancellation: PASS';
END $$;

-- ── 3. Learner cannot archive ────────────────────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  BEGIN PERFORM public.archive_quiz('00000000-0000-0000-0000-0000000fa002'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%only managers%', '3. learner refused: '||msg;
  ASSERT (SELECT status FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa002') = 'active', '3. QZB untouched';
  RAISE NOTICE '3. learner cannot archive: PASS';
END $$;

-- ── 4. Cross-tenant archive refused (QMgrB from QTB targets QTA quiz) ─────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e8","role":"authenticated"}',true);
  BEGIN PERFORM public.archive_quiz('00000000-0000-0000-0000-0000000fa002'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not in caller tenant%', '4. cross-tenant refused: '||msg;
  ASSERT (SELECT status FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa002') = 'active', '4. QZB still active';
  RAISE NOTICE '4. cross-tenant archive refused: PASS';
END $$;

-- ── 5. Restore QZA → active, cancelled assignment NOT reactivated ────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.restore_quiz('00000000-0000-0000-0000-0000000fa001');
  ASSERT r->>'status' = 'active', '5. restored active: '||r::text;
  ASSERT (SELECT status FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa001') = 'active', '5. quiz status active';
  -- the assignment archive cancelled stays cancelled (history, not reactivated)
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb001') IS NOT NULL, '5. assignment stays cancelled';
  RAISE NOTICE '5. restore reactivates the quiz only, never the cancelled assignments: PASS';
END $$;

-- ── 6. Idempotent restore — already_active on a non-archived quiz ────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.restore_quiz('00000000-0000-0000-0000-0000000fa002');
  ASSERT (r->>'already_active')::boolean = true, '6. already_active: '||r::text;
  RAISE NOTICE '6. idempotent restore on an active quiz is a no-op: PASS';
END $$;

-- ── 7. Archived quiz drops out of list_quizzes_for_learner (defense-in-depth) ─
-- Re-archive QZA, then confirm the learner catalog excludes it even though the
-- cancelled assignment still grants _quiz_learner_can_access. QZB (active,
-- assigned) must still appear.
DO $$ DECLARE v_list jsonb; v_ids text[]; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  PERFORM public.archive_quiz('00000000-0000-0000-0000-0000000fa001');
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f1","role":"authenticated"}',true);
  v_list := public.list_quizzes_for_learner();
  SELECT array_agg(elem->>'id') INTO v_ids FROM jsonb_array_elements(v_list) elem;
  ASSERT NOT ('00000000-0000-0000-0000-0000000fa001' = ANY(v_ids)), '7. archived QZA excluded from learner catalog';
  ASSERT ('00000000-0000-0000-0000-0000000fa002' = ANY(v_ids)), '7. active QZB still present';
  RAISE NOTICE '7. archived quiz excluded from learner-safe catalog; active quiz retained: PASS';
END $$;

-- ── 8. delete_quiz refuses a referenced quiz (has assignment/attempt) ────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  BEGIN PERFORM public.delete_quiz('00000000-0000-0000-0000-0000000fa003'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%Archive it instead%', '8. referenced delete refused: '||msg;
  ASSERT (SELECT count(*) FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa003') = 1, '8. QZC still present';
  RAISE NOTICE '8. delete_quiz refuses a referenced quiz (directs to archive): PASS';
END $$;

-- ── 9. delete_quiz succeeds on a truly-unused quiz (QZD) ─────────────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.delete_quiz('00000000-0000-0000-0000-0000000fa004');
  ASSERT (r->>'deleted')::boolean = true, '9. unused quiz deleted: '||r::text;
  ASSERT (SELECT count(*) FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa004') = 0, '9. QZD gone';
  RAISE NOTICE '9. delete_quiz deletes a genuinely unused quiz: PASS';
END $$;

-- ── 10. Raw hard-delete blocked at grant level for authenticated ─────────────
DO $$ DECLARE msg text := ''; BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  BEGIN DELETE FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa002'; EXCEPTION WHEN others THEN msg := SQLERRM; END;
  RESET ROLE;
  ASSERT msg LIKE '%permission denied%', '10. authenticated DELETE denied at grant level: '||msg;
  ASSERT (SELECT count(*) FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa002') = 1, '10. row still present';
  RAISE NOTICE '10. raw manager/client hard-delete blocked (grant revoked): PASS';
END $$;

-- ── 11. DELETE RLS policy removed ────────────────────────────────────────────
DO $$ BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='tenant_quizzes' AND policyname='tenant_quizzes_delete'
  ), '11. tenant_quizzes_delete policy dropped';
  RAISE NOTICE '11. DELETE RLS policy removed: PASS';
END $$;

-- ── 12. status CHECK admits 'archived' ───────────────────────────────────────
DO $$ BEGIN
  ASSERT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='public.tenant_quizzes'::regclass AND conname='tenant_quizzes_status_check'
      AND pg_get_constraintdef(oid) LIKE '%archived%'
  ), '12. status CHECK includes archived';
  RAISE NOTICE '12. status CHECK now allows archived: PASS';
END $$;

-- ── 13. One-time orphan cleanup cancels a missing-quiz assignment ────────────
-- With the section-7 guard live, a NEW active assignment can't be inserted
-- against a missing quiz, so we reproduce the orphan the way production got it:
-- assign while the quiz is ACTIVE (guard passes), then remove the quiz (owner
-- delete), leaving the assignment orphaned. Then run the migration's cleanup.
DO $$ DECLARE v_cnt int; BEGIN
  INSERT INTO public.tenant_quizzes (id, tenant_id, name, status) VALUES
   ('00000000-0000-0000-0000-0000000fa0de','00000000-0000-0000-0000-0000000000f0','QZORPH','active');
  INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
   ('00000000-0000-0000-0000-0000000fb099','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa0de','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f1","userName":"QL1"}'::jsonb, now());
  DELETE FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000fa0de';  -- quiz gone; assignment now orphaned
  UPDATE public.tenant_assignments a
    SET cancelled_at = now(), cancelled_reason = 'content_missing'
    WHERE a.content_type = 'quiz' AND a.cancelled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text = a.content_id);
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb099') = 'content_missing', '13. orphan cancelled content_missing';
  ASSERT (SELECT count(*) FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb099') = 1, '13. orphan row preserved (not deleted)';
  UPDATE public.tenant_assignments a
    SET cancelled_at = now(), cancelled_reason = 'content_missing'
    WHERE a.content_type = 'quiz' AND a.cancelled_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text = a.content_id);
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  ASSERT v_cnt = 0, '13. cleanup idempotent (no rows on re-run)';
  RAISE NOTICE '13. orphan cleanup cancels missing-quiz assignment (content_missing), preserved + idempotent: PASS';
END $$;

-- ── Guard fixtures: lesson/course/quiz in active + non-active + cross-tenant ──
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000f2','authenticated','authenticated','ql2@t.test',now(),now());
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000f0', status='active', name='QL2' WHERE id='00000000-0000-0000-0000-0000000000f2';
INSERT INTO public.tenant_lessons (id, tenant_id, title, status) VALUES
 ('00000000-0000-0000-0000-0000000aa001','00000000-0000-0000-0000-0000000000f0','LES_ACT','active'),
 ('00000000-0000-0000-0000-0000000aa002','00000000-0000-0000-0000-0000000000f0','LES_ARC','archived'),
 ('00000000-0000-0000-0000-0000000aa003','00000000-0000-0000-0000-0000000000e7','LES_XT','active');   -- other tenant
INSERT INTO public.tenant_courses (id, tenant_id, title, lesson_ids, status) VALUES
 ('00000000-0000-0000-0000-0000000ca001','00000000-0000-0000-0000-0000000000f0','CRS_ACT','[]'::jsonb,'active'),
 ('00000000-0000-0000-0000-0000000ca002','00000000-0000-0000-0000-0000000000f0','CRS_ARC','[]'::jsonb,'archived');
INSERT INTO public.tenant_quizzes (id, tenant_id, name, status) VALUES
 ('00000000-0000-0000-0000-0000000fa010','00000000-0000-0000-0000-0000000000f0','QZ_DRAFT','draft'),
 ('00000000-0000-0000-0000-0000000fa011','00000000-0000-0000-0000-0000000000f0','QZ_INACT','inactive'),
 ('00000000-0000-0000-0000-0000000fa012','00000000-0000-0000-0000-0000000000e7','QZ_XT','active');   -- other tenant

-- Helper: attempt a direct ACTIVE assignment INSERT; returns '' on success or SQLERRM.
CREATE OR REPLACE FUNCTION pg_temp.try_assign(p_type text, p_content text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE msg text := ''; BEGIN
  INSERT INTO public.tenant_assignments (tenant_id, content_type, content_id, assigned_to, assigned_at)
    VALUES ('00000000-0000-0000-0000-0000000000f0', p_type, p_content,
            '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f2","userName":"QL2"}'::jsonb, now());
  RETURN '';  -- inserted (guard allowed)
EXCEPTION WHEN others THEN RETURN SQLERRM; END $$;

-- ── 14. LESSON assignability ─────────────────────────────────────────────────
DO $$ BEGIN
  ASSERT pg_temp.try_assign('lesson','00000000-0000-0000-0000-0000000aa001') = '', '14a. active lesson assignable';
  ASSERT pg_temp.try_assign('lesson','00000000-0000-0000-0000-0000000aa002') LIKE '%assignment blocked%', '14b. archived lesson blocked';
  ASSERT pg_temp.try_assign('lesson','00000000-0000-0000-0000-00000000beef') LIKE '%assignment blocked%', '14c. missing lesson blocked';
  ASSERT pg_temp.try_assign('lesson','00000000-0000-0000-0000-0000000aa003') LIKE '%assignment blocked%', '14d. cross-tenant lesson blocked';
  RAISE NOTICE '14. lesson: active assignable; archived/missing/cross-tenant blocked: PASS';
END $$;

-- ── 15. COURSE assignability ─────────────────────────────────────────────────
DO $$ BEGIN
  ASSERT pg_temp.try_assign('course','00000000-0000-0000-0000-0000000ca001') = '', '15a. active course assignable';
  ASSERT pg_temp.try_assign('course','00000000-0000-0000-0000-0000000ca002') LIKE '%assignment blocked%', '15b. archived course blocked';
  ASSERT pg_temp.try_assign('course','00000000-0000-0000-0000-00000000beef') LIKE '%assignment blocked%', '15c. missing course blocked';
  RAISE NOTICE '15. course: active assignable; archived/missing blocked: PASS';
END $$;

-- ── 16. QUIZ assignability (active / archived / draft / inactive / missing / xt)
DO $$ BEGIN
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-0000000fa002') = '', '16a. active quiz assignable';        -- QZB active
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-0000000fa001') LIKE '%assignment blocked%', '16b. archived quiz blocked';  -- QZA archived
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-0000000fa010') LIKE '%assignment blocked%', '16c. draft quiz blocked';
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-0000000fa011') LIKE '%assignment blocked%', '16d. inactive quiz blocked';
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-00000000beef') LIKE '%assignment blocked%', '16e. missing quiz blocked';
  ASSERT pg_temp.try_assign('quiz','00000000-0000-0000-0000-0000000fa012') LIKE '%assignment blocked%', '16f. cross-tenant quiz blocked';
  RAISE NOTICE '16. quiz: active assignable; archived/draft/inactive/missing/cross-tenant blocked: PASS';
END $$;

-- ── 17. History carve-out — a pre-CANCELLED row to archived/missing content is
--       insertable (controlled migration/history), never gated by the guard ───
DO $$ BEGIN
  INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at, cancelled_at, cancelled_reason) VALUES
   ('00000000-0000-0000-0000-0000000fb0c1','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa001',
    '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f2","userName":"QL2"}'::jsonb, now(), now(), 'content_archived'),
   ('00000000-0000-0000-0000-0000000fb0c2','00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-00000000beef',
    '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000f2","userName":"QL2"}'::jsonb, now(), now(), 'content_missing');
  ASSERT (SELECT count(*) FROM public.tenant_assignments WHERE id IN ('00000000-0000-0000-0000-0000000fb0c1','00000000-0000-0000-0000-0000000fb0c2')) = 2, '17. pre-cancelled history rows inserted';
  RAISE NOTICE '17. history carve-out: pre-cancelled rows to archived/missing content remain insertable: PASS';
END $$;

-- ── 18. Engine path — create_assignments_atomic honours the guard ────────────
-- Active quiz via the RPC succeeds; archived quiz via the RPC is rejected (proves
-- the guard fires inside the assignment engine, not only on direct inserts).
DO $$ DECLARE r jsonb; msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000f9","role":"authenticated"}',true);
  r := public.create_assignments_atomic(
        '00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa003',
        '[{"userId":"00000000-0000-0000-0000-0000000000f2","userName":"QL2"}]'::jsonb,
        'Open', false, '00000000-0000-0000-0000-0000000000f9', 'individual', NULL, NULL);   -- QZC active
  ASSERT (r->>'assignedCount')::int = 1, '18a. active quiz assigned via engine: '||r::text;
  BEGIN
    PERFORM public.create_assignments_atomic(
      '00000000-0000-0000-0000-0000000000f0','quiz','00000000-0000-0000-0000-0000000fa001',
      '[{"userId":"00000000-0000-0000-0000-0000000000f2","userName":"QL2"}]'::jsonb,
      'Open', false, '00000000-0000-0000-0000-0000000000f9', 'individual', NULL, NULL);      -- QZA archived
  EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%assignment blocked%', '18b. engine rejects archived quiz: '||msg;
  RAISE NOTICE '18. create_assignments_atomic: active assigns, archived rejected (guard fires in-engine): PASS';
END $$;

DO $$ BEGIN RAISE NOTICE '065 ALL TESTS PASSED'; END $$;

ROLLBACK;
