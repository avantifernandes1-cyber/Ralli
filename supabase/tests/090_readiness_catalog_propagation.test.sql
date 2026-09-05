-- Repeatable tests for migration 090 (catalog/taxonomy propagation via outbox + bounded worker).
-- Proves: tag archive/restore/merge and quiz primary-tag change propagate to ONLY affected scorable learners
-- via the outbox worker (reason catalog_change); quiz status + quiz_tag_map changes create NO propagation
-- (score-neutral, not wired); coalescing (one pending event per subject); bounded continuation with cursor
-- and NO starvation; unaffected learners + other tenants untouched; snapshots + history unchanged; dead-letter
-- events not auto-revived; catalog writes fail-open if propagation errors; server-only security; legacy
-- unchanged. One rolled-back transaction. Local only. Expect "090 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '090 FAIL: %', label; END IF; END $$;
CREATE FUNCTION pg_temp.live_jobs(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_recalc_queue WHERE tenant_id=p_tenant AND user_id=p_user AND status IN ('pending','processing');
$$;
CREATE FUNCTION pg_temp.pending_events(p_tenant uuid, p_type text, p_subject uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_propagation_events WHERE tenant_id=p_tenant AND event_type=p_type AND subject_id=p_subject AND status='pending';
$$;
CREATE FUNCTION pg_temp.mkatt(p_tenant uuid, p_user uuid, p_quiz uuid, p_tag uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_rev text;
BEGIN
  v_rev := (SELECT question_revision FROM public.tenant_quizzes WHERE id=p_quiz);
  INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (p_tenant,p_user,p_quiz,90,true,1,'[]'::jsonb,'server_v2',v_rev,now(),now()) RETURNING id INTO v_id;
  INSERT INTO public.quiz_attempt_tag_snapshots(attempt_id,tenant_id,quiz_id,snapshot_source) VALUES (v_id,p_tenant,p_quiz,'grading');
  INSERT INTO public.quiz_attempt_tags(attempt_id,tag_id,tenant_id) VALUES (v_id,p_tag,p_tenant);
  RETURN v_id;
END $$;
CREATE FUNCTION pg_temp.as_user(p_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims', '{"sub":"'||p_uid||'","role":"authenticated"}', true);
$$;

-- ── fixtures: TA active v2 (gA,gB required); TB active v2 (isolation) ──
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','ma@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','u1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','u2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','u3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a4','authenticated','authenticated','u4@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a5','authenticated','authenticated','u5@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','tb1@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES ('00000000-0000-0000-0000-0000000000a0','ta','TA'),('00000000-0000-0000-0000-0000000000b0','tb','TB');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES ('00000000-0000-0000-0000-0000000000a0','{}'),('00000000-0000-0000-0000-0000000000b0','{}');
UPDATE public.profiles SET role='orgAdmin',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000a0',status='active' WHERE id IN ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000a5');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000000000b0',status='active' WHERE id='00000000-0000-0000-0000-0000000000b1';
INSERT INTO public.readiness_formula_versions(id,tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at) VALUES
 ('00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000000a0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now()),
 ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000b0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now());
INSERT INTO public.tenant_quiz_tags(id,tenant_id,label,status,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0','gA','active','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0','gB','active','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000a0','gC','active','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d00b1','00000000-0000-0000-0000-0000000000b0','gTB','active','00000000-0000-0000-0000-0000000000b1');
INSERT INTO public.readiness_tag_designations(tenant_id,formula_version_id,tag_id,is_required,created_by) VALUES
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000d0001',true,'00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000d0002',true,'00000000-0000-0000-0000-0000000000a9');
INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,questions,primary_readiness_tag_id,passing_score) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000000a0','QA','active',jsonb_build_array(jsonb_build_object('id','qa','type','mc')),NULL,100),
 ('00000000-0000-0000-0000-0000000e00a2','00000000-0000-0000-0000-0000000000a0','QB','active',jsonb_build_array(jsonb_build_object('id','qb','type','mc')),NULL,100),
 ('00000000-0000-0000-0000-0000000e00b1','00000000-0000-0000-0000-0000000000b0','QTB','active',jsonb_build_array(jsonb_build_object('id','qtb','type','mc')),NULL,100);
INSERT INTO public.quiz_tag_map(quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e00a1','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00a2','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e00b1','00000000-0000-0000-0000-0000000d00b1','00000000-0000-0000-0000-0000000000b0');

\set TA '00000000-0000-0000-0000-0000000000a0'
\set TB '00000000-0000-0000-0000-0000000000b0'
\set gA '00000000-0000-0000-0000-0000000d0001'
\set gB '00000000-0000-0000-0000-0000000d0002'
\set gC '00000000-0000-0000-0000-0000000d0003'
\set qa '00000000-0000-0000-0000-0000000e00a1'
\set qb '00000000-0000-0000-0000-0000000e00a2'
\set qtb '00000000-0000-0000-0000-0000000e00b1'
\set gTB '00000000-0000-0000-0000-0000000d00b1'
\set m  '00000000-0000-0000-0000-0000000000a9'
\set u1 '00000000-0000-0000-0000-0000000000a1'
\set u2 '00000000-0000-0000-0000-0000000000a2'
\set u3 '00000000-0000-0000-0000-0000000000a3'
\set u4 '00000000-0000-0000-0000-0000000000a4'
\set u5 '00000000-0000-0000-0000-0000000000a5'
\set tb1 '00000000-0000-0000-0000-0000000000b1'

-- evidence: u1,u2,u3 carry gA (on qa); u4 carries gB (on qb); u5 none; tb1 carries gTB (TB)
SELECT pg_temp.mkatt(:'TA',:'u1',:'qa',:'gA');
SELECT pg_temp.mkatt(:'TA',:'u2',:'qa',:'gA');
SELECT pg_temp.mkatt(:'TA',:'u3',:'qa',:'gA');
SELECT pg_temp.mkatt(:'TA',:'u4',:'qb',:'gB');
SELECT pg_temp.mkatt(:'TB',:'tb1',:'qtb',:'gTB');
CREATE TEMP TABLE _legacy0 AS SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) m, count(*) n FROM public.readiness_scores;
CREATE TEMP TABLE _snap0 AS SELECT count(*) qat, (SELECT count(*) FROM public.readiness_score_history) hist FROM public.quiz_attempt_tags;

-- ══ A. Tag ARCHIVE → only gA-carriers enqueued ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=:'gA';   -- trigger → emit tag_changed(gA)
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','tag_changed',:'gA')=1, 'A1: tag archive emitted exactly one pending propagation event');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u1')=1 AND pg_temp.live_jobs(:'TA',:'u2')=1 AND pg_temp.live_jobs(:'TA',:'u3')=1, 'A2: gA-carriers enqueued');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u4')=0 AND pg_temp.live_jobs(:'TA',:'u5')=0, 'A3: non-carriers / no-evidence NOT enqueued');
SELECT pg_temp.ok((SELECT reason FROM public.readiness_recalc_queue WHERE tenant_id=:'TA' AND user_id=:'u1')='catalog_change', 'A4: reason=catalog_change');
SELECT pg_temp.ok((SELECT status FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND event_type='tag_changed' AND subject_id=:'gA')='completed', 'A5: event completed');

-- ══ B. Tag RESTORE → gA-carriers enqueued again ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='active' WHERE id=:'gA';
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u1')=1 AND pg_temp.live_jobs(:'TA',:'u3')=1, 'B1: tag restore re-enqueues carriers');

-- ══ C. Tag MERGE (gB → gC) → only gB-carriers (u4) enqueued ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET merged_into=:'gC', status='archived' WHERE id=:'gB';
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','tag_changed',:'gB')=1, 'C1: tag merge emitted one event for the source tag');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u4')=1, 'C2: gB-carrier enqueued on merge');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u1')=0, 'C3: non-carrier of gB not enqueued by gB merge');

