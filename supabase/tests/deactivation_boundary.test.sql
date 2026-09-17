-- Deactivation access boundary — proves protected/org data is denied IMMEDIATELY after removal, on the
-- SAME still-valid session (before any refresh). Authorization is derived live from profiles (via
-- get_my_tenant_id / readiness_caller_tenant), NOT from the JWT, so detaching the profile takes effect at
-- once for every tenant-scoped RLS policy and SECDEF RPC. One rolled-back transaction. Local only.
-- Expect "DEACTIVATION BOUNDARY: ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL readiness.allow_unguarded='1';

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION 'DEACTIVATION BOUNDARY FAIL: %', label; END IF; END $$;

-- fixtures: tenant T, two active learners (so the roster is >1 before removal)
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-0000000db001','authenticated','authenticated','db1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000db002','authenticated','authenticated','db2@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES ('00000000-0000-0000-0000-00000000db0a','tdb','TDB');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES ('00000000-0000-0000-0000-00000000db0a','{}');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-00000000db0a',status='active'
 WHERE id IN ('00000000-0000-0000-0000-0000000db001','00000000-0000-0000-0000-0000000db002');

\set U1 '00000000-0000-0000-0000-0000000db001'
\set T  '00000000-0000-0000-0000-00000000db0a'

-- ── BEFORE removal: the learner is scoped to tenant T and sees the org roster ──
SELECT set_config('request.jwt.claims', json_build_object('sub',:'U1')::text, true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok(public.get_my_tenant_id() = :'T', 'B1: my_tenant = T before removal');
SELECT pg_temp.ok(public.readiness_caller_tenant() = :'T', 'B2: readiness_caller_tenant = T before removal');
SELECT pg_temp.ok((SELECT count(*) FROM public.profiles WHERE tenant_id = :'T') = 2, 'B3: sees org roster (2) before removal');
RESET ROLE;

-- ── REMOVE the learner (what readiness_lifecycle_remove_member does to the profile) ──
UPDATE public.profiles SET status='inactive', role='user', tenant_id=NULL WHERE id = :'U1';

-- ── AFTER removal, SAME session (jwt unchanged): everything tenant-scoped denies immediately ──
SELECT set_config('request.jwt.claims', json_build_object('sub',:'U1')::text, true);
SET LOCAL ROLE authenticated;
SELECT pg_temp.ok(public.get_my_tenant_id() IS NULL, 'A1: my_tenant is NULL immediately after removal');
SELECT pg_temp.ok(public.readiness_caller_tenant() IS NULL, 'A2: readiness_caller_tenant is NULL after removal');
SELECT pg_temp.ok((SELECT count(*) FROM public.profiles WHERE tenant_id = :'T') = 0, 'A3: org roster denied (0) after removal');
SELECT pg_temp.ok((SELECT count(*) FROM public.profiles) = 1, 'A4: only own (now-inactive) row remains visible');
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id = :'U1') = 'inactive', 'A5: own row reads back inactive');
RESET ROLE;

SELECT 'DEACTIVATION BOUNDARY: ALL TESTS PASSED' AS result;
ROLLBACK;
