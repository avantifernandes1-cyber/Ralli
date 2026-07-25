-- Repeatable tests for migration 064 (Manager Unassign).
-- Proves: a MANAGER (role 'manager', the required authority) can unassign an
-- active lesson/course/quiz; a learner cannot; cross-tenant is refused.
-- State transitions — CAN be unassigned: not_started, in_progress (a FAILED
-- quiz, a PARTIALLY-complete course), overdue, and a lesson whose only
-- completion predates the current assigned_at. CANNOT: completed (lesson done,
-- course fully done, quiz passed). A TEAM-ORIGINATED individual row (fanned out
-- by create_assignments_atomic, origin in source_*) can already be unassigned
-- per learner without touching a teammate or the team; only a genuine SHARED aggregate row
-- (assigned_to.type team/group) is refused. Unassign is idempotent and never
-- overwrites the original ender; reassignment creates a fresh row while the old
-- stays cancelled in history; the hard-delete path is closed (grant revoked);
-- reason + actor are server-set. Two tenants for isolation. One rolled-back
-- transaction. Local only. Expect "064 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000d9','authenticated','authenticated','mgra@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000d1','authenticated','authenticated','l1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000d2','authenticated','authenticated','l2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000e9','authenticated','authenticated','mgrb@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000d0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000e0','tb','TB');
-- MgrA is role 'manager' ON PURPOSE — proves the corrected authority includes 'manager'.
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='MgrA' WHERE id='00000000-0000-0000-0000-0000000000d9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='L1'   WHERE id='00000000-0000-0000-0000-0000000000d1';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='L2'   WHERE id='00000000-0000-0000-0000-0000000000d2';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000e0', status='active', name='MgrB' WHERE id='00000000-0000-0000-0000-0000000000e9';

-- Lessons (content_id is TEXT in tenant_assignments)
INSERT INTO public.tenant_lessons (id, tenant_id, title, status) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000d0','LES1','active'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000d0','C1 lesson a','active'),
 ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000d0','C1 lesson b','active'),
 ('00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000000d0','LES_DONE','active'),
 ('00000000-0000-0000-0000-0000000d0005','00000000-0000-0000-0000-0000000000d0','LES_PRE','active'),
 ('00000000-0000-0000-0000-0000000d0006','00000000-0000-0000-0000-0000000000d0','C2 lesson a','active'),
 ('00000000-0000-0000-0000-0000000d0007','00000000-0000-0000-0000-0000000000d0','C2 lesson b','active');
INSERT INTO public.tenant_courses (id, tenant_id, title, lesson_ids, status) VALUES
 ('00000000-0000-0000-0000-0000000dc001','00000000-0000-0000-0000-0000000000d0','CRS1',
  '["00000000-0000-0000-0000-0000000d0002","00000000-0000-0000-0000-0000000d0003"]'::jsonb,'active'),
 ('00000000-0000-0000-0000-0000000dc002','00000000-0000-0000-0000-0000000000d0','CRS2',
  '["00000000-0000-0000-0000-0000000d0006","00000000-0000-0000-0000-0000000d0007"]'::jsonb,'active');
INSERT INTO public.tenant_quizzes (id, tenant_id, name) VALUES
 ('00000000-0000-0000-0000-0000000df001','00000000-0000-0000-0000-0000000000d0','QZ1'),
 ('00000000-0000-0000-0000-0000000df002','00000000-0000-0000-0000-0000000000d0','QZ2'),
 ('00000000-0000-0000-0000-0000000df003','00000000-0000-0000-0000-0000000000d0','QZ3');

