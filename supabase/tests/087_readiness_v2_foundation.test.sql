-- Repeatable tests for migration 087 (Readiness V2 foundation + shadow compute).
-- Proves: manager/orgAdmin config authorized; learner/anon/cross-tenant denied;
-- config validity gates (0/1/2 tags, unsupported tags); per-quiz mastery with
-- ≤3-attempt cap + 60d recency (improvement + decline); multi-tag 1/N allocation;
-- breadth gates (3 quizzes, 2 tags, 10 distinct current-version questions);
-- retries never widen breadth; missing evidence is never zero; no band before
-- Established; 120d staleness; edited-revision incomparability; archived evidence
-- keeps grace but cannot support NEW setup coverage; idempotent recompute +
-- duplicate queue delivery; legacy readiness_scores untouched. Snapshot-based
-- attribution (immutable), tenant-isolated. One rolled-back transaction.
-- Local only. Expect "087 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Assertion + fixture helpers ──────────────────────────────────────────────
CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '087 FAIL: %', label; END IF; END $$;

CREATE FUNCTION pg_temp.expect_error(p_sql text, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN RETURN; END;
  RAISE EXCEPTION '087 FAIL: expected error but none raised: %', label;
END $$;

CREATE FUNCTION pg_temp.as_user(p_uid text) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    CASE WHEN p_uid IS NULL THEN '{"role":"anon"}' ELSE '{"sub":"'||p_uid||'","role":"authenticated"}' END, true);
$$;

