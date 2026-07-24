-- Repeatable tests for migration 056 (get_quiz_review sanitization + tag RPC).
-- Local only, no creds. One rolled-back transaction. Expect "056 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures: tenant A (rep a1 + rep a2 + manager a9), tenant B (rep b1).
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

-- Q1 (f1) tenant A, assigned to a1 (eligible) — a1 also attempts it below.
-- Q2 (f2) tenant A, assigned to a2 only, a2 attempts it — a1 has NO attempt: EXCLUDED for a1.
-- Q3 (f3) tenant A, NOT assigned to a1 (historical/removed) but a1 HAS an own attempt: INCLUDED for a1.
-- QB (fb) tenant B — cross-tenant: EXCLUDED for a1.
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score, tags) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','Q1','[
   {"id":"q1","type":"mc","options":["A","B","C"],"correct":1,"explanation":"because B"},
   {"id":"q2","type":"slider","correct":5,"tolerance":1,"min":0,"max":10}
 ]'::jsonb,'active',false,100,'["discovery","pricing"]'::jsonb),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a0','Q2','[
   {"id":"z1","type":"mc","options":["A","B"],"correct":0}
 ]'::jsonb,'active',false,100,'["forecasting"]'::jsonb),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a0','Q3','[
   {"id":"y1","type":"mc","options":["A","B"],"correct":1}
 ]'::jsonb,'active',false,100,'["negotiation"]'::jsonb),
 ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000b0','QB','[
   {"id":"w1","type":"mc","options":["A","B"],"correct":0}
 ]'::jsonb,'active',false,100,'["tenantb-topic"]'::jsonb);
INSERT INTO public.tenant_assignments (tenant_id, content_type, content_id, assigned_to, source_type, required, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f1','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,'individual',false,now()),
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f2','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a2"}'::jsonb,'individual',false,now());
-- a2 attempts Q2 (another learner's history — must NOT surface for a1).
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key) VALUES
 ('00000000-0000-0000-0000-00000000a201','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000f2',50,false,1,'[]'::jsonb,'a2010101-0000-0000-0000-0000000000f2');
-- a1 attempts Q3 (historical; Q3 is NOT assigned to a1) — must surface for a1 via history.
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key) VALUES
 ('00000000-0000-0000-0000-00000000a103','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f3',100,true,1,'[]'::jsonb,'a1030303-0000-0000-0000-0000000000f3');

-- Seed attempts on Q1 for a1 that MIMIC the production leak shapes:
--  (i) 054-era server_v2 answer that still contains canonical 'correct' (FAILED, no snapshot)
--  (ii) legacy attempt (provenance NULL) with a full canonical client-shape answer (FAILED)
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key, grading_provenance, verified_revision) VALUES
 ('00000000-0000-0000-0000-00000000a101','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',50,false,1,
   '[{"questionId":"q1","selected":0,"isCorrect":false,"timeSpent":6,"correct":1},
     {"questionId":"q2","selected":9,"isCorrect":false,"timeSpent":3,"correct":5,"tolerance":1}]'::jsonb,
   'a1010101-0000-0000-0000-0000000000f1','server_v2','STALE-OLD-REVISION');
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key) VALUES
 ('00000000-0000-0000-0000-00000000a102','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',50,false,2,
   '[{"questionId":"q1","selected":2,"correct":1,"acceptedAnswers":["B"],"explanation":"because B"},
     {"questionId":"q2","selected":1,"correct":5,"tolerance":1,"pairs":[{"left":"L","right":"R"}]}]'::jsonb,
   'a1020202-0000-0000-0000-0000000000f1');

-- ── 1. get_quiz_review NEVER leaks canonical keys (no official pass) ─────────
DO $$ DECLARE r jsonb; leaked int; ans jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='false', 'no official pass -> no reveal';
  ASSERT r->'solutionsByAttempt' = '{}'::jsonb, 'no solutions before pass';
  SELECT count(*) INTO leaked
    FROM jsonb_array_elements(r->'attempts') at, jsonb_array_elements(at->'answers') a
    WHERE a ? 'correct' OR a ? 'acceptedAnswers' OR a ? 'tolerance' OR a ? 'pairs'
       OR a ? 'correctX' OR a ? 'correctY' OR a ? 'explanation';
  ASSERT leaked = 0, 'NO canonical key in any returned answer';
  -- learner-safe shape preserved: questionId + selected present, isCorrect key present
  ans := r->'attempts'->0->'answers'->0;
  ASSERT (ans ? 'questionId') AND (ans ? 'selected') AND (ans ? 'isCorrect') AND (ans ? 'timeSpent'),
         'answer projected to learner-safe whitelist';
  RAISE NOTICE '1. get_quiz_review sanitized (server_v2 + legacy, no leak): PASS';
END $$;