-- Assignments. Older ones assigned 2h ago so completions can be placed before/after.
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
 -- individual, not started (unassignable)
 ('00000000-0000-0000-0000-0000000da001','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
 ('00000000-0000-0000-0000-0000000da002','00000000-0000-0000-0000-0000000000d0','course','00000000-0000-0000-0000-0000000dc001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
 ('00000000-0000-0000-0000-0000000da003','00000000-0000-0000-0000-0000000000d0','quiz','00000000-0000-0000-0000-0000000df001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
 -- L2's own LES1 assignment — must stay untouched when L1's is unassigned
 ('00000000-0000-0000-0000-0000000da004','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d2","userName":"L2"}'::jsonb, now()),
 -- completed lesson (completion AFTER assigned_at) → refuse
 ('00000000-0000-0000-0000-0000000da005','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0004','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now() - interval '2 hours'),
 -- lesson with a PRE-reassignment completion (predates assigned_at) → allow
 ('00000000-0000-0000-0000-0000000da006','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0005','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now()),
 -- team assignment → refuse (non-individual)
 ('00000000-0000-0000-0000-0000000da008','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d0001','{"type":"team","teamId":"00000000-0000-0000-0000-0000000t0001","teamName":"Team"}'::jsonb, now()),
 -- course fully complete → refuse
 ('00000000-0000-0000-0000-0000000da009','00000000-0000-0000-0000-0000000000d0','course','00000000-0000-0000-0000-0000000dc002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now() - interval '2 hours'),
 -- quiz FAILED attempt (in_progress) → allow
 ('00000000-0000-0000-0000-0000000da010','00000000-0000-0000-0000-0000000000d0','quiz','00000000-0000-0000-0000-0000000df002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now() - interval '2 hours'),
 -- quiz PASSED attempt → refuse
 ('00000000-0000-0000-0000-0000000da011','00000000-0000-0000-0000-0000000000d0','quiz','00000000-0000-0000-0000-0000000df003','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now() - interval '2 hours');

-- Completions / attempts
INSERT INTO public.lesson_completions (profile_id, tenant_id, lesson_id, completed_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0004', now() - interval '1 hour'),   -- da005: AFTER assigned (2h ago) → complete
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0005', now() - interval '1 hour'),   -- da006: BEFORE assigned (now) → predate
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0006', now() - interval '1 hour'),   -- CRS2 member a → complete
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0007', now() - interval '1 hour');   -- CRS2 member b → complete
INSERT INTO public.quiz_attempts (tenant_id, user_id, quiz_id, score, passed, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000df002', 40, false, now() - interval '1 hour'),  -- QZ2: failed → in_progress
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000df003', 90, true,  now() - interval '1 hour');  -- QZ3: passed → complete

-- Extra fixtures for the corrected state-transition + team-origin coverage.
INSERT INTO public.tenant_lessons (id, tenant_id, title, status) VALUES
 ('00000000-0000-0000-0000-0000000d0008','00000000-0000-0000-0000-0000000000d0','C3 lesson a','active'),
 ('00000000-0000-0000-0000-0000000d0009','00000000-0000-0000-0000-0000000000d0','C3 lesson b','active'),
 ('00000000-0000-0000-0000-0000000d000a','00000000-0000-0000-0000-0000000000d0','LES_TEAM','active');
INSERT INTO public.tenant_courses (id, tenant_id, title, lesson_ids, status) VALUES
 ('00000000-0000-0000-0000-0000000dc003','00000000-0000-0000-0000-0000000000d0','CRS3',
  '["00000000-0000-0000-0000-0000000d0008","00000000-0000-0000-0000-0000000d0009"]'::jsonb,'active');
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at, source_type, source_id, source_label) VALUES
 -- PARTIALLY complete course (1 of 2 member lessons done after assigned) → allow
 ('00000000-0000-0000-0000-0000000da012','00000000-0000-0000-0000-0000000000d0','course','00000000-0000-0000-0000-0000000dc003','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now() - interval '2 hours', 'individual', NULL, NULL),
 -- TEAM-ORIGINATED individual rows (fan-out): one per learner, origin in source_*
 ('00000000-0000-0000-0000-0000000da013','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d000a','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}'::jsonb, now(), 'team', '00000000-0000-0000-0000-0000000dd001', 'Team A'),
 ('00000000-0000-0000-0000-0000000da014','00000000-0000-0000-0000-0000000000d0','lesson','00000000-0000-0000-0000-0000000d000a','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000d2","userName":"L2"}'::jsonb, now(), 'team', '00000000-0000-0000-0000-0000000dd001', 'Team A');
-- Only C3 lesson a is completed (after assigned) → CRS3 is partial for L1.
INSERT INTO public.lesson_completions (profile_id, tenant_id, lesson_id, completed_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000d0008', now() - interval '1 hour');

-- Helper to set the acting identity for a SECURITY DEFINER RPC call.
-- (auth.uid() reads request.jwt.claims.sub; the RPC runs as owner.)

-- ── 1. MANAGER (role 'manager') unassigns a not-started lesson ───────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da001');
  ASSERT r->>'status' = 'unassigned', '1. status unassigned: '||r::text;
  ASSERT (SELECT cancelled_at     FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') IS NOT NULL, '1. cancelled_at set';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') = 'manager_unassigned', '1. server reason';
  ASSERT (SELECT cancelled_by     FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') = '00000000-0000-0000-0000-0000000000d9', '1. cancelled_by = MgrA';
  RAISE NOTICE '1. manager unassigns not-started lesson (reason+actor server-set): PASS';
END $$;

-- ── 2. Manager unassigns a not-started COURSE ────────────────────────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da002');
  ASSERT r->>'status' = 'unassigned', '2. course unassigned: '||r::text;
  RAISE NOTICE '2. manager unassigns not-started course: PASS';
END $$;

-- ── 3. Manager unassigns a not-attempted QUIZ ────────────────────────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da003');
  ASSERT r->>'status' = 'unassigned', '3. quiz unassigned: '||r::text;
  RAISE NOTICE '3. manager unassigns not-attempted quiz: PASS';
END $$;

-- ── 4. LEARNER cannot unassign ───────────────────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da004'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%only managers%', '4. learner refused: '||msg;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da004') IS NULL, '4. da004 untouched';
  RAISE NOTICE '4. learner cannot unassign: PASS';
END $$;

-- ── 5. CROSS-TENANT unassign refused (MgrB from TB targets TA row) ───────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000e9","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da004'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not in your tenant%', '5. cross-tenant refused: '||msg;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da004') IS NULL, '5. da004 still active';
  RAISE NOTICE '5. cross-tenant unassign refused: PASS';
END $$;

-- ── 6a. COMPLETED lesson cannot be unassigned ────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da005'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%completed assignment%', '6a. completed lesson refused: '||msg;
  RAISE NOTICE '6a. completed lesson cannot be unassigned: PASS';
END $$;

-- ── 6b. PRE-reassignment completion (predates assigned_at) → CAN unassign ────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da006');
  ASSERT r->>'status' = 'unassigned', '6b. predating completion does not block unassign: '||r::text;
  RAISE NOTICE '6b. pre-reassignment completion does not count as completed: PASS';
END $$;

-- ── 6c. Quiz: FAILED (in_progress) allowed; PASSED refused ───────────────────
DO $$ DECLARE r jsonb; msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da010');
  ASSERT r->>'status' = 'unassigned', '6c. failed quiz (in_progress) unassignable: '||r::text;
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da011'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%completed assignment%', '6c. passed quiz refused: '||msg;
  RAISE NOTICE '6c. failed quiz allowed, passed quiz refused: PASS';
END $$;

-- ── 6d. Fully-complete COURSE cannot be unassigned ───────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da009'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%completed assignment%', '6d. complete course refused: '||msg;
  RAISE NOTICE '6d. fully-complete course cannot be unassigned: PASS';
END $$;

-- ── 7. IDEMPOTENT — second unassign returns existing, never overwrites ───────
DO $$ DECLARE r jsonb; v_by uuid; v_at timestamptz; BEGIN
  SELECT cancelled_by, cancelled_at INTO v_by, v_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da001');
  ASSERT r->>'status' = 'already_cancelled', '7. idempotent status: '||r::text;
  ASSERT (SELECT cancelled_by FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') = v_by, '7. cancelled_by unchanged';
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') = v_at, '7. cancelled_at unchanged';
  RAISE NOTICE '7. idempotent double-unassign preserves original ender: PASS';
END $$;

-- ── 8. Another learner's row is untouched ────────────────────────────────────
DO $$ BEGIN
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da004') IS NULL,
    '8. L2 LES1 assignment untouched by L1 unassign';
  RAISE NOTICE '8. other learner untouched: PASS';
END $$;

-- ── 9. Team/group aggregate row refused ──────────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-0000000da008'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%shared team/group%', '9. shared aggregate row refused: '||msg;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da008') IS NULL, '9. shared row untouched';
  RAISE NOTICE '9. genuine SHARED team/group aggregate row refused: PASS';
END $$;

-- ── 10. Not found → honest error ─────────────────────────────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN PERFORM public.unassign_assignment('00000000-0000-0000-0000-00000000ffff'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not found%', '10. not-found error: '||msg;
  RAISE NOTICE '10. not found honest error: PASS';
END $$;

-- ── 11. HARD-DELETE path closed at the grant level (authenticated) ───────────
DO $$ DECLARE msg text := ''; BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  BEGIN
    DELETE FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da004';
  EXCEPTION WHEN others THEN msg := SQLERRM; END;
  RESET ROLE;
  ASSERT msg LIKE '%permission denied%', '11. authenticated DELETE denied at grant level: '||msg;
  ASSERT (SELECT count(*) FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da004') = 1, '11. row still present';
  RAISE NOTICE '11. manager/client hard-delete blocked (grant revoked): PASS';
END $$;

-- ── 12. DELETE RLS policy removed ────────────────────────────────────────────
DO $$ BEGIN
  ASSERT NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename='tenant_assignments' AND policyname='tenant_assignments_delete'
  ), '12. tenant_assignments_delete policy dropped';
  RAISE NOTICE '12. DELETE RLS policy removed: PASS';
END $$;

-- ── 13. cancelled_by FK is ON DELETE SET NULL (history retained) ─────────────
DO $$ DECLARE v_action char; BEGIN
  SELECT confdeltype INTO v_action
    FROM pg_constraint
    WHERE conrelid = 'public.tenant_assignments'::regclass
      AND confrelid = 'public.profiles'::regclass
      AND conkey = (SELECT array_agg(attnum) FROM pg_attribute
                    WHERE attrelid='public.tenant_assignments'::regclass AND attname='cancelled_by');
  ASSERT v_action = 'n', '13. cancelled_by FK ON DELETE SET NULL (n): got '||COALESCE(v_action,'<null>');
  RAISE NOTICE '13. cancelled_by FK ON DELETE SET NULL — history retained on profile removal: PASS';
END $$;

-- ── 14. PARTIALLY complete course CAN be unassigned (in_progress) ────────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da012');
  ASSERT r->>'status' = 'unassigned', '14. partial course unassignable: '||r::text;
  RAISE NOTICE '14. partially-complete course CAN be unassigned: PASS';
END $$;

-- ── 15. TEAM-ORIGINATED individual row: one learner unassignable, teammate
--       untouched, and the team origin (source_*) preserved for audit ─────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  r := public.unassign_assignment('00000000-0000-0000-0000-0000000da013');   -- L1's team-fanned row
  ASSERT r->>'status' = 'unassigned', '15. team-originated individual row unassignable: '||r::text;
  -- teammate L2's own fanned row is untouched
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da014') IS NULL, '15. teammate row untouched';
  -- origin metadata preserved on the cancelled row (audit history)
  ASSERT (SELECT source_type  FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da013') = 'team', '15. source_type preserved';
  ASSERT (SELECT source_label FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da013') = 'Team A', '15. source_label preserved';
  RAISE NOTICE '15. team-originated learner unassigned; teammate untouched; origin kept: PASS';
END $$;

-- ── 16. Reassignment creates a FRESH row; the old (unassigned) row remains in
--       history — reused create_assignments_atomic, no duplicate/reactivation ─
DO $$ DECLARE r jsonb; v_created int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d9","role":"authenticated"}',true);
  -- L1's LES1 assignment (da001) was unassigned in test 1 → L1 is now eligible again.
  r := public.create_assignments_atomic(
        '00000000-0000-0000-0000-0000000000d0', 'lesson', '00000000-0000-0000-0000-0000000d0001',
        '[{"userId":"00000000-0000-0000-0000-0000000000d1","userName":"L1"}]'::jsonb,
        'Open', false, '00000000-0000-0000-0000-0000000000d9', 'individual', NULL, NULL);
  v_created := (r->>'assignedCount')::int;
  ASSERT v_created = 1, '16. reassignment created exactly one fresh row: '||r::text;
  -- old row still present AND still cancelled (history preserved, not reactivated)
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000da001') IS NOT NULL, '16. old row still cancelled (history)';
  -- exactly one ACTIVE (non-cancelled) LES1 row for L1 now — the fresh one
  ASSERT (SELECT count(*) FROM public.tenant_assignments
          WHERE tenant_id='00000000-0000-0000-0000-0000000000d0' AND content_type='lesson'
            AND content_id='00000000-0000-0000-0000-0000000d0001'
            AND assigned_to->>'userId'='00000000-0000-0000-0000-0000000000d1'
            AND cancelled_at IS NULL) = 1, '16. exactly one active reassigned row';
  RAISE NOTICE '16. reassignment creates a fresh row; old stays cancelled in history: PASS';
END $$;

DO $$ BEGIN RAISE NOTICE '064 ALL TESTS PASSED'; END $$;

ROLLBACK;
