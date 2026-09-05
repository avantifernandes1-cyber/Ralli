-- Repeatable tests for migration 088 (Readiness V2 automation — S1: eligible-attempt enqueue + queue consumer).
-- Proves: an eligible verified current-version server_v2 attempt by an active scorable learner in a tenant
-- with an ACTIVE v2 config enqueues EXACTLY ONE coalesced ACTIVE 'quiz_attempt' job, in the same transaction
-- as the attempt (rolled-back attempt => no job); legacy/unverified/stale-revision/cross-tenant/no-active-v2/
-- inactive-user/manager-admin attempts never enqueue; same-idempotency-key replay adds no duplicate attempt or
-- job; multiple eligible attempts coalesce to one live job; one consumer run computes the correct ACTIVE v2
-- version and completes the job; reprocessing unchanged evidence adds no duplicate material history; retry/
-- backoff/dead-letter is correct; claim is FOR UPDATE SKIP LOCKED; no learner can invoke processing or write
-- scores; legacy readiness_scores unchanged; queue source_ref carries no answers/content. One rolled-back
-- transaction. Local only. Expect "088 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── helpers ──────────────────────────────────────────────────────────────────
CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '088 FAIL: %', label; END IF; END $$;

CREATE FUNCTION pg_temp.as_user(p_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '{"role":"anon"}' ELSE '{"sub":"'||p_uid||'","role":"authenticated"}' END, true);
$$;

