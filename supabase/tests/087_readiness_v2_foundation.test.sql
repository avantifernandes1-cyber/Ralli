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

-- ── Blocker 1 fixtures: independent roles. Manager (role='manager') in tenant A,
-- a ralli_admin platform user (tenant NULL), and a separate tenant C with its own
-- MANAGER for a full manager flow (candidates/save/activate/compare). ──
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000da','authenticated','authenticated','mgr-a@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000db','authenticated','authenticated','ralli-admin@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c9','authenticated','authenticated','mgr-c@t.test',now(),now());
UPDATE public.profiles SET role='manager', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MGRA' WHERE id='00000000-0000-0000-0000-0000000000da';
UPDATE public.profiles SET role='ralli_admin', tenant_id=NULL, status='active', name='RA' WHERE id='00000000-0000-0000-0000-0000000000db';
INSERT INTO public.tenants (id,slug,name) VALUES ('00000000-0000-0000-0000-0000000000c0','tc','TC');
INSERT INTO public.tenant_settings (tenant_id, learning_settings) VALUES ('00000000-0000-0000-0000-0000000000c0','{"readinessThreshold":80}');
INSERT INTO public.readiness_formula_versions (tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at)
VALUES ('00000000-0000-0000-0000-0000000000c0',1,'active','{"model":"v1_legacy","weights":{"game":0.25,"learning":0.35,"quiz":0.40}}'::jsonb,80,public.readiness_v1_config_hash(80),'ralli_default',now(),now());
UPDATE public.profiles SET role='manager', tenant_id='00000000-0000-0000-0000-0000000000c0', status='active', name='MGRC' WHERE id='00000000-0000-0000-0000-0000000000c9';
INSERT INTO public.tenant_quiz_tags (id,tenant_id,label,created_by) VALUES
 ('00000000-0000-0000-0000-000000dc0001','00000000-0000-0000-0000-0000000000c0','C-Product','00000000-0000-0000-0000-0000000000c9'),
 ('00000000-0000-0000-0000-000000dc0002','00000000-0000-0000-0000-0000000000c0','C-Objections','00000000-0000-0000-0000-0000000000c9');
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions)
SELECT v.id,'00000000-0000-0000-0000-0000000000c0',v.nm,'active',
  jsonb_build_array(jsonb_build_object('id',v.nm||'a','type','mc'),jsonb_build_object('id',v.nm||'b','type','tf'),jsonb_build_object('id',v.nm||'c','type','mc'),jsonb_build_object('id',v.nm||'d','type','type'))
FROM (VALUES ('00000000-0000-0000-0000-000000ec0001'::uuid,'Qtc1'),('00000000-0000-0000-0000-000000ec0002','Qtc2')) v(id,nm);
INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-000000ec0001','00000000-0000-0000-0000-000000dc0001','00000000-0000-0000-0000-0000000000c0'),
 ('00000000-0000-0000-0000-000000ec0002','00000000-0000-0000-0000-000000dc0002','00000000-0000-0000-0000-0000000000c0');

-- ── Blocker 2 fixtures: multi-tag weighting Cases A–D (tenant A). QA13=T1+T3, Qmt=T1+T2+T3. ──
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions)
SELECT v.id,'00000000-0000-0000-0000-0000000000a0',v.nm,'active',
  jsonb_build_array(jsonb_build_object('id',v.nm||'a','type','mc'),jsonb_build_object('id',v.nm||'b','type','tf'),jsonb_build_object('id',v.nm||'c','type','mc'),jsonb_build_object('id',v.nm||'d','type','type'))
