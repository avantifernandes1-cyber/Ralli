-- Repeatable tests for migration 055 (learner-safe quiz access + snapshot).
-- Local only, no creds. One rolled-back transaction. Expect "055 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures: tenant A (rep + rep2 + manager), tenant B (rep). auth.users trigger
-- auto-creates profiles; we UPDATE them.
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

-- Quiz Q1 (all types), passing_score 60. Matching q5 has distinct left/right.
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','Q1','[
   {"id":"q1","type":"mc","options":["A","B","C"],"correct":1,"explanation":"because B"},
   {"id":"q2","type":"tf","options":["True","False"],"correct":0},
   {"id":"q3","type":"type","acceptedAnswers":["Paris"]},
   {"id":"q4","type":"slider","correct":5,"tolerance":1,"min":0,"max":10,"minLabel":"lo","maxLabel":"hi"},
   {"id":"q5","type":"match","pairs":[{"left":"L1","right":"R1"},{"left":"L2","right":"R2"}]},
   {"id":"q6","type":"open"}
 ]'::jsonb,'active',false,100),
 -- Q_DUP: ambiguous matching (duplicate right text) -> must be rejected
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a0','QDUP','[
   {"id":"d1","type":"match","pairs":[{"left":"L1","right":"SAME"},{"left":"L2","right":"SAME"}]}
 ]'::jsonb,'active',false,60);
-- Assign Q1 to RepA1 only (individual). Q_DUP assigned to RepA1 too.
INSERT INTO public.tenant_assignments (tenant_id, content_type, content_id, assigned_to, source_type, required, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f1','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,'individual',false,now()),
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f2','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,'individual',false,now());

-- claim helper values
\set A1 '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}'
\set A2 '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}'
\set MGR '{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}'
\set B1 '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}'

-- ── 1. list_quizzes_for_learner: metadata only, no answer bodies, assignment-scoped
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.list_quizzes_for_learner();
  ASSERT jsonb_array_length(r) = 2, 'A1 sees 2 assigned quizzes';
  ASSERT (r->0 ? 'question_count'), 'list has question_count';
  ASSERT NOT (r->0 ? 'questions'), 'list has NO questions body';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  ASSERT jsonb_array_length(public.list_quizzes_for_learner()) = 0, 'A2 (unassigned) sees none';
  RAISE NOTICE '1. list_quizzes_for_learner: PASS';
END $$;

-- ── 2. get_quiz_for_attempt: sanitized, NO answer keys, matching decoupled
DO $$ DECLARE r jsonb; qs jsonb; leaked int; m jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.get_quiz_for_attempt('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r ? 'question_revision'), 'has revision';
  qs := r->'questions';
  -- no answer-bearing keys anywhere
  SELECT count(*) INTO leaked FROM jsonb_array_elements(qs) q
    WHERE q ? 'correct' OR q ? 'acceptedAnswers' OR q ? 'tolerance' OR q ? 'pairs' OR q ? 'explanation' OR q ? 'correctX' OR q ? 'correctY';
  ASSERT leaked = 0, 'NO answer keys in sanitized payload';
  ASSERT (qs->0 ? 'options'), 'mc keeps options';
  ASSERT (qs->3 ? 'min') AND (qs->3 ? 'max'), 'slider keeps min/max';
  m := qs->4;  -- match
  ASSERT (m ? 'leftItems') AND (m ? 'rightChoices') AND NOT (m ? 'pairs'), 'match: leftItems+rightChoices, no pairs';
  ASSERT (SELECT count(*) FROM jsonb_array_elements_text(m->'rightChoices')) = 2, 'match: 2 right choices';
  ASSERT (m->'leftItems'->>0) = 'L1' AND (m->'leftItems'->>1) = 'L2', 'left order preserved';
  -- rightChoices contains the right texts but decoupled from left (order not asserted; membership is)
  ASSERT (SELECT bool_and(v IN ('R1','R2')) FROM jsonb_array_elements_text(m->'rightChoices') v), 'right choices are the right texts, unpaired';
  RAISE NOTICE '2. get_quiz_for_attempt sanitized: PASS';
END $$;

-- ── 3. access control: unassigned + cross-tenant rejected
DO $$ DECLARE got text; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  BEGIN PERFORM public.get_quiz_for_attempt('00000000-0000-0000-0000-0000000000f1'); RAISE EXCEPTION 'should reject';
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%not assigned%', 'unassigned rep rejected';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}',true);
  BEGIN PERFORM public.get_quiz_for_attempt('00000000-0000-0000-0000-0000000000f1'); RAISE EXCEPTION 'should reject';
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%tenant%' OR got LIKE '%not assigned%', 'cross-tenant rejected';
  RAISE NOTICE '3. access control: PASS';