-- count of live (pending|processing) ACTIVE-target jobs for a rep
CREATE FUNCTION pg_temp.active_jobs(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_recalc_queue
   WHERE tenant_id=p_tenant AND user_id=p_user AND target_key='ACTIVE' AND status IN ('pending','processing');
$$;

-- insert a server_v2 attempt (+ immutable snapshot + tag links) — this is an ELIGIBLE attempt shape.
CREATE FUNCTION pg_temp.mkatt(p_tenant uuid, p_user uuid, p_quiz uuid, p_score int, p_tags uuid[], p_rev text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_rev text;
BEGIN
  v_rev := COALESCE(p_rev, (SELECT question_revision FROM public.tenant_quizzes WHERE id=p_quiz));
  INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (p_tenant,p_user,p_quiz,p_score,p_score>=70,1,'[]'::jsonb,'server_v2',v_rev, now(), now())
  RETURNING id INTO v_id;
  INSERT INTO public.quiz_attempt_tag_snapshots(attempt_id,tenant_id,quiz_id,snapshot_source) VALUES (v_id,p_tenant,p_quiz,'grading');
  INSERT INTO public.quiz_attempt_tags(attempt_id,tag_id,tenant_id) SELECT v_id, t, p_tenant FROM unnest(p_tags) t;
  RETURN v_id;
END $$;

-- ── fixtures ─────────────────────────────────────────────────────────────────
-- Tenants: tA (has active v2), tB (active v1_legacy only → no active v2), tC (no formula version at all).
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','ma@t.test',now(),now()),  -- tA orgAdmin
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','r1@t.test',now(),now()),  -- tA user (main)
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','r2@t.test',now(),now()),  -- tA user
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','iu@t.test',now(),now()),  -- tA user INACTIVE
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','rb@t.test',now(),now()),  -- tB user
 ('00000000-0000-0000-0000-0000000000c1','authenticated','authenticated','rc@t.test',now(),now());  -- tC user

INSERT INTO public.tenants (id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB'),
 ('00000000-0000-0000-0000-0000000000c0','tc','TC');
INSERT INTO public.tenant_settings (tenant_id, learning_settings) VALUES
 ('00000000-0000-0000-0000-0000000000a0','{"readinessThreshold":80}'),
 ('00000000-0000-0000-0000-0000000000b0','{}'),
 ('00000000-0000-0000-0000-0000000000c0','{}');

UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MA' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='inactive' WHERE id='00000000-0000-0000-0000-0000000000a3';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active' WHERE id='00000000-0000-0000-0000-0000000000b1';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000c0', status='active' WHERE id='00000000-0000-0000-0000-0000000000c1';

-- Formula versions: tA active V2 (with designations), tB active v1_legacy, tC none.
INSERT INTO public.readiness_formula_versions (id,tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at) VALUES
 ('00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000000a0',2,'active',
    '{"model":"v2_quiz_mastery","params":{"halfLifeDays":60,"staleDays":120,"attemptCap":3,"minQuizzes":3,"minTags":2,"minQuestions":10,"bands":{"ready":80,"developing":65}}}'::jsonb,
    80,'h_fa02','tenant_customized',now(),now()),
 ('00000000-0000-0000-0000-00000000fb01','00000000-0000-0000-0000-0000000000b0',1,'active',
    '{"model":"v1_legacy","weights":{"game":0.25,"learning":0.35,"quiz":0.40}}'::jsonb,80,'h_fb01','ralli_default',now(),now());

-- Tags (tA): Product, Objections — both designated REQUIRED on the active v2 version.
INSERT INTO public.tenant_quiz_tags (id,tenant_id,label,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0','Product','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0','Objections','00000000-0000-0000-0000-0000000000a9');
INSERT INTO public.readiness_tag_designations (tenant_id,formula_version_id,tag_id,is_required,created_by) VALUES
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000d0001',true,'00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000d0002',true,'00000000-0000-0000-0000-0000000000a9');

-- Quizzes. question_revision is a GENERATED column (sha256 of questions) — never inserted; mkatt/submit
-- read the generated value. QA/QA2 (tA); QS (tA) 1-question gradeable quiz for the submit RPC; QB (tB).
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions,primary_readiness_tag_id,passing_score) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000000a0','QA','active',
   jsonb_build_array(jsonb_build_object('id','qa_a','type','mc'),jsonb_build_object('id','qa_b','type','tf')),'00000000-0000-0000-0000-0000000d0001',100),
 ('00000000-0000-0000-0000-0000000e00a2','00000000-0000-0000-0000-0000000000a0','QA2','active',
   jsonb_build_array(jsonb_build_object('id','qa2_a','type','mc')),'00000000-0000-0000-0000-0000000d0001',100),
 ('00000000-0000-0000-0000-0000000e00a5','00000000-0000-0000-0000-0000000000a0','QS','active',
   jsonb_build_array(jsonb_build_object('id','sq1','type','mc','correct',0,'options',jsonb_build_array('A','B'))),'00000000-0000-0000-0000-0000000d0001',100),
 ('00000000-0000-0000-0000-0000000e00b1','00000000-0000-0000-0000-0000000000b0','QB','active',
   jsonb_build_array(jsonb_build_object('id','qb_a','type','mc')),NULL,100);
INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00a2','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00a5','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0');

-- Capture legacy readiness_scores fingerprint BEFORE anything.
CREATE TEMP TABLE _legacy0 AS SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) AS m, count(*) n FROM public.readiness_scores;

-- convenience id constants via psql vars
\set tA '00000000-0000-0000-0000-0000000000a0'
\set tB '00000000-0000-0000-0000-0000000000b0'
\set tC '00000000-0000-0000-0000-0000000000c0'
\set r1 '00000000-0000-0000-0000-0000000000a1'
\set r2 '00000000-0000-0000-0000-0000000000a2'
\set iu '00000000-0000-0000-0000-0000000000a3'
\set ma '00000000-0000-0000-0000-0000000000a9'
\set rb '00000000-0000-0000-0000-0000000000b1'
\set rc '00000000-0000-0000-0000-0000000000c1'
\set fa02 '00000000-0000-0000-0000-00000000fa02'
\set qA '00000000-0000-0000-0000-0000000e00a1'
\set qA2 '00000000-0000-0000-0000-0000000e00a2'
\set qS '00000000-0000-0000-0000-0000000e00a5'
\set qB '00000000-0000-0000-0000-0000000e00b1'
\set pProd '00000000-0000-0000-0000-0000000d0001'
\set pObj '00000000-0000-0000-0000-0000000d0002'

-- ══ A. Eligible attempt → exactly one ACTIVE 'quiz_attempt' job; source_ref content-safe ══
DELETE FROM public.readiness_recalc_queue;
SELECT pg_temp.mkatt(:'tA', :'r1', :'qA', 90, ARRAY[:'pProd'::uuid, :'pObj'::uuid]);
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r1')=1, 'A1: eligible attempt enqueues exactly one ACTIVE job');
SELECT pg_temp.ok(
  (SELECT reason FROM public.readiness_recalc_queue WHERE tenant_id=:'tA' AND user_id=:'r1')='quiz_attempt',
  'A2: reason is quiz_attempt');
SELECT pg_temp.ok(
  (SELECT (source_ref ? 'attemptId') AND (source_ref ? 'quizId')
     AND NOT (source_ref ? 'answers') AND NOT (source_ref ? 'score')
     AND (SELECT count(*) FROM jsonb_object_keys(source_ref))=2
   FROM public.readiness_recalc_queue WHERE tenant_id=:'tA' AND user_id=:'r1'),
  'A3: source_ref carries only {attemptId,quizId} (no answers/score/content)');

-- ══ B. Atomicity: rolled-back attempt leaves no job ══
DELETE FROM public.readiness_recalc_queue;
SAVEPOINT sp_atomic;
  SELECT pg_temp.mkatt(:'tA', :'r2', :'qA', 80, ARRAY[:'pProd'::uuid]);
  SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r2')=1, 'B1: attempt+enqueue visible in same transaction');
ROLLBACK TO sp_atomic;
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r2')=0, 'B2: rolled-back attempt leaves NO queue job (atomic)');
SELECT pg_temp.ok((SELECT count(*) FROM public.quiz_attempts WHERE user_id=:'r2')=0, 'B3: rolled-back attempt row also gone');

-- ══ C. Negatives: none of these enqueue ══
DELETE FROM public.readiness_recalc_queue;
-- legacy (provenance null)
INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,created_at)
  VALUES (:'tA',:'r1',:'qA',90,true,1,'[]'::jsonb,now());