-- ══ D. PRIMARY-tag change via refactored RPC → ONLY reps with attempts on that quiz (precise, once) ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
SELECT pg_temp.as_user(:'m');
SELECT public.readiness_set_quiz_primary_tag(:'qa', :'gA');   -- gA active+designated+assigned → sets primary, emits quiz_primary_changed(qa)
SELECT set_config('request.jwt.claims','', true);
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','quiz_primary_changed',:'qa')=1, 'D1: primary-tag RPC emitted exactly one event (no inline fan-out)');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u1')=1 AND pg_temp.live_jobs(:'TA',:'u2')=1 AND pg_temp.live_jobs(:'TA',:'u3')=1, 'D2: reps with attempts on qa enqueued');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u4')=0 AND pg_temp.live_jobs(:'TA',:'u5')=0, 'D3: reps without attempts on qa NOT enqueued (precise, not all-tenant)');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);   -- rerun: no duplicate
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA' AND user_id=:'u1')=1, 'D4: no duplicate live job on rerun');

-- ══ E. Coalescing: repeated events for a subject → one pending event ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=:'gA';
UPDATE public.tenant_quiz_tags SET status='active'   WHERE id=:'gA';
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=:'gA';
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','tag_changed',:'gA')=1, 'E1: three tag toggles coalesce to ONE pending event');

