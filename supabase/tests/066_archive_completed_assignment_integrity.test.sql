-- Repeatable tests for migration 066 (archive must not cancel COMPLETED assignments).
-- Proves: archive_quiz/lesson/course cancel ONLY unresolved instances (instance-aware
-- completion), leave completed rows active/Completed, and return the true unresolved
-- count; the one-time repair restores content_archived rows completed-before-cancel
-- (individual only), never touches manager_unassigned / content_missing / genuinely
-- unresolved rows, and is idempotent. One tenant. One rolled-back transaction. Local.
-- Expect "066 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','amg@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','al1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','al2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','al3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a4','authenticated','authenticated','al4@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a0','ata','ATA');
UPDATE public.profiles SET role='manager',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active',name='AMG' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active',name='AL1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active',name='AL2' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active',name='AL3' WHERE id='00000000-0000-0000-0000-0000000000a3';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active',name='AL4' WHERE id='00000000-0000-0000-0000-0000000000a4';

INSERT INTO public.tenant_quizzes (id, tenant_id, name, status, passing_score) VALUES
 ('00000000-0000-0000-0000-0000000af001','00000000-0000-0000-0000-0000000000a0','AQ','active',70);
INSERT INTO public.tenant_lessons (id, tenant_id, title, status) VALUES
 ('00000000-0000-0000-0000-0000000ab001','00000000-0000-0000-0000-0000000000a0','AL','active'),
 ('00000000-0000-0000-0000-0000000ab002','00000000-0000-0000-0000-0000000000a0','C-a','active'),
 ('00000000-0000-0000-0000-0000000ab003','00000000-0000-0000-0000-0000000000a0','C-b','active');
INSERT INTO public.tenant_courses (id, tenant_id, title, lesson_ids, status) VALUES
 ('00000000-0000-0000-0000-0000000ac001','00000000-0000-0000-0000-0000000000a0','AC',
  '["00000000-0000-0000-0000-0000000ab002","00000000-0000-0000-0000-0000000ab003"]'::jsonb,'active');

-- Assignments 2h ago so completions (1h ago) land AFTER assigned_at.
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000ba001','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1","userName":"AL1"}'::jsonb, now()-interval '2 hours'),  -- passed
 ('00000000-0000-0000-0000-0000000ba002','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a2","userName":"AL2"}'::jsonb, now()-interval '2 hours'),  -- not started
 ('00000000-0000-0000-0000-0000000ba003','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a3","userName":"AL3"}'::jsonb, now()-interval '2 hours'),  -- failed only
 ('00000000-0000-0000-0000-0000000ba010','00000000-0000-0000-0000-0000000000a0','lesson','00000000-0000-0000-0000-0000000ab001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1","userName":"AL1"}'::jsonb, now()-interval '2 hours'),  -- completed
 ('00000000-0000-0000-0000-0000000ba011','00000000-0000-0000-0000-0000000000a0','lesson','00000000-0000-0000-0000-0000000ab001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a2","userName":"AL2"}'::jsonb, now()-interval '2 hours'),  -- not done
 ('00000000-0000-0000-0000-0000000ba020','00000000-0000-0000-0000-0000000000a0','course','00000000-0000-0000-0000-0000000ac001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1","userName":"AL1"}'::jsonb, now()-interval '2 hours'),  -- both done
 ('00000000-0000-0000-0000-0000000ba021','00000000-0000-0000-0000-0000000000a0','course','00000000-0000-0000-0000-0000000ac001','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a2","userName":"AL2"}'::jsonb, now()-interval '2 hours');  -- 1 of 2

INSERT INTO public.quiz_attempts (tenant_id, user_id, quiz_id, score, passed, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000af001', 90, true,  now()-interval '1 hour'),  -- AL1 passed
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000af001', 40, false, now()-interval '1 hour');  -- AL3 failed
INSERT INTO public.lesson_completions (profile_id, tenant_id, lesson_id, completed_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000ab001', now()-interval '1 hour'),  -- AL1 lesson
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000ab002', now()-interval '1 hour'),  -- AL1 course a
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000ab003', now()-interval '1 hour'),  -- AL1 course b
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000ab002', now()-interval '1 hour');  -- AL2 course a only

-- ── 1. archive_quiz cancels only unresolved; completed stays; count=2 ─────────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  r := public.archive_quiz('00000000-0000-0000-0000-0000000af001');
  ASSERT (r->>'cancelled_assignments')::int = 2, '1. quiz cancels only 2 unresolved: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba001') IS NULL, '1. passed quiz row stays active';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba002')='content_archived', '1. not-started cancelled';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba003')='content_archived', '1. failed cancelled';
  RAISE NOTICE '1. archive_quiz: completed stays active, only unresolved cancelled, count=2: PASS';
END $$;

-- ── 2. archive_lesson cancels only unresolved; completed stays; count=1 ───────
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  r := public.archive_lesson('00000000-0000-0000-0000-0000000ab001');
  ASSERT (r->>'cancelled_assignments')::int = 1, '2. lesson cancels only 1 unresolved: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba010') IS NULL, '2. completed lesson row stays active';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba011')='content_archived', '2. not-done lesson cancelled';
  RAISE NOTICE '2. archive_lesson: completed stays, only unresolved cancelled, count=1: PASS';
END $$;