-- Insert a verified server_v2 attempt + immutable snapshot envelope + tag links.
CREATE FUNCTION pg_temp.mkatt(p_tenant uuid, p_user uuid, p_quiz uuid, p_score int, p_age numeric, p_tags uuid[], p_rev text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_id uuid; v_rev text;
BEGIN
  v_rev := COALESCE(p_rev, (SELECT question_revision FROM public.tenant_quizzes WHERE id=p_quiz));
  INSERT INTO public.quiz_attempts(tenant_id,user_id,quiz_id,score,passed,attempt_num,answers,grading_provenance,verified_revision,graded_at,created_at)
  VALUES (p_tenant,p_user,p_quiz,p_score,p_score>=70,1,'[]'::jsonb,'server_v2',v_rev, now()-(p_age||' days')::interval, now()-(p_age||' days')::interval)
  RETURNING id INTO v_id;
  INSERT INTO public.quiz_attempt_tag_snapshots(attempt_id,tenant_id,quiz_id,snapshot_source) VALUES (v_id,p_tenant,p_quiz,'grading');
  INSERT INTO public.quiz_attempt_tags(attempt_id,tag_id,tenant_id) SELECT v_id, t, p_tenant FROM unnest(p_tags) t;
  RETURN v_id;
END $$;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','ma@t.test',now(),now()),  -- tA manager
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','mb@t.test',now(),now()),  -- tB manager
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','r-estab@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','r-new@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a4','authenticated','authenticated','r-cap@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a5','authenticated','authenticated','r-imp@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a6','authenticated','authenticated','r-dec@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a7','authenticated','authenticated','r-stale@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a8','authenticated','authenticated','r-arch@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000aa','authenticated','authenticated','r-edit@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000ab','authenticated','authenticated','r-idem@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000ac','authenticated','authenticated','r-legacy@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','rb@t.test',now(),now());

INSERT INTO public.tenants (id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'), ('00000000-0000-0000-0000-0000000000b0','tb','TB');
INSERT INTO public.tenant_settings (tenant_id, learning_settings) VALUES
 ('00000000-0000-0000-0000-0000000000a0','{"readinessThreshold":80}'), ('00000000-0000-0000-0000-0000000000b0','{}');

-- Seed the legacy v1 active formula per tenant (mirrors migration 052 for tenants
-- that existed at seed time; our test tenants are created fresh here).
INSERT INTO public.readiness_formula_versions (tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at)
VALUES
 ('00000000-0000-0000-0000-0000000000a0',1,'active','{"model":"v1_legacy","weights":{"game":0.25,"learning":0.35,"quiz":0.40}}'::jsonb,80,public.readiness_v1_config_hash(80),'ralli_default',now(),now()),
 ('00000000-0000-0000-0000-0000000000b0',1,'active','{"model":"v1_legacy","weights":{"game":0.25,"learning":0.35,"quiz":0.40}}'::jsonb,80,public.readiness_v1_config_hash(80),'ralli_default',now(),now());

UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MA' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='MB' WHERE id='00000000-0000-0000-0000-0000000000b9';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000a4',
  '00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-0000000000a7',
  '00000000-0000-0000-0000-0000000000a8','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000000ab',
  '00000000-0000-0000-0000-0000000000ac');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active' WHERE id='00000000-0000-0000-0000-0000000000b1';

-- Extra reps for the required-tag staleness matrix (Blocker 3): transition, mixed, boundary, archived-current.
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','r-trans@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000ad','authenticated','authenticated','r-mixed@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000ae','authenticated','authenticated','r-bound@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000af','authenticated','authenticated','r-archcur@t.test',now(),now());
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-0000000000ae','00000000-0000-0000-0000-0000000000af');

-- Tags (tA): T1,T2 designated+required; T3 designated optional; T4 unsupported; T6 archive-only support.
INSERT INTO public.tenant_quiz_tags (id,tenant_id,label,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0','Product','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0','Objections','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000a0','Pricing','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0004','00000000-0000-0000-0000-0000000000a0','Compliance','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0006','00000000-0000-0000-0000-0000000000a0','ArchiveOnly','00000000-0000-0000-0000-0000000000a9');

-- Quizzes (4 gradeable questions each; stable ids). qN a..d.
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions)
SELECT v.id, '00000000-0000-0000-0000-0000000000a0', v.nm, 'active',
  jsonb_build_array(
    jsonb_build_object('id', v.nm||'a','type','mc'), jsonb_build_object('id', v.nm||'b','type','tf'),
    jsonb_build_object('id', v.nm||'c','type','mc'), jsonb_build_object('id', v.nm||'d','type','type'))
FROM (VALUES
 ('00000000-0000-0000-0000-0000000e0011'::uuid,'Q1'), ('00000000-0000-0000-0000-0000000e0012','Q2'),
 ('00000000-0000-0000-0000-0000000e0013','Q3'), ('00000000-0000-0000-0000-0000000e0016','Q6'),
 ('00000000-0000-0000-0000-0000000e001c','Qc'), ('00000000-0000-0000-0000-0000000e001d','Qi'),
 ('00000000-0000-0000-0000-0000000e001e','Qd'), ('00000000-0000-0000-0000-0000000e0017','Q7'),
 ('00000000-0000-0000-0000-0000000e0021','Qa1'), ('00000000-0000-0000-0000-0000000e0022','Qa2'),
 ('00000000-0000-0000-0000-0000000e0023','Qa3'), ('00000000-0000-0000-0000-0000000e0026','Qarch')
) v(id,nm);

INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0012','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0013','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0013','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0016','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e001c','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e001d','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e001e','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0017','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0021','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0022','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0023','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0023','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0026','00000000-0000-0000-0000-0000000d0006','00000000-0000-0000-0000-0000000000a0');

-- Dedicated quizzes for the required-tag staleness matrix: Qs1(T1) Qs2(T2) Qs3(T1,T2) Qs4(T1).
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions)
SELECT v.id, '00000000-0000-0000-0000-0000000000a0', v.nm, 'active',
  jsonb_build_array(
    jsonb_build_object('id', v.nm||'a','type','mc'), jsonb_build_object('id', v.nm||'b','type','tf'),
    jsonb_build_object('id', v.nm||'c','type','mc'), jsonb_build_object('id', v.nm||'d','type','type'))
FROM (VALUES
 ('00000000-0000-0000-0000-0000000e0031'::uuid,'Qs1'), ('00000000-0000-0000-0000-0000000e0032','Qs2'),
 ('00000000-0000-0000-0000-0000000e0033','Qs3'), ('00000000-0000-0000-0000-0000000e0034','Qs4')
) v(id,nm);
INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e0031','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0032','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0033','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0033','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0034','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0');

-- ════════════ AUTHORIZATION ════════════
-- Learner cannot configure / view candidates / run.
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'learner cannot save_draft');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_tag_candidates() $$, 'learner cannot view candidates');
SELECT pg_temp.expect_error($$ SELECT public.readiness_run_shadow('00000000-0000-0000-0000-0000000000a0') $$, 'learner cannot run');
-- Anon denied.
SELECT pg_temp.as_user(NULL);
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'anon cannot save_draft');
-- Manager of tenant B cannot configure tenant A (cross-tenant); tB has no tenant-A tags so a save under MB is its own tenant.
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000b9');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_compare('00000000-0000-0000-0000-0000000000a0') $$, 'cross-tenant compare denied');