-- ══ F. Bounded continuation / NO starvation (limit=1 over 3 gA-carriers) ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='active' WHERE id=:'gA';  -- ensure event
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=:'gA';
SELECT public.readiness_process_propagation_batch(20,1,now(),false);   -- run 1: 1 rep, event stays pending w/ cursor
SELECT public.readiness_process_propagation_batch(20,1,now(),false);   -- run 2
SELECT public.readiness_process_propagation_batch(20,1,now(),false);   -- run 3
SELECT public.readiness_process_propagation_batch(20,1,now(),false);   -- run 4: exhausted → completed
SELECT pg_temp.ok((SELECT count(DISTINCT user_id) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA')=3, 'F1: bounded limit=1 covered all 3 carriers across runs (no starvation)');
SELECT pg_temp.ok((SELECT status FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND event_type='tag_changed' AND subject_id=:'gA')='completed', 'F2: event completed after exhaustion');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA')=3, 'F3: exactly 3 jobs (coalesced, no duplicates)');

-- ══ G. Score-neutral events are NOT wired (no propagation) ══
DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quizzes SET status='archived' WHERE id=:'qa';    -- quiz status change
UPDATE public.tenant_quizzes SET status='active'   WHERE id=:'qa';
INSERT INTO public.quiz_tag_map(quiz_id,tag_id,tenant_id) VALUES (:'qb',:'gA',:'TA');  -- quiz_tag_map insert
DELETE FROM public.quiz_tag_map WHERE quiz_id=:'qb' AND tag_id=:'gA' AND tenant_id=:'TA'; -- and delete
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_propagation_events WHERE tenant_id=:'TA')=0, 'G1: quiz status + quiz_tag_map changes create NO propagation event (score-neutral)');

-- ══ H. Tenant isolation ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=:'gA';  -- TA event only
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TB',:'tb1')=0 AND (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TB')=0, 'H1: other tenant untouched');

-- ══ I. Snapshots + history unchanged (propagation is enqueue-only) ══
SELECT pg_temp.ok((SELECT count(*) FROM public.quiz_attempt_tags)=(SELECT qat FROM _snap0) AND (SELECT count(*) FROM public.readiness_score_history)=(SELECT hist FROM _snap0), 'I1: attempt snapshots + readiness history unchanged');

