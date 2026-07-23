-- ─────────────────────────────────────────────────────────────────────────────
-- Repeatable test harness for migration 054 (server-authoritative quiz grading).
--
-- Runs entirely against a LOCAL database — no production credentials. Everything
-- executes inside one transaction that is ROLLED BACK at the end, so it leaves no
-- residue and can be re-run. Failures raise (ASSERT / EXCEPTION) and abort.
--
--   supabase start
--   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
--        -v ON_ERROR_STOP=1 -f supabase/tests/054_quiz_server_grading.test.sql
--
-- Expected final line: "054 ALL TESTS PASSED".
-- ─────────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ──────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at)
  VALUES ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','rep@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a0','t54','T54');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='Rep'
  WHERE id='00000000-0000-0000-0000-0000000000a1';
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','Q1','[
   {"id":"q1","type":"mc","options":["A","B","C"],"correct":1},
   {"id":"q2","type":"tf","options":["True","False"],"correct":0},
   {"id":"q3","type":"type","acceptedAnswers":["Paris","London"]},
   {"id":"q4","type":"slider","correct":5,"tolerance":1},
   {"id":"q5","type":"match","pairs":[{"left":"a","right":"1"},{"left":"b","right":"2"}]},
   {"id":"q6","type":"open"}
 ]'::jsonb,'active',false,NULL),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a0','Q2','[
   {"id":"s1","type":"slider","correct":0,"tolerance":1},{"id":"s2","type":"mc","options":["A","B"],"correct":0}
 ]'::jsonb,'active',false,80);

-- Bind the authenticated identity for the whole transaction (auth.uid()).
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

-- ── 1. Pure grader parity (mirrors isAnswerCorrect) ───────────────────────────
DO $$ BEGIN
  ASSERT public._quiz_answer_is_correct('{"type":"mc","correct":1}'::jsonb, '1'::jsonb),                 'mc correct';
  ASSERT NOT public._quiz_answer_is_correct('{"type":"mc","correct":1}'::jsonb, '0'::jsonb),             'mc wrong';
  ASSERT public._quiz_answer_is_correct('{"type":"tf","correct":0}'::jsonb, '0'::jsonb),                 'tf correct';
  ASSERT public._quiz_answer_is_correct('{"type":"slider","correct":5,"tolerance":1}'::jsonb,'6'::jsonb),'slider boundary';
  ASSERT NOT public._quiz_answer_is_correct('{"type":"slider","correct":5,"tolerance":1}'::jsonb,'7'::jsonb),'slider out';
  ASSERT public._quiz_answer_is_correct('{"type":"slider","correct":0,"tolerance":1}'::jsonb,'0'::jsonb),'slider 0 valid';
  ASSERT public._quiz_answer_is_correct('{"type":"type","acceptedAnswers":["Paris"]}'::jsonb,'"  paris "'::jsonb),'type norm';
  ASSERT public._quiz_answer_is_correct('{"type":"match","pairs":[{"right":"1"},{"right":"2"}]}'::jsonb,
         '[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"2"}]'::jsonb),'match all';
  ASSERT NOT public._quiz_answer_is_correct('{"type":"match","pairs":[{"right":"1"},{"right":"2"}]}'::jsonb,
         '[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"9"}]'::jsonb),'match partial=wrong';
  ASSERT public._quiz_answer_is_correct('{"type":"open"}'::jsonb,'"essay"'::jsonb),'open answered';
  ASSERT NOT public._quiz_answer_is_correct('{"type":"unknown"}'::jsonb,'"x"'::jsonb),'unknown=false';
  RAISE NOTICE '1. grader parity: PASS';
END $$;

-- ── 2. RPC scoring parity + passing default 100 + sanitized answers ───────────
DO $$
DECLARE r jsonb; rev text; a jsonb;
BEGIN
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  -- all correct -> 100 passed(default 100)
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":1,"correct":999,"isCorrect":false},
    {"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},{"questionId":"q4","selected":5},
    {"questionId":"q5","selected":[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"2"}]},
    {"questionId":"q6","selected":"essay"}]'::jsonb, rev, gen_random_uuid());
  ASSERT (r->>'server_score')='100' AND (r->>'server_passed')='true', 'all-correct 100/passed';
  -- sanitized answers: client "correct":999/"isCorrect":false must be overwritten by server truth
  a := (r->'attempt'->'answers')->0;   -- q1
  ASSERT (a->>'correct')='1', 'q1 correct overwritten to canonical 1 (was 999)';
  ASSERT (a->>'isCorrect')='true', 'q1 server isCorrect=true';
  ASSERT (a->'selected')::text='1', 'q1 selected preserved';
  ASSERT ((r->'attempt'->'answers')->5->>'isCorrect') IS NULL, 'open isCorrect NULL (manual)';

  -- one wrong -> 80, fail against default 100
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":0},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
    {"questionId":"q4","selected":5},{"questionId":"q5","selected":[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"2"}]},
    {"questionId":"q6","selected":null}]'::jsonb, rev, gen_random_uuid());
  ASSERT (r->>'server_score')='80' AND (r->>'server_passed')='false', 'one-wrong 80/fail@100';

  -- Q2 passing_score=80 with Slider 0 -> 100/passed
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f2';
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f2',
       '[{"questionId":"s1","selected":0},{"questionId":"s2","selected":0}]'::jsonb, rev, gen_random_uuid());
  ASSERT (r->>'server_score')='100' AND (r->>'server_passed')='true', 'Q2 slider0 100/passed@80';
  RAISE NOTICE '2. rpc scoring + passing-100 + sanitization: PASS';