-- unverified (server_v2 but verified_revision null)
INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (:'tA',:'r1',:'qA',90,true,1,'[]'::jsonb,'server_v2',NULL,now(),now());
-- stale revision (server_v2, verified_revision <> current)
INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (:'tA',:'r1',:'qA',90,true,1,'[]'::jsonb,'server_v2','OLDREV',now(),now());
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r1')=0, 'C1: legacy/unverified/stale-revision do not enqueue');
-- inactive user (eligible shape, inactive rep)
SELECT pg_temp.mkatt(:'tA', :'iu', :'qA', 90, ARRAY[:'pProd'::uuid]);
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'iu')=0, 'C2: inactive user does not enqueue');
-- manager/admin (orgAdmin)
SELECT pg_temp.mkatt(:'tA', :'ma', :'qA', 90, ARRAY[:'pProd'::uuid]);
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'ma')=0, 'C3: manager/admin does not enqueue');
-- cross-tenant / tenant WITHOUT active v2 (tB has only v1_legacy active)
SELECT pg_temp.mkatt(:'tB', :'rb', :'qB', 90, ARRAY[]::uuid[]);
SELECT pg_temp.ok(pg_temp.active_jobs(:'tB', :'rb')=0, 'C4: tenant without active v2 (and cross-tenant) does not enqueue');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE status IN ('pending','processing'))=0, 'C5: no live jobs created by any negative case');

-- ══ D. Coalescing: multiple eligible attempts → one live ACTIVE job ══
DELETE FROM public.readiness_recalc_queue;
SELECT pg_temp.mkatt(:'tA', :'r2', :'qA',  85, ARRAY[:'pProd'::uuid, :'pObj'::uuid]);
SELECT pg_temp.mkatt(:'tA', :'r2', :'qA2', 95, ARRAY[:'pProd'::uuid]);
SELECT pg_temp.mkatt(:'tA', :'r2', :'qA',  75, ARRAY[:'pObj'::uuid]);
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r2')=1, 'D1: three eligible attempts coalesce to ONE live ACTIVE job');

-- ══ E. Consumer run computes the correct ACTIVE v2 version and completes the job ══
SELECT public.readiness_process_recalc_batch(50,'cron');
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r2')=0, 'E1: consumer drained the live job');
SELECT pg_temp.ok((SELECT status FROM public.readiness_recalc_queue WHERE tenant_id=:'tA' AND user_id=:'r2' ORDER BY updated_at DESC LIMIT 1)='completed', 'E2: job marked completed');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM public.readiness_scores_current WHERE tenant_id=:'tA' AND user_id=:'r2' AND formula_version_id=:'fa02'), 'E3: score computed under the ACTIVE v2 version');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_scores_current WHERE tenant_id=:'tA' AND user_id=:'r2' AND formula_version_id<>:'fa02')=0, 'E4: no score written under any other version');