-- ════════════ CONFIG VALIDITY GATES (manager MA) ════════════
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'no tags => setup incomplete');
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0001","required":true}]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'one tag => setup incomplete');
-- Two tags but one unsupported (T4 has no active quiz) => still incomplete.
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0001","required":true},{"tagId":"00000000-0000-0000-0000-0000000d0004","required":false}]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'unsupported second tag => incomplete');
-- Good config: T1,T2 required + T3 optional (all supported) => complete.
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0001","required":true},{"tagId":"00000000-0000-0000-0000-0000000d0002","required":true},{"tagId":"00000000-0000-0000-0000-0000000d0003","required":false}]'::jsonb, 80)->>'setupComplete')::boolean IS TRUE, 'two required + one optional => complete');
-- Candidates surface shows support counts + designation.
SELECT pg_temp.ok( (SELECT (t->>'activeQuizCount')::int >= 1 AND (t->>'countsTowardReadiness')::boolean
   FROM jsonb_array_elements(public.readiness_v2_tag_candidates()->'tags') t WHERE t->>'tagId'='00000000-0000-0000-0000-0000000d0001'), 'candidates: T1 supported + designated');
-- Archived-only tag support: a tag whose only quiz is archived cannot support NEW setup.
UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000000e0026';
SELECT pg_temp.ok( (SELECT active_quiz_count FROM public.readiness_tag_support('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000d0006'))=0, 'archived-only tag has 0 active-quiz support');

-- Activate the good config.
CREATE TEMP TABLE cfg AS SELECT id AS vid FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND status='draft';
SELECT pg_temp.ok( public.readiness_v2_activate((SELECT vid FROM cfg))->>'status' = 'active', 'activate good config');
SELECT pg_temp.ok( (SELECT status FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND configuration->>'model'='v1_legacy')='superseded', 'v1 superseded on activation');

-- ════════════ EVIDENCE FIXTURES ════════════
-- Restab: 3 quizzes, 2 tags (Q3 multi-tag), recent => Established, 1/N allocation.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000e0011',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000e0013',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Rnew: one quiz, one attempt => Establishing.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000e0011',95,3,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
-- Rcap: one quiz, 5 attempts — 2 oldest are high (95) and must be dropped by the 3-cap.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000e001c',60,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000e001c',65,15,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000e001c',70,30,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000e001c',95,120,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000e001c',95,200,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
-- Rimp: 3 old failures then a recent pass (oldest dropped by cap).
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000e001d',40,120,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000e001d',45,90,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000e001d',50,60,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a5','00000000-0000-0000-0000-0000000e001d',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
-- Rdec: old pass then recent failure.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-0000000e001e',90,60,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a6','00000000-0000-0000-0000-0000000e001e',40,3,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Rstale: breadth met but ALL attempts > 120d.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000e0011',90,200,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000e0012',80,200,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a7','00000000-0000-0000-0000-0000000e0013',85,200,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Rarch: established, then a contributing quiz is archived (grace must retain evidence).
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a8','00000000-0000-0000-0000-0000000e0021',88,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a8','00000000-0000-0000-0000-0000000e0022',82,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a8','00000000-0000-0000-0000-0000000e0023',75,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Redit: Q1,Q2 recent (2 quizzes/2 tags) + Q7 attempt on an OLD revision (excluded).
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000e0011',80,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000aa','00000000-0000-0000-0000-0000000e0017',100,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[], 'STALEHASH_NOT_CURRENT');
-- Ridem + Rlegacy: established evidence.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab','00000000-0000-0000-0000-0000000e0011',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab','00000000-0000-0000-0000-0000000e0013',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ac','00000000-0000-0000-0000-0000000e0011',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ac','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ac','00000000-0000-0000-0000-0000000e0013',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Legacy readiness_scores row for Rlegacy — must remain byte-identical after V2.
INSERT INTO public.readiness_scores (tenant_id,user_id,score,learning_score,quiz_score,game_score,lessons_completed,courses_completed,quizzes_passed,quizzes_attempted,games_played,window_days,computed_at)
VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ac',42,50,60,0,3,1,2,2,0,30,now());

