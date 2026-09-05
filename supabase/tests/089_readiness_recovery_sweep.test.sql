-- Repeatable tests for migration 089 (missed-enqueue recovery, Phase 088B-1).
-- Proves: stale-watermark recovery; missing-current-row recovery (with eligible evidence); up-to-date
-- exclusion; no-evidence exclusion (missing row alone is NOT a reason); no-active-v2 exclusion; coalescing
-- (no duplicate live job); idempotent rerun; bounded per-tenant batching with NO starvation (live-job
-- exclusion advances coverage) AND drain-based convergence; tenant isolation + p_tenant scoping; no
-- duplicate history on unchanged material; server-only grants; legacy readiness_scores untouched.
-- One rolled-back transaction. Local only. Expect "089 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '089 FAIL: %', label; END IF; END $$;

-- live (pending|processing) ACTIVE backfill/any jobs for a rep
CREATE FUNCTION pg_temp.live_jobs(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_recalc_queue
   WHERE tenant_id=p_tenant AND user_id=p_user AND target_key='ACTIVE' AND status IN ('pending','processing');
$$;

-- eligible server_v2 attempt (+ snapshot + tag) created age_hours ago
CREATE FUNCTION pg_temp.mkatt(p_tenant uuid, p_user uuid, p_quiz uuid, p_score int, p_tag uuid, p_age_hours numeric DEFAULT 0)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_rev text; v_ts timestamptz := now() - (p_age_hours||' hours')::interval;
BEGIN
  v_rev := (SELECT question_revision FROM public.tenant_quizzes WHERE id=p_quiz);
  INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (p_tenant,p_user,p_quiz,p_score,p_score>=70,1,'[]'::jsonb,'server_v2',v_rev,v_ts,v_ts) RETURNING id INTO v_id;
  INSERT INTO public.quiz_attempt_tag_snapshots(attempt_id,tenant_id,quiz_id,snapshot_source) VALUES (v_id,p_tenant,p_quiz,'grading');
  INSERT INTO public.quiz_attempt_tags(attempt_id,tag_id,tenant_id) VALUES (v_id,p_tag,p_tenant);
  RETURN v_id;
END $$;

-- seed a scores_current row with an explicit watermark (last_attempt_at)
CREATE FUNCTION pg_temp.set_watermark(p_tenant uuid, p_user uuid, p_version uuid, p_wm timestamptz)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.readiness_scores_current(tenant_id,user_id,formula_version_id,success_status,overall_score,calculated_at,calculated_config_hash,last_attempt_at,last_attempt_status)
  VALUES (p_tenant,p_user,p_version,'insufficient_evidence',NULL,p_wm,'h',p_wm,'insufficient_evidence');
$$;

-- ── fixtures: TA & TB have active v2; TC has none ──
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','a2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','a3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a4','authenticated','authenticated','a4@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a5','authenticated','authenticated','a5@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','b1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b2','authenticated','authenticated','b2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b3','authenticated','authenticated','b3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c1','authenticated','authenticated','c1@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),('00000000-0000-0000-0000-0000000000b0','tb','TB'),('00000000-0000-0000-0000-0000000000c0','tc','TC');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES
 ('00000000-0000-0000-0000-0000000000a0','{}'),('00000000-0000-0000-0000-0000000000b0','{}'),('00000000-0000-0000-0000-0000000000c0','{}');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000a5');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000b0',status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2','00000000-0000-0000-0000-0000000000b3');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000c0',status='active' WHERE id='00000000-0000-0000-0000-0000000000c1';
-- active v2 for TA, TB; v1_legacy (no v2) for TC
INSERT INTO public.readiness_formula_versions(id,tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at) VALUES
 ('00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000000a0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now()),
 ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000b0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now()),
 ('00000000-0000-0000-0000-00000000fc01','00000000-0000-0000-0000-0000000000c0',1,'active','{"model":"v1_legacy"}'::jsonb,80,'h','ralli_default',now(),now());
INSERT INTO public.tenant_quiz_tags(id,tenant_id,label,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0','ProdA','00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000b0','ProdB','00000000-0000-0000-0000-0000000000b1'),
 ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000c0','ProdC','00000000-0000-0000-0000-0000000000c1');
INSERT INTO public.readiness_tag_designations(tenant_id,formula_version_id,tag_id,is_required,created_by) VALUES
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000d0001',true,'00000000-0000-0000-0000-0000000000a1'),
 ('00000000-0000-0000-0000-0000000000b0','00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000d0002',true,'00000000-0000-0000-0000-0000000000b1');
INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,questions,primary_readiness_tag_id,passing_score) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000000a0','QA','active',jsonb_build_array(jsonb_build_object('id','qa','type','mc')),'00000000-0000-0000-0000-0000000d0001',100),
 ('00000000-0000-0000-0000-0000000e00b1','00000000-0000-0000-0000-0000000000b0','QB','active',jsonb_build_array(jsonb_build_object('id','qb','type','mc')),'00000000-0000-0000-0000-0000000d0002',100),
 ('00000000-0000-0000-0000-0000000e00c1','00000000-0000-0000-0000-0000000000c0','QC','active',jsonb_build_array(jsonb_build_object('id','qc','type','mc')),NULL,100);