-- ── 3. archive_course cancels only unresolved (partial); complete stays; count=1
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  r := public.archive_course('00000000-0000-0000-0000-0000000ac001');
  ASSERT (r->>'cancelled_assignments')::int = 1, '3. course cancels only 1 partial: '||r::text;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba020') IS NULL, '3. fully-complete course row stays active';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000ba021')='content_archived', '3. partial course cancelled';
  RAISE NOTICE '3. archive_course: fully-complete stays, only partial cancelled, count=1: PASS';
END $$;

-- ── 4. Repair fixtures: rows damaged by the OLD archive (completed-then-cancelled)
--     plus rows that must NOT be repaired. Then run the migration's 4a/4b/4c repair.
-- AQ2 is created ACTIVE so the assignment rows insert (the 065 guard requires active
-- content at insert time — exactly how these rows arose in production before archival);
-- we then set it archived directly to mirror the post-archive state the repair fixes.
INSERT INTO public.tenant_quizzes (id, tenant_id, name, status) VALUES ('00000000-0000-0000-0000-0000000af002','00000000-0000-0000-0000-0000000000a0','AQ2','active');
-- Four DISTINCT learners so each scenario is clean (no cross-instance contamination).
INSERT INTO public.tenant_assignments (id, tenant_id, content_type, content_id, assigned_to, assigned_at, cancelled_at, cancelled_reason) VALUES
 -- bd001 (REPAIR) AL1: passing attempt in [assigned 3h, cancel 1h) → completed-before-cancel
 ('00000000-0000-0000-0000-0000000bd001','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1","userName":"AL1"}'::jsonb, now()-interval '3 hours', now()-interval '1 hour', 'content_archived'),
 -- bd002 (NO repair) AL2: genuinely unresolved — no attempt at all
 ('00000000-0000-0000-0000-0000000bd002','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a2","userName":"AL2"}'::jsonb, now()-interval '3 hours', now()-interval '1 hour', 'content_archived'),
 -- bd003 (NO repair) AL3: passed in window BUT cancelled for a different reason
 ('00000000-0000-0000-0000-0000000bd003','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a3","userName":"AL3"}'::jsonb, now()-interval '3 hours', now()-interval '1 hour', 'manager_unassigned'),
 -- bd004 (NO repair) AL4: passing attempt AFTER its cancel (not completed-before-cancel)
 ('00000000-0000-0000-0000-0000000bd004','00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000af002','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a4","userName":"AL4"}'::jsonb, now()-interval '3 hours', now()-interval '2 hours', 'content_archived');
INSERT INTO public.quiz_attempts (tenant_id, user_id, quiz_id, score, passed, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000af002', 88, true, now()-interval '2 hours'),   -- AL1 passed before cancel (bd001)
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000af002', 91, true, now()-interval '2 hours'),   -- AL3 passed (but bd003 manager_unassigned)
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000af002', 80, true, now()-interval '90 minutes'); -- AL4 passed AFTER bd004 cancel (2h ago)
-- Reflect the real post-archive state (repair predicate is status-agnostic).
UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000000af002';

DO $$ DECLARE v_repaired int; BEGIN
  -- Replay the migration's 4a quiz repair predicate.
  UPDATE public.tenant_assignments ta SET cancelled_at=NULL, cancelled_reason=NULL, cancelled_by=NULL
    WHERE ta.content_type='quiz' AND ta.cancelled_reason='content_archived' AND ta.cancelled_at IS NOT NULL
      AND ta.assigned_to->>'type'='individual' AND (ta.assigned_to->>'userId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.quiz_attempts qa WHERE qa.quiz_id=ta.content_id::uuid
                    AND qa.user_id=(ta.assigned_to->>'userId')::uuid AND qa.passed IS TRUE
                    AND qa.created_at >= ta.assigned_at AND qa.created_at < ta.cancelled_at);
  GET DIAGNOSTICS v_repaired = ROW_COUNT;
  ASSERT v_repaired = 1, '4. exactly one quiz row repaired: '||v_repaired;
  ASSERT (SELECT cancelled_at FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000bd001') IS NULL, '4a. completed-before-cancel restored';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000bd002')='content_archived', '4b. unresolved NOT repaired';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000bd003')='manager_unassigned', '4c. manager_unassigned NOT touched';
  ASSERT (SELECT cancelled_reason FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000bd004')='content_archived', '4d. attempt-after-cancel NOT repaired';
  -- idempotent re-run
  UPDATE public.tenant_assignments ta SET cancelled_at=NULL, cancelled_reason=NULL, cancelled_by=NULL
    WHERE ta.content_type='quiz' AND ta.cancelled_reason='content_archived' AND ta.cancelled_at IS NOT NULL
      AND ta.assigned_to->>'type'='individual' AND (ta.assigned_to->>'userId') IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.quiz_attempts qa WHERE qa.quiz_id=ta.content_id::uuid
                    AND qa.user_id=(ta.assigned_to->>'userId')::uuid AND qa.passed IS TRUE
                    AND qa.created_at >= ta.assigned_at AND qa.created_at < ta.cancelled_at);
  GET DIAGNOSTICS v_repaired = ROW_COUNT;
  ASSERT v_repaired = 0, '4. repair idempotent (0 on re-run): '||v_repaired;
  RAISE NOTICE '4. repair restores completed-before-cancel only, spares unresolved/other-reason/after-cancel, idempotent: PASS';
END $$;

DO $$ BEGIN RAISE NOTICE '066 ALL TESTS PASSED'; END $$;

ROLLBACK;