FROM (VALUES ('00000000-0000-0000-0000-0000000e0041'::uuid,'QA13'),('00000000-0000-0000-0000-0000000e0043','Qmt')) v(id,nm);
INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e0041','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0041','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0043','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0043','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0043','00000000-0000-0000-0000-0000000d0003','00000000-0000-0000-0000-0000000000a0');
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000c1','authenticated','authenticated','rca@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c2','authenticated','authenticated','rcb@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c3','authenticated','authenticated','rcc@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c4','authenticated','authenticated','rd1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c5','authenticated','authenticated','rd2@t.test',now(),now());
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000000c5');
-- Case A: QA13=100 (T1+T3), Q1=0 (T1). Primary(QA13)=T1 → T1=avg(100,0)=50; T3 insights=100.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000e0041',100,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0003']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000e0011',0,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
-- Case B: Qmt=60 (T1+T2+T3→T1), Qs1=90 (T1), Q2=80 (T2), Q6=70 (T3). T1=75,T2=80,T3=70 → 75.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000e0043',60,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002','00000000-0000-0000-0000-0000000d0003']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000e0031',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c2','00000000-0000-0000-0000-0000000e0016',70,5,ARRAY['00000000-0000-0000-0000-0000000d0003']::uuid[]);
-- Case C: Qs3=50 (T1+T2→T1) is the only quiz for T1; Q2=90,Qd=70 (T2). T1=50, T2=80 → 65.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000e0033',50,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000e0012',90,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c3','00000000-0000-0000-0000-0000000e001e',70,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Case D single (c4): Q1=100 (T1), Qs1=0 (T1), Q2=80 (T2). T1=50, T2=80 → 65.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000e0011',100,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000e0031',0,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c4','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Case D multi (c5): SAME as c4 but the 100-quiz carries a 2nd tag (QA13 T1+T3). Overall must stay 65.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000e0041',100,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0003']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000e0031',0,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c5','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);

-- ════════════ AUTHORIZATION ════════════
-- Learner cannot configure / view candidates / run.
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'learner cannot save_draft');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_tag_candidates() $$, 'learner cannot view candidates');
SELECT pg_temp.expect_error($$ SELECT public.readiness_run_shadow('00000000-0000-0000-0000-0000000000a0') $$, 'learner cannot run');
-- Anon denied.
SELECT pg_temp.as_user(NULL);
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'anon cannot save_draft');
-- Client-supplied role in the JWT cannot grant authority (server reads profiles.role by auth.uid).
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated","user_role":"orgAdmin","app_metadata":{"role":"orgAdmin"}}',true);
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'client-supplied JWT role cannot grant authority');

-- ── MANAGER (role=manager) — full flow, INDEPENDENT of orgAdmin, in tenant C ──
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000c9');  -- MGRC, manager of tenant C
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_tag_candidates()->'tags')='array', 'MANAGER: view tag candidates');
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-000000dc0001","required":true},{"tagId":"00000000-0000-0000-0000-000000dc0002","required":true}]'::jsonb,80)->>'setupComplete')::boolean, 'MANAGER: create/save valid draft');
SELECT pg_temp.ok( public.readiness_v2_activate((SELECT id FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000c0' AND status='draft'))->>'status'='active', 'MANAGER: activate valid configuration');
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_compare('00000000-0000-0000-0000-0000000000c0')->'reps')='array', 'MANAGER: view shadow comparison');

-- ── orgAdmin — independently view candidates + comparison (save/activate proven below in tenant A) ──
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');  -- MA, orgAdmin of tenant A
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_tag_candidates()->'tags')='array', 'orgAdmin: view tag candidates');
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_compare('00000000-0000-0000-0000-0000000000a0')->'reps')='array', 'orgAdmin: view shadow comparison');

-- ── Platform admin (ralli_admin — the real production role, NOT superadmin) ──
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000db');  -- RA, ralli_admin, tenant NULL
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_compare('00000000-0000-0000-0000-0000000000a0')->'reps')='array', 'ralli_admin: cross-tenant compare (tenant A)');
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_compare('00000000-0000-0000-0000-0000000000c0')->'reps')='array', 'ralli_admin: cross-tenant compare (tenant C)');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_save_draft('[]'::jsonb) $$, 'ralli_admin has no tenant → not a per-tenant author (by convention)');