INSERT INTO public.quiz_tag_map(quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00b1','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000b0'),
 ('00000000-0000-0000-0000-0000000e00c1','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000c0');

\set TA '00000000-0000-0000-0000-0000000000a0'
\set TB '00000000-0000-0000-0000-0000000000b0'
\set TC '00000000-0000-0000-0000-0000000000c0'
\set Va '00000000-0000-0000-0000-00000000fa02'
\set Vb '00000000-0000-0000-0000-00000000fb02'
\set a1 '00000000-0000-0000-0000-0000000000a1'
\set a2 '00000000-0000-0000-0000-0000000000a2'
\set a3 '00000000-0000-0000-0000-0000000000a3'
\set a4 '00000000-0000-0000-0000-0000000000a4'
\set a5 '00000000-0000-0000-0000-0000000000a5'
\set b1 '00000000-0000-0000-0000-0000000000b1'
\set b2 '00000000-0000-0000-0000-0000000000b2'
\set b3 '00000000-0000-0000-0000-0000000000b3'
\set c1 '00000000-0000-0000-0000-0000000000c1'
\set qa '00000000-0000-0000-0000-0000000e00a1'
\set qb '00000000-0000-0000-0000-0000000e00b1'
\set qc '00000000-0000-0000-0000-0000000e00c1'
\set gA '00000000-0000-0000-0000-0000000d0001'
\set gB '00000000-0000-0000-0000-0000000d0002'
\set gC '00000000-0000-0000-0000-0000000d0003'

CREATE TEMP TABLE _legacy0 AS SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) m, count(*) n FROM public.readiness_scores;

-- Rep states in TA:
-- a1 STALE:     current watermark 1 day ago; eligible attempt now  -> behind -> enqueue
-- a2 MISSING:   eligible attempt now; NO current row               -> enqueue
-- a3 UP-TO-DATE:eligible attempt 2h ago; watermark 1h ago (newer)  -> NOT
-- a4 NO-EVID:   only a legacy (null-provenance) attempt; no row     -> NOT
-- a5 COALESCE:  eligible attempt now; watermark 1 day ago (behind); pre-existing pending job -> NOT double
SELECT pg_temp.set_watermark(:'TA',:'a1',:'Va', now()-interval '1 day');
SELECT pg_temp.mkatt(:'TA',:'a1',:'qa',90,:'gA',0);
SELECT pg_temp.mkatt(:'TA',:'a2',:'qa',90,:'gA',0);
SELECT pg_temp.mkatt(:'TA',:'a3',:'qa',90,:'gA',2);
SELECT pg_temp.set_watermark(:'TA',:'a3',:'Va', now()-interval '1 hour');
INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,created_at)
  VALUES (:'TA',:'a4',:'qa',90,true,1,'[]'::jsonb,now());  -- legacy null-provenance: NOT eligible
SELECT pg_temp.set_watermark(:'TA',:'a5',:'Va', now()-interval '1 day');
SELECT pg_temp.mkatt(:'TA',:'a5',:'qa',90,:'gA',0);

-- The 088 trigger auto-enqueued each eligible attempt above. Simulate the FAIL-OPEN DROP (missed enqueue)
-- by clearing those jobs, so recovery must re-detect them. a5 is then re-queued to represent a rep that was
-- NOT missed (still has a live job) — for the coalescing/exclusion case.
DELETE FROM public.readiness_recalc_queue WHERE tenant_id IN (:'TA',:'TB',:'TC');
SELECT public.enqueue_readiness_recalc(:'TA',:'a5',NULL,'quiz_attempt','{}'::jsonb);  -- a5 already queued (not missed)

-- ══ A–E: one recover(TA) call, assert per-rep ══
SELECT public.readiness_recover_missed_enqueues(:'TA', 500);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'a1')=1, 'A: stale-watermark rep enqueued');
SELECT pg_temp.ok((SELECT reason FROM public.readiness_recalc_queue WHERE tenant_id=:'TA' AND user_id=:'a1')='backfill', 'A2: reason=backfill');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'a2')=1, 'B: missing-current-row (with evidence) enqueued');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'a3')=0, 'C: up-to-date rep NOT enqueued');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'a4')=0, 'D: no-eligible-evidence rep NOT enqueued (missing row alone is not a reason)');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA' AND user_id=:'a5')=1, 'E: coalesced — pre-existing job not duplicated');