-- ── 2. selected preserved verbatim incl. 0 and non-index values ──────────────
DO $$ DECLARE r jsonb; a_q2 jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  -- attempt a102 (attempt_num 2) is newest? ordered created_at DESC; both now() — pick by matching selected.
  a_q2 := (SELECT a FROM jsonb_array_elements(r->'attempts') at, jsonb_array_elements(at->'answers') a
             WHERE a->>'questionId'='q2' AND (at->>'attempt_num')='1');
  ASSERT (a_q2->>'selected')='9', 'slider selected value preserved (server_v2 attempt)';
  RAISE NOTICE '2. selected preserved verbatim: PASS';
END $$;

-- ── 3. official pass reveals ONLY from snapshot; answers stay safe ───────────
DO $$ DECLARE rev text; r jsonb; leaked int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  -- pass officially via v2 (writes snapshot). q1 correct=1, q2 target 5.
  PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
    '[{"questionId":"q1","selected":1},{"questionId":"q2","selected":5}]'::jsonb, rev, '00000000-0000-0000-0000-0000000000c1');
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='true', 'official pass unlocks reveal';
  ASSERT (r->'solutionsByAttempt') <> '{}'::jsonb, 'snapshot solutions present';
  -- attempts[].answers STILL contain no canonical key (key is only in solutionsByAttempt)
  SELECT count(*) INTO leaked
    FROM jsonb_array_elements(r->'attempts') at, jsonb_array_elements(at->'answers') a
    WHERE a ? 'correct' OR a ? 'acceptedAnswers' OR a ? 'tolerance' OR a ? 'pairs' OR a ? 'explanation';
  ASSERT leaked = 0, 'answers stay learner-safe even after pass';
  RAISE NOTICE '3. official pass reveal from snapshot; answers safe: PASS';
END $$;

-- ── 4. list_quiz_tags_for_learner: eligible OR own-history; never others'/cross-tenant ─
DO $$ DECLARE t jsonb; ids text[]; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  t := public.list_quiz_tags_for_learner();
  ASSERT jsonb_typeof(t)='array', 'tags list is an array';
  SELECT array_agg(x->>'id') INTO ids FROM jsonb_array_elements(t) x;
  -- (a) Q1: currently eligible (assigned) + own attempts -> INCLUDED
  ASSERT '00000000-0000-0000-0000-0000000000f1' = ANY(ids), 'eligible+attempted Q1 included';
  -- (b) Q3: NOT assigned to a1 but a1 has an own historical attempt -> INCLUDED (history preserved)
  ASSERT '00000000-0000-0000-0000-0000000000f3' = ANY(ids), 'historical own-attempt Q3 included (assignment gone)';
  -- (c) Q2: assigned to a2, attempted by a2, a1 has NO attempt & is not eligible -> EXCLUDED
  ASSERT NOT ('00000000-0000-0000-0000-0000000000f2' = ANY(ids)), 'unassigned/no-own-attempt Q2 excluded (another learner attempted it)';
  -- (d) QB: tenant B -> EXCLUDED (cross-tenant)
  ASSERT NOT ('00000000-0000-0000-0000-0000000000fb' = ANY(ids)), 'cross-tenant QB excluded';
  ASSERT array_length(ids,1) = 2, 'exactly {Q1, Q3} for a1';
  -- tags-only, no question bodies; historical tag attributable
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t) x WHERE x ? 'questions'), 'no question bodies';
  ASSERT (SELECT x->'tags' FROM jsonb_array_elements(t) x WHERE x->>'id'='00000000-0000-0000-0000-0000000000f3') = '["negotiation"]'::jsonb,
         'historical quiz tags attributable';
  RAISE NOTICE '4. tags via eligibility OR own-history; others/cross-tenant excluded: PASS';
END $$;

-- ── 5. cross-tenant isolation (tenant B rep sees only own tenant) ────────────
DO $$ DECLARE t jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}',true);
  t := public.list_quiz_tags_for_learner();
  -- b1 has no assignment and no attempt in tenant B here -> empty; and never any tenant A quiz
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t) x
                       JOIN public.tenant_quizzes q ON q.id=(x->>'id')::uuid
                       WHERE q.tenant_id <> '00000000-0000-0000-0000-0000000000b0'),
         'tenant B rep never sees another tenant''s quiz tags';
  RAISE NOTICE '5. tag RPC cross-tenant isolation: PASS';
END $$;

-- ── 6. grants: authenticated-only execution ─────────────────────────────────
DO $$ BEGIN
  ASSERT has_function_privilege('authenticated','public.list_quiz_tags_for_learner()','EXECUTE'), 'authenticated can execute tag RPC';
  ASSERT NOT has_function_privilege('anon','public.list_quiz_tags_for_learner()','EXECUTE'), 'anon cannot';
  ASSERT NOT has_function_privilege('anon','public.get_quiz_review(uuid)','EXECUTE'), 'anon cannot review';
  ASSERT NOT has_function_privilege('authenticated','public._quiz_answers_learner_safe(jsonb)','EXECUTE'), 'internal projection locked';
  RAISE NOTICE '6. grants correct: PASS';
END $$;

ROLLBACK;
\echo '056 ALL TESTS PASSED'
