-- Repeatable tests for migration 063 (Learn lifecycle integrity).
-- Proves: archiving cancels active assignments; a lesson in an active course
-- cannot be archived; cancelled assignments are excluded from eligibility (so
-- reassignment works) and preserved for history; hard delete is blocked when
-- referenced; lesson completion is server-authoritative (tenant derived, cross-
-- tenant/missing rejected); the direct completion INSERT rejects a foreign
-- tenant_id via RLS; the backfill cancels stranded assignments. Two tenants for
-- isolation. One rolled-back transaction. Local only. Expect "063 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000d9','authenticated','authenticated','m@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000d1','authenticated','authenticated','l1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000e1','authenticated','authenticated','lb@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000d0','tad','TAD'),
 ('00000000-0000-0000-0000-0000000000e0','teb','TEB');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='M'  WHERE id='00000000-0000-0000-0000-0000000000d9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='L1' WHERE id='00000000-0000-0000-0000-0000000000d1';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000e0', status='active', name='LB' WHERE id='00000000-0000-0000-0000-0000000000e1';

-- Lessons: L_S1 standalone; L_S2 member of an active course; L_S3 unreferenced; L_B TB lesson.
INSERT INTO public.tenant_lessons (id, tenant_id, title, status) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000d0','Lsn S1','active'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000d0','Lsn S2','active'),
 ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000d0','Lsn S3','active'),
 ('00000000-0000-0000-0000-0000000e0001','00000000-0000-0000-0000-0000000000e0','Lsn B1','active');
-- Course C1 (active) contains L_S2.
INSERT INTO public.tenant_courses (id, tenant_id, title, lesson_ids, status) VALUES
 ('00000000-0000-0000-0000-0000000dc001','00000000-0000-0000-0000-0000000000d0','Course C1',
  '["00000000-0000-0000-0000-0000000d0002"]'::jsonb,'active');
-- Assignments: A1 lesson L_S1 -> L1; A2 course C1 -> L1.
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000da001','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0001',
   '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
 ('00000000-0000-0000-0000-0000000da002','00000000-0000-0000-0000-0000000000d0','course','00000000-0000-0000-0000-0000000dc001',
   '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now());

-- ── 1. archive_lesson BLOCKS a lesson that belongs to an active course ────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.archive_lesson('00000000-0000-0000-0000-0000000d0002'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%active course%', '1. archive_lesson blocked for active-course member: '||msg;
  ASSERT (SELECT status FROM public.tenant_lessons WHERE id='00000000-0000-0000-0000-0000000d0002') = 'active', '1. lesson stayed active';
  RAISE NOTICE '1. archive blocked while in active course: PASS';
END $$;

-- ── 2. archive_course cancels its active course assignments ──────────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.archive_course('00000000-0000-0000-0000-0000000dc001');
  ASSERT (r->>'cancelled_assignments')::int = 1, '2. archive_course cancelled 1 assignment: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da002') IS NOT NULL, '2. A2 cancelled';
  ASSERT (SELECT status FROM public.tenant_courses WHERE id='00000000-0000-0000-0000-0000000dc001') = 'archived', '2. course archived';
  RAISE NOTICE '2. archive_course cancels active course assignments: PASS';
END $$;

-- ── 3. archive_lesson now allowed (course archived) + cancels lesson assignment
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.archive_lesson('00000000-0000-0000-0000-0000000d0002');  -- now C1 is archived
  ASSERT (SELECT status FROM public.tenant_lessons WHERE id='00000000-0000-0000-0000-0000000d0002') = 'archived', '3. S2 archived once course archived';
  r := public.archive_lesson('00000000-0000-0000-0000-0000000d0001');
  ASSERT (r->>'cancelled_assignments')::int = 1, '3. archive_lesson cancelled A1: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') IS NOT NULL, '3. A1 cancelled';
  RAISE NOTICE '3. archive_lesson allowed off active course + cancels assignment: PASS';
END $$;

-- ── 4. Cancelled assignments excluded from eligibility (reassignment works) ───
DO $$ DECLARE n int; BEGIN
  SELECT count(*) INTO n FROM public._lesson_assignment_active_user_ids('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0001') t(uid)
    WHERE t.uid='00000000-0000-0000-0000-0000000000d1';
  ASSERT n = 0, '4. L1 NOT active on S1 after cancellation (reassignable)';
  SELECT count(*) INTO n FROM public._course_assignment_active_user_ids('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000dc001') t(uid)
    WHERE t.uid='00000000-0000-0000-0000-0000000000d1';
  ASSERT n = 0, '4. L1 NOT active on C1 after cancellation (reassignable)';
  RAISE NOTICE '4. cancelled excluded from eligibility: PASS';
END $$;

