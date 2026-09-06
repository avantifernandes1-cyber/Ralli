-- Repeatable behavioral tests for migration 092 (profile-write lockdown). Assumes 091 AND 092 are applied.
-- One rolled-back transaction. Local only. Expect "092 ALL TESTS PASSED".
-- Covers: the fail-closed profiles guard (direct change blocked; team-only pass; lifecycle-RPC marker path;
-- ops break-glass with trusted executor); grant hardening (role/status/tenant/team/xp not client-updatable;
-- safe presentation fields updatable; anon has nothing; no direct client INSERT); ensure_self_profile still
-- creates a server-derived identity while direct INSERT is denied.
\set ON_ERROR_STOP on
BEGIN;

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '092 FAIL: %', label; END IF; END $$;

-- ── fixtures ──
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-000000920002','authenticated','authenticated','u2@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000920012','authenticated','authenticated','ad@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000920013','authenticated','authenticated','nv@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES ('00000000-0000-0000-0000-0000009200a0','ta92','TA92');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES ('00000000-0000-0000-0000-0000009200a0','{}');
-- seed profile states through the break-glass (postgres + allow_unguarded) so the guard permits fixture setup
SET LOCAL readiness.allow_unguarded = '1';
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000009200a0',status='active' WHERE id='00000000-0000-0000-0000-000000920002';
UPDATE public.profiles SET role='ralli_admin',tenant_id=NULL,status='active' WHERE id='00000000-0000-0000-0000-000000920012';
SET LOCAL readiness.allow_unguarded = '';   -- guard now fully active for the assertions below

\set u2  '00000000-0000-0000-0000-000000920002'
\set TA  '00000000-0000-0000-0000-0000009200a0'
\set adm '00000000-0000-0000-0000-000000920012'

-- ══ SG. PROFILES LIFECYCLE GUARD ══
-- SG1: direct status/role/tenant change with NO marker and break-glass OFF → guard RAISES
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','',true);
  PERFORM set_config('readiness.lifecycle_write','',true);
  BEGIN
    UPDATE public.profiles SET status='inactive' WHERE id='00000000-0000-0000-0000-000000920002';
    RAISE EXCEPTION 'SG1_NOT_BLOCKED';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%SG1_NOT_BLOCKED%' THEN RAISE EXCEPTION '092 FAIL: SG1 guard did not block a direct status change'; END IF;
  END;
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u2')='active', 'SG1: direct status change blocked, row unchanged');

-- SG2: a team_id-only update is NOT guarded (column not watched) → passes with no marker/break-glass
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','',true);
  UPDATE public.profiles SET team_id=NULL WHERE id='00000000-0000-0000-0000-000000920002';
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok(true, 'SG2: team_id-only update passes (not a guarded column)');

-- SG3: a lifecycle RPC (marker path) applies with break-glass OFF (proves the guard permits the sanctioned path)
DO $g$ BEGIN PERFORM set_config('readiness.allow_unguarded','',true); END $g$ LANGUAGE plpgsql;
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);
SELECT public.readiness_lifecycle_remove_member(:'u2');
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u2')='inactive'
  AND (SELECT tenant_id FROM public.profiles WHERE id=:'u2') IS NULL, 'SG3: lifecycle RPC (marker) applies with break-glass OFF');
SELECT set_config('request.jwt.claims', NULL, true);

-- SG4: ops break-glass (allow_unguarded=1 AND trusted current_user=postgres) permits a direct change
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','1',true);
  UPDATE public.profiles SET status='active', tenant_id='00000000-0000-0000-0000-0000009200a0' WHERE id='00000000-0000-0000-0000-000000920002';
  PERFORM set_config('readiness.allow_unguarded','',true);
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u2')='active', 'SG4: break-glass (setting + trusted executor) permits a direct change');

-- ══ GR. GRANT HARDENING ══
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','role','UPDATE'), 'GR1a: authenticated cannot UPDATE role');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','status','UPDATE'), 'GR1b: authenticated cannot UPDATE status');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','tenant_id','UPDATE'), 'GR1c: authenticated cannot UPDATE tenant_id');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','team_id','UPDATE'), 'GR1d: authenticated cannot UPDATE team_id');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','xp','UPDATE'), 'GR1e: authenticated cannot UPDATE xp');
SELECT pg_temp.ok(has_column_privilege('authenticated','public.profiles','name','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','nickname','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','avatar_emoji','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','profile_pic_url','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','notif_prefs','UPDATE'), 'GR2: authenticated may UPDATE safe presentation fields');
SELECT pg_temp.ok(NOT has_table_privilege('anon','public.profiles','SELECT')
  AND NOT has_table_privilege('anon','public.profiles','UPDATE')
  AND NOT has_table_privilege('anon','public.profiles','INSERT'), 'GR3: anon has no profiles privileges');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.profiles','INSERT'), 'GR4: authenticated has NO direct INSERT on profiles');

-- ══ SP. ensure_self_profile: created semantics + protected-field preservation (092 correction) ══
-- handle_new_user auto-creates a profile on the auth.users insert, so delete it first to test a real "missing
-- profile" recovery where the INSERT actually happens.
DELETE FROM public.readiness_scores_current WHERE user_id='00000000-0000-0000-0000-000000920013';
DELETE FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920013';
SELECT set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000920013')::text, true);
-- SP1: FIRST creation → created:true, and role=user / status=active / tenant_id NULL / team_id NULL (never invents an org)
SELECT pg_temp.ok((public.ensure_self_profile('New Voter')->>'created')='true', 'SP1a: first ensure_self_profile returns created:true');
SELECT pg_temp.ok((SELECT role FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920013')='user'
  AND (SELECT status FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920013')='active'
  AND (SELECT tenant_id FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920013') IS NULL
  AND (SELECT team_id FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920013') IS NULL,
  'SP1b: created as user/active/no-org/no-team (never guesses an organisation)');
-- SP2: SECOND call for the now-existing profile → created:false
SELECT pg_temp.ok((public.ensure_self_profile('Different Name')->>'created')='false', 'SP2: existing profile returns created:false');
SELECT set_config('request.jwt.claims', NULL, true);
-- SP3: an existing ATTACHED profile → ensure_self_profile returns created:false and leaves protected fields UNCHANGED
SET LOCAL readiness.allow_unguarded='1';
UPDATE public.profiles SET role='orgAdmin', status='active', tenant_id=:'TA' WHERE id='00000000-0000-0000-0000-000000920002';
SET LOCAL readiness.allow_unguarded='';
SELECT set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000920002')::text, true);
SELECT pg_temp.ok((public.ensure_self_profile('Attempted Rename')->>'created')='false', 'SP3a: existing attached profile returns created:false');
SELECT pg_temp.ok((SELECT role FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920002')='orgAdmin'
  AND (SELECT status FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920002')='active'
  AND (SELECT tenant_id FROM public.profiles WHERE id='00000000-0000-0000-0000-000000920002')=:'TA',
  'SP3b: ensure_self_profile left role/status/tenant of an existing profile UNCHANGED');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ SEC: guard metadata ══
SELECT pg_temp.ok((SELECT prosecdef=false AND array_to_string(proconfig,',')='search_path=""'
  FROM pg_proc WHERE proname='readiness_profiles_lifecycle_guard'), 'SEC: guard is SECURITY INVOKER with empty search_path');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_readiness_profiles_lifecycle_guard'), 'SEC: guard trigger installed on profiles');

SELECT '092 ALL TESTS PASSED' AS result;
ROLLBACK;