-- ══ F. Reprocessing UNCHANGED evidence adds no duplicate material history ══
CREATE TEMP TABLE _hist0 AS SELECT count(*) n FROM public.readiness_score_history WHERE tenant_id=:'tA' AND user_id=:'r2' AND formula_version_id=:'fa02';
SELECT public.enqueue_readiness_recalc(:'tA', :'r2', NULL, 'manual', '{}'::jsonb);  -- re-enqueue, NO new evidence
SELECT public.readiness_process_recalc_batch(50,'cron');
SELECT pg_temp.ok(
  (SELECT count(*) FROM public.readiness_score_history WHERE tenant_id=:'tA' AND user_id=:'r2' AND formula_version_id=:'fa02') = (SELECT n FROM _hist0),
  'F1: reprocessing unchanged evidence appends no duplicate history row');

-- ══ G. Retry / backoff / dead-letter (tenant tC has NO active version → compute fails) ══
DELETE FROM public.readiness_recalc_queue;
INSERT INTO public.readiness_recalc_queue(tenant_id,user_id,formula_version_id,reason) VALUES (:'tC',:'rc',NULL,'manual');
SELECT public.readiness_process_recalc_batch(50,'cron');
SELECT pg_temp.ok(
  (SELECT status='pending' AND attempt_count=1 AND next_attempt_at>now() AND last_error IS NOT NULL
     FROM public.readiness_recalc_queue WHERE tenant_id=:'tC' AND user_id=:'rc'),
  'G1: failing job backs off (pending, attempt_count=1, future next_attempt_at, last_error set)');
UPDATE public.readiness_recalc_queue SET attempt_count=5, status='pending', next_attempt_at=now()-interval '1 min' WHERE tenant_id=:'tC' AND user_id=:'rc';
SELECT public.readiness_process_recalc_batch(50,'cron');
SELECT pg_temp.ok(
  (SELECT status='dead_letter' FROM public.readiness_recalc_queue WHERE tenant_id=:'tC' AND user_id=:'rc'),
  'G2: after max attempts the job is dead-lettered (bounded retries)');

-- ══ H. Idempotency-key replay via the submit RPC → no duplicate attempt or job ══
DELETE FROM public.readiness_recalc_queue;
SELECT question_revision AS revs FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000e00a5' \gset
SELECT pg_temp.as_user(:'r1');
SELECT public.submit_quiz_attempt_atomic_v2(:'tA', :'qS', '[{"questionId":"sq1","selected":0}]'::jsonb, :'revs', '00000000-0000-0000-0000-0000000ab001');
SELECT public.submit_quiz_attempt_atomic_v2(:'tA', :'qS', '[{"questionId":"sq1","selected":0}]'::jsonb, :'revs', '00000000-0000-0000-0000-0000000ab001');
SELECT set_config('request.jwt.claims','', true);
SELECT pg_temp.ok((SELECT count(*) FROM public.quiz_attempts WHERE idempotency_key='00000000-0000-0000-0000-0000000ab001')=1, 'H1: idempotency-key replay creates no duplicate attempt');
SELECT pg_temp.ok(pg_temp.active_jobs(:'tA', :'r1')=1, 'H2: idempotency-key replay creates no duplicate ACTIVE job (exactly one)');

-- ══ I. Security / structural invariants ══
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.readiness_process_recalc_batch(integer,text,timestamp with time zone)','EXECUTE'), 'I1: authenticated cannot execute the batch processor');
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.readiness_process_recalc_batch(integer,text,timestamp with time zone)','EXECUTE'), 'I2: anon cannot execute the batch processor');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.quiz_attempts_enqueue_readiness_recalc()','EXECUTE'), 'I3: authenticated cannot execute the enqueue trigger fn');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.readiness_scores_current','INSERT') AND NOT has_table_privilege('authenticated','public.readiness_scores_current','UPDATE'), 'I4: learners cannot write readiness scores');
SELECT pg_temp.ok(position('SKIP LOCKED' in pg_get_functiondef('public.readiness_process_recalc_batch'::regproc))>0, 'I5: claim uses FOR UPDATE SKIP LOCKED (concurrency-safe)');
SELECT pg_temp.ok((SELECT tgenabled FROM pg_trigger WHERE tgname='trg_enqueue_readiness_on_attempt')='O', 'I6: enqueue trigger is enabled');

-- ══ J. Legacy readiness_scores unchanged; dashboard path untouched ══
SELECT pg_temp.ok(
  (SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) FROM public.readiness_scores) = (SELECT m FROM _legacy0)
  AND (SELECT count(*) FROM public.readiness_scores) = (SELECT n FROM _legacy0),
  'J1: legacy readiness_scores unchanged (count + checksum) — dashboard path untouched');

SELECT '088 ALL TESTS PASSED' AS result;
ROLLBACK;