-- ══ J. Dead-letter event not auto-revived ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
INSERT INTO public.readiness_propagation_events(tenant_id,event_type,subject_tag_id,status,attempt_count,last_error) VALUES (:'TA','tag_changed',:'gA','dead_letter',5,'boom');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok((SELECT status FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND event_type='tag_changed' AND subject_id=:'gA')='dead_letter' AND (SELECT count(*) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA')=0, 'J1: dead-letter event not claimed/revived; no enqueue');

-- ══ K. Fail-open: catalog write succeeds even if propagation emit fails ══
DELETE FROM public.readiness_propagation_events;
CREATE FUNCTION pg_temp.boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'INJECTED emit failure'; END $$;
CREATE TRIGGER zzz_boom BEFORE INSERT ON public.readiness_propagation_events FOR EACH ROW EXECUTE FUNCTION pg_temp.boom();
UPDATE public.tenant_quiz_tags SET status='active' WHERE id=:'gA';   -- emit will hit boom → swallowed by trigger fail-open
DROP TRIGGER zzz_boom ON public.readiness_propagation_events;
SELECT pg_temp.ok((SELECT status FROM public.tenant_quiz_tags WHERE id=:'gA')='active', 'K1: catalog write (tag status) committed despite emit failure (fail-open)');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_propagation_events WHERE tenant_id=:'TA')=0, 'K2: no partial propagation event created');

-- ══ L. Security / server-only ══
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.readiness_process_propagation_batch(integer,integer,timestamp with time zone,boolean)','EXECUTE') AND NOT has_function_privilege('anon','public.readiness_process_propagation_batch(integer,integer,timestamp with time zone,boolean)','EXECUTE'), 'L1: worker not client-executable');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.readiness_emit_propagation_event(uuid,text,uuid,uuid)','EXECUTE'), 'L2: emit not client-executable');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.readiness_propagation_events','SELECT') AND NOT has_table_privilege('authenticated','public.readiness_propagation_events','INSERT'), 'L3: outbox table not client-accessible');
SELECT pg_temp.ok((SELECT bool_and(prosecdef AND pg_get_userbyid(proowner)='postgres' AND array_to_string(proconfig,',')='search_path=""') FROM pg_proc WHERE proname IN ('readiness_emit_propagation_event','readiness_process_propagation_batch','tenant_quiz_tags_emit_readiness_propagation')), 'L4: all 090 fns SECDEF, owner postgres, empty search_path');

-- ══ M. Legacy unchanged ══
SELECT pg_temp.ok((SELECT md5(coalesce(string_agg(id::text||coalesce(score::text,''),',' ORDER BY id),'')) FROM public.readiness_scores)=(SELECT m FROM _legacy0) AND (SELECT count(*) FROM public.readiness_scores)=(SELECT n FROM _legacy0), 'M1: legacy readiness_scores unchanged');

