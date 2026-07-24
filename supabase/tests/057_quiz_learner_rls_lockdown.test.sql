-- Repeatable tests for migration 057 (learner RLS lockdown on answer-bearing
-- tables). RLS is only enforced for the non-owner `authenticated` role, so the
-- direct-SELECT blocks run under SET ROLE authenticated. Local only, no creds.
-- One rolled-back transaction. Expect "057 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Replicate PRODUCTION's table-level grants to `authenticated` (local supabase
-- omits these default grants). This makes ROW-LEVEL SECURITY — not a missing
-- table grant — the thing these tests exercise, matching production where the
-- grant is present and 057's RLS policy is the gate. Transaction-local; rolled back.
GRANT SELECT ON public.tenant_quizzes TO authenticated;
GRANT SELECT, INSERT ON public.quiz_attempts TO authenticated;
GRANT SELECT ON public.profiles TO authenticated;   -- own_insert WITH CHECK reads profiles

-- Fixtures (as owner/postgres): tenant A (a1 rep, a2 rep, a9 orgAdmin), tenant B (b1 rep).
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','a2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','mgr@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','b1@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),('00000000-0000-0000-0000-0000000000b0','tb','TB');
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA2' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MgrA'  WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='RepB1' WHERE id='00000000-0000-0000-0000-0000000000b1';

INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score, tags) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','Q1','[
   {"id":"q1","type":"mc","options":["A","B","C"],"correct":1,"explanation":"because B"},
   {"id":"q2","type":"slider","correct":5,"tolerance":1,"min":0,"max":10}
 ]'::jsonb,'active',false,100,'["discovery"]'::jsonb),
 ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000b0','QB','[
   {"id":"w1","type":"mc","options":["A","B"],"correct":0}
 ]'::jsonb,'active',false,100,'["tenantb"]'::jsonb);
INSERT INTO public.tenant_assignments (tenant_id, content_type, content_id, assigned_to, source_type, required, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f1','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,'individual',false,now());
-- a1 failed server_v2 attempt on f1 with canonical still in stored answers (pre-055 shape).
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key, grading_provenance, verified_revision) VALUES
 ('00000000-0000-0000-0000-00000000a101','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',50,false,1,
   '[{"questionId":"q1","selected":0,"isCorrect":false,"correct":1},{"questionId":"q2","selected":9,"isCorrect":false,"correct":5,"tolerance":1}]'::jsonb,
   'a1010101-0000-0000-0000-0000000000f1','server_v2','STALE');
-- a2 attempt on f1 (another learner's raw attempt — a1 must never read it directly).
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key) VALUES
 ('00000000-0000-0000-0000-00000000a201','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000f1',50,false,1,'[]'::jsonb,'a2010101-0000-0000-0000-0000000000f1');

-- ── 1. Learner CANNOT directly SELECT tenant_quizzes (answer-bearing) ─────────
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.tenant_quizzes) = 0, 'learner direct tenant_quizzes SELECT blocked';
  RAISE NOTICE '1. learner direct tenant_quizzes SELECT blocked: PASS';
END $$;

-- ── 2. Learner CANNOT directly SELECT raw quiz_attempts (own OR others') ──────
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.quiz_attempts) = 0, 'learner direct quiz_attempts SELECT blocked (own+others)';
  ASSERT (SELECT count(*) FROM public.quiz_attempts WHERE user_id='00000000-0000-0000-0000-0000000000a1') = 0, 'even own attempts blocked directly';
  RAISE NOTICE '2. learner direct quiz_attempts SELECT blocked (own+others): PASS';
END $$;