END $$;

-- ── 3. Revision race: stale revision inserts nothing ──────────────────────────
DO $$
DECLARE r jsonb; before_ct int; after_ct int;
BEGIN
  SELECT count(*) INTO before_ct FROM public.quiz_attempts;
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
       '[{"questionId":"q1","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
         {"questionId":"q4","selected":5},{"questionId":"q5","selected":[]},{"questionId":"q6","selected":null}]'::jsonb,
       'STALE_REVISION', gen_random_uuid());
  SELECT count(*) INTO after_ct FROM public.quiz_attempts;
  ASSERT (r->>'status')='quiz_changed' AND (r->>'retryable')='true', 'stale -> quiz_changed';
  ASSERT before_ct = after_ct, 'stale -> no insert';
  RAISE NOTICE '3. revision race: PASS';
END $$;

-- ── 4. Malformed payloads reject ──────────────────────────────────────────────
DO $$
DECLARE rev text; got text;
BEGIN
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  BEGIN
    PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
      '[{"questionId":"q1","selected":1}]'::jsonb, rev, gen_random_uuid());
    RAISE EXCEPTION 'malformed count should have failed';
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%answer count%', 'wrong-count rejected';
  BEGIN
    PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
      '[{"questionId":"qX","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
        {"questionId":"q4","selected":5},{"questionId":"q5","selected":[]},{"questionId":"q6","selected":null}]'::jsonb,
      rev, gen_random_uuid());
    RAISE EXCEPTION 'misaligned should have failed';
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%misaligned%', 'misaligned rejected';
  RAISE NOTICE '4. malformed payloads: PASS';
END $$;

-- ── 5. Idempotency + XP-once + provenance ─────────────────────────────────────
DO $$
DECLARE rev text; r1 jsonb; r2 jsonb; att int; xp int; prov text; key uuid := gen_random_uuid();
BEGIN
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  r1 := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
    {"questionId":"q4","selected":5},{"questionId":"q5","selected":[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"2"}]},
    {"questionId":"q6","selected":"x"}]'::jsonb, rev, key);
  r2 := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
    {"questionId":"q4","selected":5},{"questionId":"q5","selected":[{"leftIdx":0,"rightText":"1"},{"leftIdx":1,"rightText":"2"}]},
    {"questionId":"q6","selected":"x"}]'::jsonb, rev, key);
  ASSERT (r1->>'alreadyRecorded')='false' AND (r2->>'alreadyRecorded')='true', 'idempotent dedup';
  ASSERT (r1->>'pointsAwarded')::int > 0 AND (r2->>'pointsAwarded')='0', 'XP awarded once, not on the dedup';
  SELECT count(*) INTO att FROM public.quiz_attempts WHERE idempotency_key=key;
  ASSERT att=1, 'exactly one attempt for the key';
  SELECT grading_provenance INTO prov FROM public.quiz_attempts WHERE idempotency_key=key;
  ASSERT prov='server_v2', 'provenance server_v2';
  RAISE NOTICE '5. idempotency + provenance: PASS';
END $$;

-- ── 6. Provenance spoof lockdown (column privileges) ──────────────────────────
DO $$ BEGIN
  ASSERT NOT has_column_privilege('authenticated','public.quiz_attempts','grading_provenance','INSERT'), 'no provenance insert';
  ASSERT NOT has_column_privilege('authenticated','public.quiz_attempts','verified_revision','INSERT'),  'no revision insert';
  ASSERT NOT has_column_privilege('authenticated','public.quiz_attempts','graded_at','INSERT'),          'no graded_at insert';
  ASSERT has_column_privilege('authenticated','public.quiz_attempts','score','INSERT'),                  'base col insertable';
  ASSERT NOT has_function_privilege('anon','public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid)','EXECUTE'), 'anon no exec';
  ASSERT has_function_privilege('authenticated','public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid)','EXECUTE'), 'auth exec';
  RAISE NOTICE '6. provenance lockdown: PASS';
END $$;

-- ── 7. Auth / tenant gates ────────────────────────────────────────────────────
DO $$
DECLARE rev text; got text;
BEGIN
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  PERFORM set_config('request.jwt.claims','{"role":"authenticated"}', true);   -- no sub
  BEGIN PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[]'::jsonb,rev,gen_random_uuid());
        RAISE EXCEPTION 'unauth should fail'; EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%must be authenticated%', 'auth gate';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  BEGIN PERFORM public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000b9','00000000-0000-0000-0000-0000000000f1','[]'::jsonb,rev,gen_random_uuid());
        RAISE EXCEPTION 'tenant should fail'; EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%tenant mismatch%', 'tenant gate';
  RAISE NOTICE '7. auth/tenant gates: PASS';
END $$;

ROLLBACK;
\echo '054 ALL TESTS PASSED'