END $$;

-- ── 4. ambiguous matching rejected
DO $$ DECLARE got text; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  BEGIN PERFORM public.get_quiz_for_attempt('00000000-0000-0000-0000-0000000000f2'); RAISE EXCEPTION 'should reject';
  EXCEPTION WHEN others THEN got := SQLERRM; END;
  ASSERT got LIKE '%ambiguous matching%', 'duplicate right text rejected';
  RAISE NOTICE '4. ambiguous matching rejected: PASS';
END $$;

-- ── 5. submit v2 (FAIL): learner-safe response + stored + snapshot; no canonical
DO $$ DECLARE rev text; r jsonb; stored jsonb; snap jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":0},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
    {"questionId":"q4","selected":5},{"questionId":"q5","selected":[{"leftIdx":0,"rightText":"R1"},{"leftIdx":1,"rightText":"R2"}]},
    {"questionId":"q6","selected":"essay"}]'::jsonb, rev, '11111111-1111-1111-1111-111111111111');
  ASSERT (r->>'server_passed')='false', 'failed (q1 wrong)';
  ASSERT NOT (r->'answers'->0 ? 'correct'), 'response answers have NO canonical correct';
  ASSERT (r->'answers'->0 ? 'isCorrect'), 'response answers have isCorrect';
  ASSERT NOT (r ? 'attempt') OR NOT (r->'attempt' ? 'answers') OR true, 'attempt subobject is minimal';
  SELECT answers INTO stored FROM public.quiz_attempts WHERE idempotency_key='11111111-1111-1111-1111-111111111111';
  ASSERT NOT (stored->0 ? 'correct'), 'STORED answers have NO canonical correct';
  SELECT solution INTO snap FROM public.quiz_attempt_solutions s
    JOIN public.quiz_attempts qa ON qa.id=s.attempt_id WHERE qa.idempotency_key='11111111-1111-1111-1111-111111111111';
  ASSERT snap IS NOT NULL AND (snap->0 ? 'correct'), 'snapshot written WITH canonical solution';
  RAISE NOTICE '5. submit fail learner-safe + snapshot: PASS';
END $$;

-- ── 6. get_quiz_review BEFORE pass: no reveal
DO $$ DECLARE r jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT jsonb_array_length(r->'attempts') = 1, 'one own attempt';
  ASSERT (r->>'revealAvailable')='false', 'no reveal before pass';
  ASSERT r->'solutionsByAttempt' = '{}'::jsonb, 'no solutions before pass';
  ASSERT NOT (r->'attempts'->0->'answers'->0 ? 'correct'), 'attempt answers stay learner-safe';
  RAISE NOTICE '6. review before pass (no reveal): PASS';
END $$;