-- ── Cross-tenant denials, per role, separately ──
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000da');  -- MGRA, manager of tenant A
SELECT pg_temp.ok( jsonb_typeof(public.readiness_v2_tag_candidates()->'tags')='array', 'manager A: candidates for OWN tenant allowed');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_compare('00000000-0000-0000-0000-0000000000b0') $$, 'manager A cannot inspect tenant B');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_activate((SELECT id FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000b0' LIMIT 1)) $$, 'manager A cannot activate a tenant-B version');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');  -- orgAdmin A
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_compare('00000000-0000-0000-0000-0000000000b0') $$, 'orgAdmin A cannot inspect tenant B');
SELECT pg_temp.expect_error($$ SELECT public.readiness_v2_activate((SELECT id FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000b0' LIMIT 1)) $$, 'orgAdmin A cannot activate a tenant-B version');

-- ════════════ CONFIG VALIDITY GATES (manager MA) ════════════
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'no tags => setup incomplete');
-- Optional-only (no REQUIRED area) => incomplete: optional areas are never scored.
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0003","required":false}]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'optional-only (no required) => incomplete');
-- One REQUIRED, supported => COMPLETE (required-only rule: ≥1 required area suffices).
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0001","required":true}]'::jsonb)->>'setupComplete')::boolean IS TRUE, 'one required supported => complete');
-- A REQUIRED tag without coverage (T4 has no active quiz) => incomplete.
SELECT pg_temp.ok( (public.readiness_v2_save_draft('[{"tagId":"00000000-0000-0000-0000-0000000d0001","required":true},{"tagId":"00000000-0000-0000-0000-0000000d0004","required":true}]'::jsonb)->>'setupComplete')::boolean IS FALSE, 'unsupported REQUIRED tag => incomplete');
-- Good config: T1,T2 required + T3 optional (all required supported) => complete.
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

-- ── MANAGER-SELECTED primary readiness tags for scoring quizzes (explicit, never by id).
-- Multi-tag quizzes (Q3,Qs3,Qa3,QA13,Qmt) are deliberately assigned primary = T1 (Product);
-- single-tag quizzes take their own tag. This drives ALL official attribution below.
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0001'
 WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND id IN (
  '00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000e0013','00000000-0000-0000-0000-0000000e001c',
  '00000000-0000-0000-0000-0000000e001d','00000000-0000-0000-0000-0000000e0017','00000000-0000-0000-0000-0000000e0021',
  '00000000-0000-0000-0000-0000000e0023','00000000-0000-0000-0000-0000000e0031','00000000-0000-0000-0000-0000000e0033',
  '00000000-0000-0000-0000-0000000e0034','00000000-0000-0000-0000-0000000e0041','00000000-0000-0000-0000-0000000e0043');
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0002'
 WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND id IN (
  '00000000-0000-0000-0000-0000000e0012','00000000-0000-0000-0000-0000000e001e','00000000-0000-0000-0000-0000000e0022','00000000-0000-0000-0000-0000000e0032');
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0003'
 WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND id='00000000-0000-0000-0000-0000000e0016';

-- ── Primary-tag VALIDITY fixtures (missing/not-designated/not-assigned/archived/merged) ──
INSERT INTO public.tenant_quiz_tags (id,tenant_id,label,created_by) VALUES
 ('00000000-0000-0000-0000-0000000d0007','00000000-0000-0000-0000-0000000000a0','PrimArch','00000000-0000-0000-0000-0000000000a9'),
 ('00000000-0000-0000-0000-0000000d0008','00000000-0000-0000-0000-0000000000a0','PrimMerge','00000000-0000-0000-0000-0000000000a9');
-- Designate PrimArch (optional) in the active version so it can be a valid primary until archived.
INSERT INTO public.readiness_tag_designations (tenant_id,formula_version_id,tag_id,is_required)
 VALUES ('00000000-0000-0000-0000-0000000000a0',(SELECT vid FROM cfg),'00000000-0000-0000-0000-0000000d0007',false);
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status,questions)
SELECT v.id,'00000000-0000-0000-0000-0000000000a0',v.nm,'active',
  jsonb_build_array(jsonb_build_object('id',v.nm||'a','type','mc'),jsonb_build_object('id',v.nm||'b','type','tf'),jsonb_build_object('id',v.nm||'c','type','mc'),jsonb_build_object('id',v.nm||'d','type','type'))
FROM (VALUES ('00000000-0000-0000-0000-0000000e0051'::uuid,'Qpm'),('00000000-0000-0000-0000-0000000e0052','Qpnd'),
             ('00000000-0000-0000-0000-0000000e0053','Qpna'),('00000000-0000-0000-0000-0000000e0054','Qpar'),
             ('00000000-0000-0000-0000-0000000e0055','Qmg')) v(id,nm);
INSERT INTO public.quiz_tag_map (quiz_id,tag_id,tenant_id) VALUES
 ('00000000-0000-0000-0000-0000000e0051','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0052','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0053','00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0054','00000000-0000-0000-0000-0000000d0007','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-0000000e0055','00000000-0000-0000-0000-0000000d0008','00000000-0000-0000-0000-0000000000a0');
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000c6','authenticated','authenticated','rp@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c7','authenticated','authenticated','rmg@t.test',now(),now());
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000000c7');
-- Rp (c6): four quizzes, each failing a distinct primary check.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000e0051',80,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]); -- primary NULL → missing
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000e0052',80,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]); -- primary=T4 not designated
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000e0053',80,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]); -- primary=T2 not in snapshot [T1]
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c6','00000000-0000-0000-0000-0000000e0054',80,5,ARRAY['00000000-0000-0000-0000-0000000d0007']::uuid[]); -- primary=PrimArch (archived later)
-- Rmerge (c7): Qmg (primary=PrimMerge, later merged into T1) + Q2,Qd (T2).
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c7','00000000-0000-0000-0000-0000000e0055',80,5,ARRAY['00000000-0000-0000-0000-0000000d0008']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c7','00000000-0000-0000-0000-0000000e0012',90,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c7','00000000-0000-0000-0000-0000000e001e',70,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- Explicit primaries (direct, exercising each failure mode; setter RPC is tested separately below):
UPDATE public.tenant_quizzes SET primary_readiness_tag_id=NULL                                          WHERE id='00000000-0000-0000-0000-0000000e0051';
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0004'        WHERE id='00000000-0000-0000-0000-0000000e0052'; -- T4 not designated
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0002'        WHERE id='00000000-0000-0000-0000-0000000e0053'; -- T2 not in snapshot
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0007'        WHERE id='00000000-0000-0000-0000-0000000e0054'; -- PrimArch
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-0000000d0008'        WHERE id='00000000-0000-0000-0000-0000000e0055'; -- PrimMerge

-- ── Required-area denominator fixtures (Blocker: optional areas must not change score) ──
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000e1','authenticated','authenticated','rsame1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000e2','authenticated','authenticated','rsame2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000e3','authenticated','authenticated','rzero@t.test',now(),now());
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id IN
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3');
-- R_same1 (e1): required evidence Q1(90,T1),Q2(80,T2),Q3(70,T1) → T1=80,T2=80 → overall 80.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000e0011',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000e0013',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
-- R_same2 (e2): IDENTICAL required evidence + a WEAK OPTIONAL quiz Q6(30,T3). Official score must be unchanged.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000e0011',90,5,ARRAY['00000000-0000-0000-0000-0000000d0001']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000e0012',80,5,ARRAY['00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000e0013',70,5,ARRAY['00000000-0000-0000-0000-0000000d0001','00000000-0000-0000-0000-0000000d0002']::uuid[]);
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000e0016',30,5,ARRAY['00000000-0000-0000-0000-0000000d0003']::uuid[]);
-- R_zero (e3): evidence exists but will be computed against a 0-required config → Not established.
SELECT pg_temp.mkatt('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000e0016',60,5,ARRAY['00000000-0000-0000-0000-0000000d0003']::uuid[]);
-- A throwaway config version with ONLY an optional designation (0 required areas).
INSERT INTO public.readiness_formula_versions (tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at)
VALUES ('00000000-0000-0000-0000-0000000000a0',99,'draft','{"model":"v2_quiz_mastery"}'::jsonb,80,'zero_required_cfg','tenant_customized',now());
INSERT INTO public.readiness_tag_designations (tenant_id,formula_version_id,tag_id,is_required)
 SELECT '00000000-0000-0000-0000-0000000000a0', id, '00000000-0000-0000-0000-0000000d0003', false
 FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND version=99;

-- ════════════ RUN SHADOW (whole tenant) ════════════
SELECT pg_temp.ok( (public.readiness_run_shadow('00000000-0000-0000-0000-0000000000a0', (SELECT vid FROM cfg))->>'processed')::int >= 10, 'run processed all reps');

-- ════════════ SCORING ASSERTIONS ════════════
-- Restab: Established, overall 80, band ready, 3 quizzes / 2 tags / 12 questions;
-- 1/N allocation: T1=83.3, T2=76.7; missing T3 evidence NOT counted as zero.
SELECT pg_temp.ok((SELECT success_status='ok' AND overall_score=80 AND flags->>'band'='ready'
   AND (evidence_summary->>'distinctQuizzes')='3' AND (evidence_summary->>'distinctReadinessTags')='2'
   AND (evidence_summary->>'distinctQuestions')='12'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a1'), 'Restab Established 80/ready 3-2-12');
-- Primary-tag attribution: Q3 (T1+T2) counts once in its primary T1 (lowest id); its
-- T2 side is insights-only. T1=avg(90,70)=80, T2=avg(80)=80, overall=80.
SELECT pg_temp.ok((SELECT (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0001')::numeric = 80
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0002')::numeric = 80
   AND (evidence_summary->'secondaryTagMastery'->>'00000000-0000-0000-0000-0000000d0002')::numeric = 70
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000a1'), 'Restab primary attribution T1=80 T2=80; Q3 T2 side is insights-only (secondary=70)');

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

-- ════════════ MULTI-TAG WEIGHTING INVARIANT (Blocker 2, Cases A–D) ════════════
-- Case A: Quiz A (100, tags T1+T3) + Quiz B (0, T1). Primary(A)=T1 → Product(T1)=avg(100,0)=50;
-- Pricing(T3) is Quiz A's SECONDARY (insights=100), not official. Quiz A gains NO extra overall
-- influence from its 2nd tag (coefficient 0.5 = Quiz B's 0.5). Only 1 primary tag → Establishing.
SELECT pg_temp.ok((SELECT (evidence_summary->'tagMastery'->>'00000000-0000-0000-0000-0000000d0001')::numeric = 50
   AND (evidence_summary->'secondaryTagMastery'->>'00000000-0000-0000-0000-0000000d0003')::numeric = 100
   AND (evidence_summary->>'distinctReadinessTags') = '1'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c1'),
   'Case A: multi-tag Quiz A not amplified — T1(official)=50, T3(insights)=100');

-- Case B: multi-tag Qmt (3 tags) counts once (primary T1). REQUIRED areas only: T1=avg(60,90)=75,
-- T2=80 → overall avg(75,80)=78. T3 is OPTIONAL → insights only (optionalAreaMastery=70), NOT scored.
SELECT pg_temp.ok((SELECT overall_score = 78
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0001')::numeric = 75
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0002')::numeric = 80
   AND (component_scores->'tagMastery' ? '00000000-0000-0000-0000-0000000d0003') IS FALSE      -- T3 NOT in official score
   AND (evidence_summary->'optionalAreaMastery'->>'00000000-0000-0000-0000-0000000d0003')::numeric = 70  -- T3 as insight
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c2'),
   'Case B: required-only → overall 78 (T1=75,T2=80); optional T3 is insights-only (70)');

-- Case C: a tag supported only by one multi-tag quiz (T1=50) vs a tag with several single-tag quizzes (T2=80) → overall 65.
SELECT pg_temp.ok((SELECT overall_score = 65
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0001')::numeric = 50
   AND (component_scores->'tagMastery'->>'00000000-0000-0000-0000-0000000d0002')::numeric = 80
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c3'),
   'Case C: single-multitag tag=50, multi-quiz tag=80 → overall 65');

-- Case D: c4 (100-quiz single-tag) vs c5 (SAME but 100-quiz carries a 2nd tag). Overall identical (65) —
-- adding a secondary tag with no new evidence did not change the rep's readiness.
SELECT pg_temp.ok(
   (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c4')
   = (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c5')
   AND (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c4') = 65,
   'Case D: adding a secondary tag left overall unchanged (65 == 65)');

-- ════════════ PRIMARY-TAG VALIDITY & EXCLUSIONS (Blocker 1) ════════════
-- Archive PrimArch and merge PrimMerge → T1 (as the taxonomy RPCs would), then recompute.
UPDATE public.tenant_quiz_tags SET status='archived' WHERE id='00000000-0000-0000-0000-0000000d0007';
UPDATE public.tenant_quiz_tags SET status='archived', merged_into='00000000-0000-0000-0000-0000000d0001' WHERE id='00000000-0000-0000-0000-0000000d0008';
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c6',(SELECT vid FROM cfg));
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000c7',(SELECT vid FROM cfg));

-- Rp: every quiz excluded from official scoring for a DISTINCT, honestly-reported reason;
-- no tag auto-chosen by id/order → Establishing (no valid primary).
SELECT pg_temp.ok((SELECT flags->>'state'='establishing'
   AND (evidence_summary->'excludedQuizzes'->>'primaryMissing')::int = 1
   AND (evidence_summary->'excludedQuizzes'->>'primaryNotDesignated')::int = 1
   AND (evidence_summary->'excludedQuizzes'->>'primaryNotAssigned')::int = 1
   AND (evidence_summary->'excludedQuizzes'->>'primaryArchived')::int = 1
   AND (evidence_summary->>'distinctReadinessTags') = '0'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c6'),
   'primary validity: missing/not-designated/not-assigned/archived each excluded honestly; no id fallback');

-- Rmerge: a merged primary tag resolves transparently to its active target (T1) — the quiz
-- still counts, attributed to the resolved tag. Established; Qmg primaryTag = T1.
SELECT pg_temp.ok((SELECT success_status='ok'
   AND EXISTS (SELECT 1 FROM jsonb_array_elements(evidence_summary->'includedQuizzes') e
               WHERE e->>'quizId'='00000000-0000-0000-0000-0000000e0055' AND e->>'primaryTag'='00000000-0000-0000-0000-0000000d0001')
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000c7'),
   'primary validity: merged primary resolves to active target (T1); quiz still counted');

-- Setter RPC: manager/orgAdmin can set a valid primary; invalid tags rejected; learner denied.
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a9');  -- orgAdmin A
SELECT pg_temp.ok( public.readiness_set_quiz_primary_tag('00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000d0001')->>'primaryReadinessTagId'='00000000-0000-0000-0000-0000000d0001', 'setter: orgAdmin sets a valid primary');
SELECT pg_temp.expect_error($$ SELECT public.readiness_set_quiz_primary_tag('00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000d0004') $$, 'setter: rejects a non-designated tag');
SELECT pg_temp.expect_error($$ SELECT public.readiness_set_quiz_primary_tag('00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000d0002') $$, 'setter: rejects a tag not assigned to the quiz');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000c9');  -- MANAGER (tenant C) can set within own tenant
SELECT pg_temp.ok( public.readiness_set_quiz_primary_tag('00000000-0000-0000-0000-000000ec0001','00000000-0000-0000-0000-000000dc0001')->>'primaryReadinessTagId'='00000000-0000-0000-0000-000000dc0001', 'setter: manager sets a valid primary (own tenant)');
SELECT pg_temp.as_user('00000000-0000-0000-0000-0000000000a1');  -- learner
SELECT pg_temp.expect_error($$ SELECT public.readiness_set_quiz_primary_tag('00000000-0000-0000-0000-0000000e0011','00000000-0000-0000-0000-0000000d0001') $$, 'setter: learner denied');

-- ════════════ REQUIRED-AREA DENOMINATOR & COMPARABILITY (Blocker) ════════════
-- Identical required evidence + different optional evidence → SAME official score;
-- a weak optional quiz cannot lower readiness; optional evidence still shows in insights.
SELECT pg_temp.ok(
   (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000e1')
   = (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000e2')
   AND (SELECT overall_score FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000e1') = 80,
   'same required evidence + different optional → same official score (80); weak optional cannot reduce it');
SELECT pg_temp.ok((SELECT (evidence_summary->'optionalAreaMastery'->>'00000000-0000-0000-0000-0000000d0003')::numeric = 30
   AND (component_scores->'tagMastery' ? '00000000-0000-0000-0000-0000000d0003') IS FALSE
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000e2'),
   'optional evidence appears in insights (optionalAreaMastery T3=30) but not in the official score');

-- Zero required areas → Not established (never silently score optional areas).
SELECT public.readiness_compute_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000e3',
   (SELECT id FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND version=99));
SELECT pg_temp.ok((SELECT success_status='insufficient_evidence' AND flags->>'state'='establishing'
   AND overall_score IS NULL AND (evidence_summary->>'noRequiredAreas')='true'
   FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-0000000000e3'
     AND formula_version_id=(SELECT id FROM public.readiness_formula_versions WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND version=99)),
   'zero required areas → Not established (optional areas never silently scored)');

-- Team/company comparability: every ESTABLISHED rep shares the same required denominator (2),
-- and AVG(overall_score) naturally includes only established rows (establishing/stale are NULL).
SELECT pg_temp.ok(
   NOT EXISTS (SELECT 1 FROM public.readiness_scores_current
               WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND success_status='ok'
                 AND (evidence_summary->>'requiredDenominator')::int <> 2)
   AND EXISTS (SELECT 1 FROM public.readiness_scores_current
               WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND overall_score IS NULL)
   AND (SELECT count(*) FILTER (WHERE overall_score IS NOT NULL) = count(*) FILTER (WHERE success_status='ok')
        FROM public.readiness_scores_current WHERE tenant_id='00000000-0000-0000-0000-0000000000a0'),
   'team averages: all established reps share the same required denominator; only established rows carry a score');

-- ════════════ PRIMARY-TAG WRITE GUARD — PRODUCTION-ACL PARITY (trigger, grant-independent) ════════════
-- Reproduce PRODUCTION's grant state: authenticated has table-level SELECT/INSERT/UPDATE on
-- tenant_quizzes (which makes the column-level REVOKE a no-op). The BEFORE INSERT/UPDATE
-- trigger is the authoritative guard and must deny all untrusted primary writes while leaving
-- ordinary quiz edits working.
GRANT SELECT, INSERT, UPDATE ON public.tenant_quizzes TO authenticated;
-- Dedicated fixtures (created as postgres = trusted).
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000fa','authenticated','authenticated','mgrg@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000fb','authenticated','authenticated','lg@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000000000f0','tg','TG'), ('00000000-0000-0000-0000-0000000000f1','tg2','TG2');
UPDATE public.profiles SET role='manager', tenant_id='00000000-0000-0000-0000-0000000000f0', status='active' WHERE id='00000000-0000-0000-0000-0000000000fa';
UPDATE public.profiles SET role='user',    tenant_id='00000000-0000-0000-0000-0000000000f0', status='active' WHERE id='00000000-0000-0000-0000-0000000000fb';
INSERT INTO public.tenant_quiz_tags(id,tenant_id,label) VALUES
 ('00000000-0000-0000-0000-00000000fa01','00000000-0000-0000-0000-0000000000f0','TGa'),
 ('00000000-0000-0000-0000-00000000fa02','00000000-0000-0000-0000-0000000000f0','TGb');
INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,questions) VALUES
 ('00000000-0000-0000-0000-00000000fb01','00000000-0000-0000-0000-0000000000f0','QGn','active','[]'::jsonb),
 ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000f0','QGs','active','[]'::jsonb),
 ('00000000-0000-0000-0000-00000000fb03','00000000-0000-0000-0000-0000000000f1','QGx','active','[]'::jsonb);
-- Trusted (postgres) may set the primary — establishes the "already set" baseline for change/clear tests.
UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' WHERE id='00000000-0000-0000-0000-00000000fb02';
SELECT pg_temp.ok((SELECT primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-00000000fb02'), 'guard: trusted (postgres) CAN set primary');

SAVEPOINT sp_guard;
SET LOCAL ROLE authenticated;
-- Manager (RLS-permitted) — every primary write must be rejected by the trigger; normal edits allowed.
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000fa","role":"authenticated","app_metadata":{"role":"orgAdmin"}}',true);
DO $$
DECLARE n int;
BEGIN
  -- name-only (primary unchanged) → ALLOWED
  UPDATE public.tenant_quizzes SET name='QGn2' WHERE id='00000000-0000-0000-0000-00000000fb01';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1 THEN RAISE EXCEPTION '087 FAIL: manager normal edit blocked (n=%)', n; END IF;
  -- update with SAME primary (unchanged) → ALLOWED (no trigger fire)
  UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' WHERE id='00000000-0000-0000-0000-00000000fb02';
  -- set primary (NULL→TGa) → DENIED
  BEGIN UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' WHERE id='00000000-0000-0000-0000-00000000fb01';
    RAISE EXCEPTION '087 FAIL: manager could SET primary directly';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- change primary (TGa→TGb) → DENIED
  BEGIN UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa02' WHERE id='00000000-0000-0000-0000-00000000fb02';
    RAISE EXCEPTION '087 FAIL: manager could CHANGE primary directly';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- clear primary (TGa→NULL) → DENIED
  BEGIN UPDATE public.tenant_quizzes SET primary_readiness_tag_id=NULL WHERE id='00000000-0000-0000-0000-00000000fb02';
    RAISE EXCEPTION '087 FAIL: manager could CLEAR primary directly';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- multi-column update (name + primary) → DENIED (cannot smuggle via multi-col)
  BEGIN UPDATE public.tenant_quizzes SET name='x', primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa02' WHERE id='00000000-0000-0000-0000-00000000fb02';
    RAISE EXCEPTION '087 FAIL: manager smuggled primary via multi-col update';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- INSERT with non-null primary → DENIED
  BEGIN INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,questions,primary_readiness_tag_id)
        VALUES ('00000000-0000-0000-0000-00000000fb09','00000000-0000-0000-0000-0000000000f0','QGi','active','[]'::jsonb,'00000000-0000-0000-0000-00000000fa01');
    RAISE EXCEPTION '087 FAIL: manager INSERTed a non-null primary';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- UPSERT (INSERT ... ON CONFLICT DO UPDATE SET primary) → DENIED
  BEGIN INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,questions)
        VALUES ('00000000-0000-0000-0000-00000000fb02','00000000-0000-0000-0000-0000000000f0','QGs','active','[]'::jsonb)
        ON CONFLICT (id) DO UPDATE SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa02';
    RAISE EXCEPTION '087 FAIL: manager smuggled primary via upsert';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END;
  -- cross-tenant: manager of TG cannot touch TG2's quiz (RLS filters → 0 rows)
  UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' WHERE id='00000000-0000-0000-0000-00000000fb03';
  GET DIAGNOSTICS n = ROW_COUNT; IF n <> 0 THEN RAISE EXCEPTION '087 FAIL: manager wrote cross-tenant quiz (n=%)', n; END IF;
END $$;
-- Learner (RLS role-gated) cannot change primary; assert no change occurred.
SELECT set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000fb","role":"authenticated","app_metadata":{"role":"orgAdmin"}}',true);  -- spoofed elevated claim
DO $$
DECLARE n int;
BEGIN
  UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa02' WHERE id='00000000-0000-0000-0000-00000000fb02';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION '087 FAIL: learner (even with spoofed claim) changed primary (n=%)', n; END IF;
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END $$;
-- Anon cannot change primary.
SELECT set_config('request.jwt.claims','{"role":"anon"}',true);
DO $$
DECLARE n int;
BEGIN
  UPDATE public.tenant_quizzes SET primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa02' WHERE id='00000000-0000-0000-0000-00000000fb02';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION '087 FAIL: anon changed primary (n=%)', n; END IF;
EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '087 FAIL%' THEN RAISE; END IF; END $$;
RESET ROLE;
-- Confirm the stored primary is STILL TGa (unchanged by any untrusted attempt).
SELECT pg_temp.ok((SELECT primary_readiness_tag_id='00000000-0000-0000-0000-00000000fa01' FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-00000000fb02'), 'guard: primary unchanged after all untrusted attempts (manager/learner/anon/spoof/cross-tenant/upsert/multi-col)');
ROLLBACK TO SAVEPOINT sp_guard;

SELECT '087 ALL TESTS PASSED' AS result;
ROLLBACK;