-- ══ N. TRANSITIVE tag resolution (A0→B0→C0: changing B0 or C0 updates carriers of A0) ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a6','authenticated','authenticated','u6@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a7','authenticated','authenticated','u7@t.test',now(),now());
UPDATE public.profiles SET role='user',tenant_id=:'TA',status='active' WHERE id IN ('00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-0000000000a7');
INSERT INTO public.tenant_quiz_tags(id,tenant_id,label,status,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d000a',:'TA','A0','active',:'m'),
 ('00000000-0000-0000-0000-0000000d000b',:'TA','B0','active',:'m'),
 ('00000000-0000-0000-0000-0000000d000c',:'TA','C0','active',:'m');
SELECT pg_temp.mkatt(:'TA','00000000-0000-0000-0000-0000000000a6'::uuid,:'qa','00000000-0000-0000-0000-0000000d000a'::uuid);  -- u6 snapshot carries A0
SELECT pg_temp.mkatt(:'TA','00000000-0000-0000-0000-0000000000a7'::uuid,:'qa','00000000-0000-0000-0000-0000000d000c'::uuid);  -- u7 snapshot carries C0
UPDATE public.tenant_quiz_tags SET merged_into='00000000-0000-0000-0000-0000000d000b', status='archived' WHERE id='00000000-0000-0000-0000-0000000d000a'; -- A0→B0 (merged⟹archived)
UPDATE public.tenant_quiz_tags SET merged_into='00000000-0000-0000-0000-0000000d000c', status='archived' WHERE id='00000000-0000-0000-0000-0000000d000b'; -- B0→C0
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;   -- clear setup noise
-- change C0 (final): reverse-chain {C0,B0,A0} → carriers of A0 (u6) AND C0 (u7)
UPDATE public.tenant_quiz_tags SET status='archived', updated_at=now() WHERE id='00000000-0000-0000-0000-0000000d000c';
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA','00000000-0000-0000-0000-0000000000a6'::uuid)=1, 'N1: change to C0 reaches A0-carrier via transitive chain');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA','00000000-0000-0000-0000-0000000000a7'::uuid)=1, 'N2: change to C0 reaches C0-carrier');
-- change B0 (middle): reverse-chain {B0,A0} → u6 yes, u7 no
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET merged_into=NULL, status='active', updated_at=now() WHERE id='00000000-0000-0000-0000-0000000d000b';  -- restore/un-merge B0 (valid change)
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA','00000000-0000-0000-0000-0000000000a6'::uuid)=1, 'N3: change to B0 reaches A0-carrier (A0→B0)');
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA','00000000-0000-0000-0000-0000000000a7'::uuid)=0, 'N4: change to B0 does NOT reach C0-carrier (C0 not in chain from B0)');

-- ══ O. GENERATION / DIRTY RERUN: change during a pending (partly-processed) event → full re-pass ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='archived', updated_at=now() WHERE id=:'gA';   -- gen 1
SELECT public.readiness_process_propagation_batch(20,1,now(),false);                       -- process 1 of 3 carriers; event pending, cursor advanced
CREATE TEMP TABLE _o AS SELECT generation g, cursor_user_id c FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND event_type='tag_changed' AND subject_id=:'gA';
UPDATE public.tenant_quiz_tags SET status='active', updated_at=now() WHERE id=:'gA';        -- change DURING pending → gen bump + cursor reset
SELECT pg_temp.ok((SELECT generation FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND subject_id=:'gA') > (SELECT g FROM _o), 'O1: change during pending bumps generation');
SELECT pg_temp.ok((SELECT cursor_user_id FROM public.readiness_propagation_events WHERE tenant_id=:'TA' AND subject_id=:'gA') IS NULL, 'O2: cursor reset to start (already-processed learners reconsidered)');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok((SELECT count(DISTINCT user_id) FROM public.readiness_recalc_queue WHERE tenant_id=:'TA')=3, 'O3: after dirty rerun all 3 carriers covered (no loss, no dup)');

-- ══ P. DROPPED-EMIT RECOVERY (fail-open) via bounded reconcile ══
DELETE FROM public.readiness_recalc_queue; DELETE FROM public.readiness_propagation_events;
UPDATE public.tenant_quiz_tags SET status='archived', updated_at=now() WHERE id=:'gA';      -- sanctioned change stamps updated_at + trigger emits
DELETE FROM public.readiness_propagation_events WHERE subject_id=:'gA';                      -- SIMULATE the emit was dropped (fail-open)
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','tag_changed',:'gA')=0, 'P0: emit dropped — no event');
SELECT public.readiness_reconcile_catalog(interval '1 day', 200, now());                     -- bounded reconcile
SELECT pg_temp.ok(pg_temp.pending_events(:'TA','tag_changed',:'gA')=1, 'P1: reconcile re-emitted the dropped catalog event');
SELECT public.readiness_process_propagation_batch(20,200,now(),false);
SELECT pg_temp.ok(pg_temp.live_jobs(:'TA',:'u1')=1, 'P2: dropped catalog change recovered → carriers enqueued');

SELECT '090 ALL TESTS PASSED' AS result;
ROLLBACK;