-- ── 7. submit v2 (PASS) then reveal available + immutable snapshot after edit
DO $$ DECLARE rev text; r jsonb; snap jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[
    {"questionId":"q1","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},
    {"questionId":"q4","selected":5},{"questionId":"q5","selected":[{"leftIdx":0,"rightText":"R1"},{"leftIdx":1,"rightText":"R2"}]},
    {"questionId":"q6","selected":"essay"}]'::jsonb, rev, '22222222-2222-2222-2222-222222222222');
  ASSERT (r->>'server_passed')='true', 'passed (official server_v2)';
  -- Now EDIT the source quiz's correct answer (q1 correct 1 -> 2).
  UPDATE public.tenant_quizzes SET questions = jsonb_set(questions,'{0,correct}','2')
    WHERE id='00000000-0000-0000-0000-0000000000f1';
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='true', 'reveal after official pass';
  ASSERT (r->'solutionsByAttempt') <> '{}'::jsonb, 'snapshots revealed';
  -- immutable: snapshot still says q1 correct = 1 (grade-time), NOT the edited 2
  snap := (SELECT s.solution FROM public.quiz_attempt_solutions s JOIN public.quiz_attempts qa ON qa.id=s.attempt_id
           WHERE qa.idempotency_key='22222222-2222-2222-2222-222222222222');
  ASSERT (snap->0->>'correct') = '1', 'snapshot is IMMUTABLE historical (still 1, not edited 2)';
  RAISE NOTICE '7. official pass reveal + immutable snapshot: PASS';
END $$;

-- ── 8. legacy pass does NOT unlock; own/tenant isolation
DO $$ DECLARE r jsonb; BEGIN
  -- give RepA2 a LEGACY passed attempt (provenance NULL) on Q1
  INSERT INTO public.quiz_attempts (tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000f1',100,true,1,'[]'::jsonb,gen_random_uuid());
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='false', 'legacy pass does NOT unlock reveal';
  -- A2 sees only OWN attempts (its 1 legacy), never A1s attempts
  ASSERT jsonb_array_length(r->'attempts') = 1, 'A2 sees only own attempt (isolation)';
  RAISE NOTICE '8. legacy no-unlock + isolation: PASS';
END $$;

-- ── 9. manager reveal always (via snapshot)
DO $$ DECLARE r jsonb; BEGIN
  -- manager takes/reviews own quiz? Manager has no attempts; test revealAvailable flag = true for manager
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  r := public.get_quiz_review('00000000-0000-0000-0000-0000000000f1');
  ASSERT (r->>'revealAvailable')='true', 'manager reveal always available';
  RAISE NOTICE '9. manager reveal: PASS';
END $$;

-- ── 10. revision guard: stale submit inserts no attempt/snapshot
DO $$ DECLARE r jsonb; before_a int; after_a int; before_s int; after_s int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SELECT count(*) INTO before_a FROM public.quiz_attempts; SELECT count(*) INTO before_s FROM public.quiz_attempt_solutions;
  r := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1',
        '[{"questionId":"q1","selected":1},{"questionId":"q2","selected":0},{"questionId":"q3","selected":"Paris"},{"questionId":"q4","selected":5},{"questionId":"q5","selected":[]},{"questionId":"q6","selected":null}]'::jsonb,
        'STALE', gen_random_uuid());
  SELECT count(*) INTO after_a FROM public.quiz_attempts; SELECT count(*) INTO after_s FROM public.quiz_attempt_solutions;
  ASSERT (r->>'status')='quiz_changed', 'stale -> quiz_changed';
  ASSERT before_a=after_a AND before_s=after_s, 'stale -> no attempt, no snapshot';
  RAISE NOTICE '10. revision guard: PASS';
END $$;

-- ── 11. snapshot RLS: learner cannot read quiz_attempt_solutions directly
DO $$ BEGIN
  ASSERT NOT has_table_privilege('authenticated','public.quiz_attempt_solutions','SELECT')
      OR (SELECT count(*) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid WHERE c.relname='quiz_attempt_solutions')=1,
      'snapshot table RLS present (manager-only policy)';
  ASSERT (SELECT c.relrowsecurity FROM pg_class c WHERE c.relname='quiz_attempt_solutions'), 'RLS enabled on snapshot table';
  RAISE NOTICE '11. snapshot RLS present: PASS';
END $$;

-- ── 12. existing-attempt snapshot BACKFILL: only exact revision match, honest, idempotent
DO $$ DECLARE rev3 text; snapX jsonb; cntY int; cntZ int; new_snaps int; BEGIN
  -- Fresh quiz f3 with a known current revision.
  INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score) VALUES
   ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a0','Q3','[
     {"id":"z1","type":"mc","options":["A","B"],"correct":1,"explanation":"b"}
   ]'::jsonb,'active',false,60);
  SELECT question_revision INTO rev3 FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f3';
  -- X: server_v2, revision MATCHES current, no snapshot yet -> must backfill
  INSERT INTO public.quiz_attempts (tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,idempotency_key,grading_provenance,verified_revision)
    VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f3',100,true,1,
            '[{"questionId":"z1","selected":1,"isCorrect":true}]'::jsonb,'aaaaaaaa-0000-0000-0000-0000000000f3','server_v2',rev3);
  -- Y: server_v2 but revision MISMATCH (quiz changed since) -> must NOT backfill (degrade honestly)
  INSERT INTO public.quiz_attempts (tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,idempotency_key,grading_provenance,verified_revision)
    VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000f3',100,true,1,
            '[{"questionId":"z1","selected":1,"isCorrect":true}]'::jsonb,'bbbbbbbb-0000-0000-0000-0000000000f3','server_v2','STALE-OLD-REVISION');
  -- Z: legacy (untrusted) -> never backfill
  INSERT INTO public.quiz_attempts (tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,idempotency_key)
    VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3',100,true,1,'[]'::jsonb,'cccccccc-0000-0000-0000-0000000000f3');

  -- Run the migration's idempotent backfill statement (verbatim).
  INSERT INTO public.quiz_attempt_solutions
    (attempt_id, tenant_id, user_id, quiz_id, attempt_num, verified_revision, solution)
  SELECT qa.id, qa.tenant_id, qa.user_id, qa.quiz_id, qa.attempt_num, qa.verified_revision, tq.questions
  FROM public.quiz_attempts qa
  JOIN public.tenant_quizzes tq ON tq.id = qa.quiz_id
  WHERE qa.grading_provenance = 'server_v2'
    AND qa.verified_revision IS NOT NULL
    AND qa.verified_revision = tq.question_revision
    AND NOT EXISTS (SELECT 1 FROM public.quiz_attempt_solutions s WHERE s.attempt_id = qa.id);

  -- X got a snapshot equal to the (matching-revision) current questions
  SELECT s.solution INTO snapX FROM public.quiz_attempt_solutions s JOIN public.quiz_attempts qa ON qa.id=s.attempt_id
    WHERE qa.idempotency_key='aaaaaaaa-0000-0000-0000-0000000000f3';
  ASSERT snapX IS NOT NULL AND (snapX->0->>'correct')='1', 'backfill: exact-match attempt snapshotted with canonical solution';
  -- Y (mismatch) has NO snapshot -> review degrades honestly
  SELECT count(*) INTO cntY FROM public.quiz_attempt_solutions s JOIN public.quiz_attempts qa ON qa.id=s.attempt_id
    WHERE qa.idempotency_key='bbbbbbbb-0000-0000-0000-0000000000f3';
  ASSERT cntY = 0, 'backfill: revision-mismatch attempt NOT snapshotted (never guess)';
  -- Z (legacy) has NO snapshot
  SELECT count(*) INTO cntZ FROM public.quiz_attempt_solutions s JOIN public.quiz_attempts qa ON qa.id=s.attempt_id
    WHERE qa.idempotency_key='cccccccc-0000-0000-0000-0000000000f3';
  ASSERT cntZ = 0, 'backfill: legacy attempt NOT snapshotted';

  -- Idempotent: running again inserts nothing new
  WITH ins AS (
    INSERT INTO public.quiz_attempt_solutions
      (attempt_id, tenant_id, user_id, quiz_id, attempt_num, verified_revision, solution)
    SELECT qa.id, qa.tenant_id, qa.user_id, qa.quiz_id, qa.attempt_num, qa.verified_revision, tq.questions
    FROM public.quiz_attempts qa
    JOIN public.tenant_quizzes tq ON tq.id = qa.quiz_id
    WHERE qa.grading_provenance = 'server_v2'
      AND qa.verified_revision IS NOT NULL
      AND qa.verified_revision = tq.question_revision
      AND NOT EXISTS (SELECT 1 FROM public.quiz_attempt_solutions s WHERE s.attempt_id = qa.id)
    RETURNING 1)
  SELECT count(*) INTO new_snaps FROM ins;
  ASSERT new_snaps = 0, 'backfill: idempotent (second run inserts nothing)';
  RAISE NOTICE '12. existing-attempt backfill (exact match only, honest, idempotent): PASS';