-- ── 8a. Learner INSERT of own attempt still works (own_insert unchanged) ──────
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  INSERT INTO public.quiz_attempts (tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',60,false,2,'[]'::jsonb, gen_random_uuid());
  RAISE NOTICE '8a. learner own INSERT still allowed: PASS';
END $$;
RESET ROLE;

-- ── 3. Learner-safe RPCs still return data (SECURITY DEFINER bypass RLS) ──────
DO $$ DECLARE cat jsonb; q jsonb; rev jsonb; safe jsonb; tags jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  cat  := public.list_quizzes_for_learner();
  q    := public.get_quiz_for_attempt('00000000-0000-0000-0000-0000000000f1');
  rev  := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  safe := public.list_my_quiz_attempts_safe();
  tags := public.list_quiz_tags_for_learner();
  ASSERT jsonb_array_length(cat) >= 1, 'catalog RPC works';
  ASSERT (q ? 'questions') AND NOT (q->'questions'->0 ? 'correct'), 'taking RPC works + sanitized';
  ASSERT jsonb_array_length(rev->'attempts') >= 1, 'review RPC works';
  ASSERT jsonb_array_length(safe) >= 1, 'history RPC works';
  ASSERT jsonb_array_length(tags) >= 1 AND (tags->0->'tags') = '["discovery"]'::jsonb, 'knowledge-by-topic RPC works';
  RAISE NOTICE '3. learner catalog/taking/review/history/KbT RPCs work: PASS';
END $$;

-- ── 4. Failed review remains key-free (056 sanitization intact) ──────────────
DO $$ DECLARE r jsonb; leaked int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='false', 'no official pass -> no reveal';
  SELECT count(*) INTO leaked FROM jsonb_array_elements(r->'attempts') at, jsonb_array_elements(at->'answers') a
    WHERE a ? 'correct' OR a ? 'acceptedAnswers' OR a ? 'tolerance' OR a ? 'pairs' OR a ? 'explanation';
  ASSERT leaked = 0, 'failed review answers contain no canonical key';
  RAISE NOTICE '4. failed review key-free: PASS';
END $$;

-- ── 5. Official pass reveals ONLY snapshot solutions; answers stay safe ──────
DO $$ DECLARE rev text; r jsonb; leaked int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
    '[{"questionId":"q1","selected":1},{"questionId":"q2","selected":5}]'::jsonb, rev, gen_random_uuid());
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='true', 'official pass unlocks reveal';
  ASSERT (r->'solutionsByAttempt') <> '{}'::jsonb, 'reveal comes from snapshot';
  SELECT count(*) INTO leaked FROM jsonb_array_elements(r->'attempts') at, jsonb_array_elements(at->'answers') a
    WHERE a ? 'correct' OR a ? 'acceptedAnswers' OR a ? 'tolerance' OR a ? 'pairs' OR a ? 'explanation';
  ASSERT leaked = 0, 'attempt answers stay learner-safe even after pass';
  RAISE NOTICE '5. official pass reveal = snapshot-only; answers safe + grading works: PASS';
END $$;

-- ── 6. Manager/admin retain tenant-scoped DIRECT reads (analytics/drilldowns) ─
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.tenant_quizzes) >= 1, 'manager can SELECT tenant quizzes';
  ASSERT (SELECT count(*) FROM public.quiz_attempts) >= 2, 'manager can SELECT tenant-wide attempts (a1+a2)';
  RAISE NOTICE '6. manager/admin tenant-scoped direct reads retained: PASS';
END $$;

-- ── 7. Cross-tenant reads rejected (manager of A never sees tenant B rows) ────
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenant_quizzes WHERE tenant_id='00000000-0000-0000-0000-0000000000b0'), 'manager A cannot read tenant B quizzes';
  ASSERT NOT EXISTS (SELECT 1 FROM public.quiz_attempts WHERE tenant_id='00000000-0000-0000-0000-0000000000b0'), 'manager A cannot read tenant B attempts';
  RAISE NOTICE '7. cross-tenant reads rejected: PASS';
END $$;
RESET ROLE;

-- ── 9. quiz_attempt_solutions remains manager-only + immutable (unchanged) ────
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempt_solutions')=1, 'snapshot has single (manager) SELECT policy';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempt_solutions' AND cmd<>'SELECT')=0, 'snapshot has NO write policy (immutable)';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempts' AND cmd='INSERT')=1, 'own-insert policy intact';
  RAISE NOTICE '9. snapshot manager-only+immutable; own-insert intact: PASS';
END $$;

ROLLBACK;
\echo '057 ALL TESTS PASSED'