-- ── Required-tag staleness matrix fixtures ──
-- a3 (transition): all required current @5d → Established at now(); ages to Stale later.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000e0031',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000e0032',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000e0033',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- ad (mixed): required T1 only-old (Qs1@200), required T2 current, OPTIONAL T3 current — must NOT rescue.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-0000000e0031',90,200,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-0000000e0032',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-0000000e001e',75,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ad','00000000-0000-0000-0000-0000000e0016',95,5,ARRAY['00000000-0000-0000-0000-0000000d0003']::uuid[]);
-- ae (boundary): every required tag newest evidence EXACTLY 120d → current (≤120) → Established.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ae','00000000-0000-0000-0000-0000000e0031',90,120,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ae','00000000-0000-0000-0000-0000000e0032',80,120,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ae','00000000-0000-0000-0000-0000000e0033',70,120,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- af (archived-required-current): T1 current ONLY via a quiz we then archive; T2 current.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000af','00000000-0000-0000-0000-0000000e0034',88,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000af','00000000-0000-0000-0000-0000000e0032',82,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000af','00000000-0000-0000-0000-0000000e001e',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Seed a prior Established (ok) history row for ad so it qualifies as "previously Established".
INSERT INTO public.readiness_score_history
  (tenant_id,user_id,formula_version_id,overall_score,success_status,material_state_hash,calculated_config_hash,idempotency_key,calculated_at)
VALUES ('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ad',(SELECT vid FROM cfg),85,'ok','seed_ad_ok','seedcfg','seed_ad_ok', now()-interval '150 days');

-- ════════════ RUN SHADOW (whole tenant) ════════════
SELECT pg_temp.ok( (public.readiness_run_shadow('00000000-0000-0000-0000-0000000000a0', (SELECT vid FROM cfg))->>'processed')::int >= 10, 'run processed all reps');