-- ══ F: idempotent rerun (no consumer) → no new jobs ══
SELECT public.readiness_recover_missed_enqueues(:'TA', 500);
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA' AND status IN ('pending','processing'))=3, 'F: rerun creates no new live jobs (a1,a2,a5 only)');

-- ══ G: bounded batching + NO starvation (TB, 3 reps, limit=1) ══
SELECT pg_temp.mkatt(:'TB',:'b1',:'qb',90,:'gB',0);
SELECT pg_temp.mkatt(:'TB',:'b2',:'qb',90,:'gB',0);
SELECT pg_temp.mkatt(:'TB',:'b3',:'qb',90,:'gB',0);
DELETE FROM public.readiness_recalc_queue WHERE tenant_id=:'TB';   -- simulate all 3 enqueues missed
SELECT public.readiness_recover_missed_enqueues(:'TB', 1);   -- run 1
SELECT public.readiness_recover_missed_enqueues(:'TB', 1);   -- run 2 (consumer has NOT drained)
SELECT public.readiness_recover_missed_enqueues(:'TB', 1);   -- run 3
SELECT pg_temp.ok((SELECT count(DISTINCT user_id) FROM public.readiness_recalc_queue WHERE tenant_id=:'TB' AND status='pending')=3,
  'G1: limit=1 over 3 runs covered all 3 distinct reps — no first-page starvation (live-job exclusion advances)');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TB')=3, 'G2: exactly 3 jobs (no duplicates)');
-- drain-based convergence: process TB, then recover finds nothing
SELECT public.readiness_process_recalc_batch(50,'test');
SELECT public.readiness_recover_missed_enqueues(:'TB', 1);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TB',:'b1')+pg_temp.live_jobs(:'TB',:'b2')+pg_temp.live_jobs(:'TB',:'b3')=0,
  'G3: after drain, watermarks advanced → recover enqueues nothing (converged)');

-- ══ H: tenant isolation + no-active-v2 exclusion ══
SELECT pg_temp.mkatt(:'TC',:'c1',:'qc',90,:'gC',0);  -- eligible evidence but tenant has NO active v2
SELECT public.readiness_recover_missed_enqueues(:'TC', 500);
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TC')=0, 'H1: no-active-v2 tenant never enqueued');
CREATE TEMP TABLE _iso AS
  SELECT (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TB') AS tb,
         (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TC') AS tc;
SELECT public.readiness_recover_missed_enqueues(:'TA', 500);  -- scoped to TA
SELECT pg_temp.ok(
  (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TB')=(SELECT tb FROM _iso)
  AND (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TC')=(SELECT tc FROM _iso),
  'H2: recover(TA) did not add jobs to TB or TC (tenant scoping)');

-- ══ I: no duplicate history on unchanged material ══
CREATE TEMP TABLE _h0 AS SELECT count(*) n FROM public.readiness_score_history WHERE tenant_id=:'TB' AND user_id=:'b1';
SELECT public.enqueue_readiness_recalc(:'TB',:'b1',NULL,'backfill','{"source":"recovery"}'::jsonb);  -- re-enqueue, NO new evidence
SELECT public.readiness_process_recalc_batch(50,'test');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_score_history WHERE tenant_id=:'TB' AND user_id=:'b1')=(SELECT n FROM _h0),
  'I: reprocessing unchanged evidence via recovery adds no duplicate history');

-- ══ J: server-only security + fixed search_path ══
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.readiness_recover_missed_enqueues(uuid,integer)','EXECUTE'), 'J1: authenticated cannot execute recovery');
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.readiness_recover_missed_enqueues(uuid,integer)','EXECUTE'), 'J2: anon cannot execute recovery');
SELECT pg_temp.ok((SELECT prosecdef AND pg_get_userbyid(proowner)='postgres' AND array_to_string(proconfig,',')='search_path=""' FROM pg_proc WHERE proname='readiness_recover_missed_enqueues'), 'J3: SECDEF, owner postgres, empty search_path');

-- ══ K: return-value shape ══
SELECT pg_temp.ok((public.readiness_recover_missed_enqueues(:'TA',7) ? 'tenantsScanned') AND (public.readiness_recover_missed_enqueues(:'TA',7) ? 'enqueued'), 'K: returns {tenantsScanned,enqueued,...}');

-- ══ L: legacy readiness_scores unchanged ══
SELECT pg_temp.ok(
  (SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) FROM public.readiness_scores)=(SELECT m FROM _legacy0)
  AND (SELECT count(*) FROM public.readiness_scores)=(SELECT n FROM _legacy0), 'L: legacy readiness_scores unchanged');

SELECT '089 ALL TESTS PASSED' AS result;
ROLLBACK;