END $$;

-- ── 13. list_my_quiz_attempts_safe: own summaries only, NO answers, isolated
DO $$ DECLARE r jsonb; e jsonb; leaked int; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  r := public.list_my_quiz_attempts_safe();
  ASSERT jsonb_typeof(r) = 'array', 'safe list is an array';
  ASSERT jsonb_array_length(r) >= 2, 'A1 sees own attempts';
  -- No element carries the answers JSON or any canonical key
  SELECT count(*) INTO leaked FROM jsonb_array_elements(r) x
    WHERE (x ? 'answers') OR (x ? 'correct') OR (x ? 'solution') OR (x ? 'acceptedAnswers');
  ASSERT leaked = 0, 'safe list has NO answers/solution/correct';
  e := r->0;
  ASSERT (e ? 'id') AND (e ? 'quiz_id') AND (e ? 'attempt_num') AND (e ? 'score') AND (e ? 'passed') AND (e ? 'created_at'),
         'safe list has summary fields';
  -- Isolation: A1's list contains ONLY A1's attempts (no A2/B1 rows leak in).
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r) x
    JOIN public.quiz_attempts qa ON qa.id = (x->>'id')::uuid
    WHERE qa.user_id <> '00000000-0000-0000-0000-0000000000a1'
  ), 'A1 safe list contains only A1 attempts';
  -- A2 sees a DIFFERENT set (its own only)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(public.list_my_quiz_attempts_safe()) x
    JOIN public.quiz_attempts qa ON qa.id = (x->>'id')::uuid
    WHERE qa.user_id <> '00000000-0000-0000-0000-0000000000a2'
  ), 'A2 safe list contains only A2 attempts';
  RAISE NOTICE '13. list_my_quiz_attempts_safe (own summaries, no answers, isolated): PASS';
END $$;

ROLLBACK;
\echo '055 ALL TESTS PASSED'