-- ════════════ SCORING ASSERTIONS ════════════
-- Restab: Established, overall 80, band ready, 3 quizzes / 2 tags / 12 questions;
-- 1/N allocation: T1=83.3, T2=76.7; missing T3 evidence NOT counted as zero.
SELECT pg_temp.ok((SELECT success_status='ok' AND overall_score=80 AND flags->>'band'='ready'
   AND (evidence_summary->>'distinctQuizzes')='3' AND (evidence_summary->>'distinctReadinessTags')='2'
   AND (evidence_summary->>'distinctQuestions')='12'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a1'), 'Restab Established 80/ready 3-2-12');
SELECT pg_temp.ok((SELECT (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0001')::numeric = 83.3
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0002')::numeric = 76.7
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a1'), 'Restab 1/N allocation T1=83.3 T2=76.7');

-- Rnew: Establishing — NO score, NO band, NOT ranked/at-risk.
SELECT pg_temp.ok((SELECT success_status='insufficient_evidence' AND overall_score IS NULL
   AND flags->>'state'='establishing' AND flags->>'band' IS NULL AND confidence='insufficient'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a2'), 'Rnew Establishing, no score/band');

-- Rcap: only the 3 most-recent attempts count (mastery ≈64.5, NOT inflated by the two 95s).
SELECT pg_temp.ok((SELECT (evidence_summary->>'distinctQuizzes')='1'
   AND (evidence_summary->'includedQuizzes'->0->>'mastery')::numeric BETWEEN 60 AND 68
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a4'), 'Rcap 3-attempt cap (mastery ~64.5, retries dont widen breadth)');

-- Rimp: recovery reflected (recent pass dominates; oldest failure dropped) → ~70.
SELECT pg_temp.ok((SELECT (evidence_summary->'includedQuizzes'->0->>'mastery')::numeric BETWEEN 66 AND 74
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a5'), 'Rimp improvement reflected ~70');
-- Rdec: recent decline reflected → ~57.
SELECT pg_temp.ok((SELECT (evidence_summary->'includedQuizzes'->0->>'mastery')::numeric BETWEEN 52 AND 62
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a6'), 'Rdec decline reflected ~57');

-- R_never (a7): breadth met but all evidence > 120d and NEVER Established → Establishing
-- (NOT Stale — insufficient current required coverage from the start).
SELECT pg_temp.ok((SELECT success_status='insufficient_evidence' AND flags->>'state'='establishing'
   AND overall_score IS NULL AND (evidence_summary->>'lastKnownScore') IS NULL
   AND (evidence_summary->>'requiredCoverageCurrent')='false'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a7'), 'R_never: all-old + never established → Establishing (not Stale)');

-- ae (boundary): every required tag newest evidence EXACTLY 120d → current → Established.
SELECT pg_temp.ok((SELECT success_status='ok' AND flags->>'state'='established'
   AND (evidence_summary->>'requiredCoverageCurrent')='true'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000ae'), 'boundary: exactly 120d counts as current → Established');

-- ad (mixed): one required tag stale, the other current, and an OPTIONAL tag current —
-- previously Established → Stale; optional currency cannot rescue required coverage.
SELECT pg_temp.ok((SELECT success_status='insufficient_evidence' AND flags->>'state'='stale'
   AND overall_score IS NULL
   AND (evidence_summary->>'requiredCoverageCurrent')='false'
   AND (evidence_summary->>'requiredCoverageMet')='true'
   AND (evidence_summary->>'lastKnownScore')='85'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000ad'),
   'mixed: one required stale (optional current cannot rescue) + prev Established → Stale, last-known=85');

-- Redit: old-revision attempt excluded (not combined); only 2 current quizzes → Establishing.
SELECT pg_temp.ok((SELECT (evidence_summary->>'distinctQuizzes')='2' AND success_status='insufficient_evidence'
   AND (evidence_summary->'excludedCounts'->>'supersededRevision')::int = 1
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000aa'), 'Redit edited-revision excluded, not combined');

-- Rarch: archive a contributing quiz → grace retains existing evidence (still Established).
UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000000e0022';
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a8',(SELECT vid FROM cfg));
SELECT pg_temp.ok((SELECT success_status='ok' AND (evidence_summary->>'distinctQuizzes')='3'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a8'), 'Rarch archived-quiz evidence retained (grace)');

-- a3 (transition): Established at now(); recompute 200 days later → required evidence
-- lapses → Stale (reassessment needed), with the last Established score preserved.
SELECT pg_temp.ok((SELECT success_status='ok' AND flags->>'state'='established'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a3'), 'transition: established at now()');
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3',(SELECT vid FROM cfg), NULL, now()+interval '200 days');
SELECT pg_temp.ok((SELECT success_status='insufficient_evidence' AND flags->>'state'='stale'
   AND overall_score IS NULL AND (evidence_summary->>'lastKnownScore') IS NOT NULL
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a3'),
   'transition: required evidence lapses after 120d → Stale, last-known preserved');

-- af (archived required assessment with still-CURRENT evidence): established at now();
-- archive the sole T1-supporting quiz → its 5d attempt still current via snapshot → stays Established.
SELECT pg_temp.ok((SELECT success_status='ok'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000af'), 'archcur: established before archive');
UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000000e0034';
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000af',(SELECT vid FROM cfg));
SELECT pg_temp.ok((SELECT success_status='ok' AND flags->>'state'='established'
   AND (evidence_summary->>'requiredCoverageCurrent')='true'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000af'),
   'archcur: archived required assessment with still-current evidence → stays Established');

-- Idempotency: recompute Ridem → history stays at exactly one row (same material hash).
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab',(SELECT vid FROM cfg));
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab',(SELECT vid FROM cfg));
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_score_history WHERE user_id='00000000-0000-0000-0000-0000000000ab')=1, 'idempotent recompute → single history row');

-- Duplicate queue delivery: enqueue same job twice coalesces to one; drain once.
-- Clear activation-enqueued jobs first so this assertion is isolated + deterministic.
DELETE FROM public.readiness_recalc_queue;
SELECT public.enqueue_readiness_recalc('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab',(SELECT vid FROM cfg),'manual');
SELECT public.enqueue_readiness_recalc('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ab',(SELECT vid FROM cfg),'manual');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE user_id='00000000-0000-0000-0000-0000000000ab' AND status='pending')=1, 'duplicate enqueue coalesces to one pending job');
SELECT pg_temp.ok((public.readiness_process_recalc_batch(10,'test')->>'processed')::int >= 1, 'queue drain processes the job');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_recalc_queue WHERE user_id='00000000-0000-0000-0000-0000000000ab' AND status='completed')=1, 'job marked completed');

-- Legacy readiness_scores untouched by V2.
SELECT pg_temp.ok((SELECT score=42 AND quiz_score=60 AND learning_score=50 FROM public.readiness_scores WHERE user_id='00000000-0000-0000-0000-0000000000ac'), 'legacy readiness_scores row unchanged');

-- Tenant isolation: tB has no rows under tA version.
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_scores_current WHERE tenant_id='00000000-0000-0000-0000-0000000000b0')=0, 'no cross-tenant score rows');

-- Learner-safe own result: Restab reading own result sees Established score; Rnew sees Establishing.
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.ok((public.readiness_v2_my_result()->>'state')='established' AND (public.readiness_v2_my_result()->>'score')='80', 'learner own result (established)');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a2');
SELECT pg_temp.ok((public.readiness_v2_my_result()->>'state')='establishing' AND (public.readiness_v2_my_result()->>'score') IS NULL, 'learner own result (establishing, no score)');

SELECT '087 ALL TESTS PASSED' AS result;
ROLLBACK;