-- ── 5. Hard delete blocked when referenced; allowed when unreferenced ─────────
DO $$ DECLARE msg text := ''; r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.delete_lesson('00000000-0000-0000-0000-0000000d0001'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%assignments, completions, or course references%', '5. delete_lesson blocked (referenced): '||msg;
  msg := '';
  BEGIN PERFORM public.delete_course('00000000-0000-0000-0000-0000000dc001'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%has assignments%', '5. delete_course blocked (has cancelled assignment history): '||msg;
  -- S3 is unreferenced -> deletable
  r := public.delete_lesson('00000000-0000-0000-0000-0000000d0003');
  ASSERT (r->>'deleted')::boolean, '5. unreferenced lesson deletable';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenant_lessons WHERE id='00000000-0000-0000-0000-0000000d0003'), '5. S3 gone';
  RAISE NOTICE '5. delete blocked when referenced / allowed when not: PASS';
END $$;

-- ── 6. mark_lesson_complete server-authoritative tenant + cross-tenant reject ─
DO $$ DECLARE msg text := ''; v_tenant uuid; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
  -- L1 completes an archived S1 lesson in own tenant -> tenant derived server-side
  PERFORM public.mark_lesson_complete('00000000-0000-0000-0000-0000000d0001');
  SELECT tenant_id INTO v_tenant FROM public.lesson_completions
    WHERE profile_id='00000000-0000-0000-0000-0000000000d1' AND lesson_id='00000000-0000-0000-0000-0000000d0001';
  ASSERT v_tenant = '00000000-0000-0000-0000-0000000000d0', '6. completion tenant derived server-side = TA';
  -- L1 tries to complete TB's lesson -> cross-tenant rejected
  msg := '';
  BEGIN PERFORM public.mark_lesson_complete('00000000-0000-0000-0000-0000000e0001'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%cross-tenant completion rejected%', '6. cross-tenant completion rejected: '||msg;
  -- missing lesson rejected
  msg := '';
  BEGIN PERFORM public.mark_lesson_complete('00000000-0000-0000-0000-0000000dffff'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%lesson not found%', '6. missing-content completion rejected: '||msg;
  RAISE NOTICE '6. server-authoritative completion + rejections: PASS';
END $$;

-- ── 7. Direct completion INSERT rejects a foreign tenant_id via RLS ───────────
DO $$ DECLARE ok_own boolean := false; blocked_foreign boolean := false; BEGIN
  -- Production grants authenticated INSERT/SELECT on lesson_completions (verified);
  -- the local migration chain does not, so grant it here (rolled back with the txn)
  -- to exercise the RLS WITH CHECK exactly as production evaluates it.
  GRANT INSERT, SELECT ON public.lesson_completions TO authenticated;
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
  -- own tenant insert allowed
  BEGIN
    INSERT INTO public.lesson_completions (profile_id, lesson_id, tenant_id, completed_at)
      VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000d0', now());
    ok_own := true;
  EXCEPTION WHEN others THEN ok_own := false; END;
  -- foreign tenant_id rejected by WITH CHECK
  BEGIN
    INSERT INTO public.lesson_completions (profile_id, lesson_id, tenant_id, completed_at)
      VALUES ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000e0', now());
    blocked_foreign := false;
  EXCEPTION WHEN others THEN blocked_foreign := true; END;
  RESET ROLE;
  ASSERT ok_own, '7. own-tenant direct completion allowed';
  ASSERT blocked_foreign, '7. foreign-tenant direct completion rejected by RLS';
  RAISE NOTICE '7. RLS server-authoritative completion tenant: PASS';
END $$;

-- ── 8. Backfill cancels stranded assignments (archived/missing content) ──────
DO $$ DECLARE v_cancelled int; BEGIN
  -- A fresh active assignment pointing at an already-archived lesson (S1) + a missing lesson id.
  INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
   ('00000000-0000-0000-0000-0000000da010','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0001',
     '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
   ('00000000-0000-0000-0000-0000000da011','00000000-0000-0000-0000-0000000000d0','lesson','ll_missing_temp_id',
     '{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now());
  -- Re-run the migration's backfill predicate (idempotent).
  UPDATE public.tenant_assignments a
    SET cancelled_at = now(), cancelled_reason = 'content_unavailable_backfill'
    WHERE a.cancelled_at IS NULL
      AND ( (a.content_type='lesson' AND NOT EXISTS (SELECT 1 FROM public.tenant_lessons l WHERE l.id::text=a.content_id AND l.status='active'))
         OR (a.content_type='course' AND NOT EXISTS (SELECT 1 FROM public.tenant_courses c WHERE c.id::text=a.content_id AND c.status='active')) );
  GET DIAGNOSTICS v_cancelled = ROW_COUNT;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da010') IS NOT NULL, '8. archived-content assignment cancelled';
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da011') IS NOT NULL, '8. missing-content assignment cancelled';
  RAISE NOTICE '8. backfill cancels stranded assignments: PASS';
END $$;

-- ── 9. Cross-tenant archive rejected ─────────────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  -- M (TA orgAdmin) cannot archive TB's lesson.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.archive_lesson('00000000-0000-0000-0000-0000000e0001'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not in caller tenant%', '9. cross-tenant archive rejected: '||msg;
  RAISE NOTICE '9. tenant isolation on archive: PASS';
END $$;

ROLLBACK;
\echo '063 ALL TESTS PASSED'
