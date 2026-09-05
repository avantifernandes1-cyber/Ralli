-- Repeatable behavioral tests for migration 091 (readiness learner lifecycle, RPC-first).
-- Assumes 091 is applied. One rolled-back transaction. Local only. Expect "091 ALL TESTS PASSED".
-- Covers: canonical active-only eligibility (fail-closed) at both chokepoints; FK remodel (history/queue
-- identity, current composite) + history preservation across transfer; the lifecycle transition table via
-- the advisory-first engine; the fail-closed profiles guard (marker path, team-only pass, break-glass);
-- the scores_current write-guard; ensure_self_profile + grant hardening (self-escalation denial); the
-- cleanup sweep; security/grants; and the static "no advisory-holder writes the queue" invariant.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL readiness.allow_unguarded = '1';   -- postgres break-glass: FIXTURE state setup only (toggled off for guard tests)

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '091 FAIL: %', label; END IF; END $$;

CREATE FUNCTION pg_temp.cur_cnt(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_scores_current WHERE tenant_id=p_tenant AND user_id=p_user; $$;
CREATE FUNCTION pg_temp.hist_cnt(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_score_history WHERE tenant_id=p_tenant AND user_id=p_user; $$;
CREATE FUNCTION pg_temp.job_cnt(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_recalc_queue WHERE tenant_id=p_tenant AND user_id=p_user
   AND status IN ('pending','processing'); $$;

-- seed a scores_current row (simulate prior compute)
CREATE FUNCTION pg_temp.mkcur(p_tenant uuid, p_user uuid, p_ver uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.readiness_scores_current(tenant_id,user_id,formula_version_id,success_status,overall_score,calculated_at,calculated_config_hash,last_attempt_at,last_attempt_status)
  VALUES (p_tenant,p_user,p_ver,'ok',80,now(),'h',now(),'ok');
END $$;
-- seed a history row (simulate immutable prior snapshot)
CREATE FUNCTION pg_temp.mkhist(p_tenant uuid, p_user uuid, p_ver uuid, p_key text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO public.readiness_score_history(tenant_id,user_id,formula_version_id,success_status,material_state_hash,calculated_config_hash,idempotency_key,calculated_at,overall_score)
  VALUES (p_tenant,p_user,p_ver,'ok','m'||p_key,'h',p_key,now(),80);
END $$;

-- ── fixtures ──
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-000000910001','authenticated','authenticated','u1@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000910002','authenticated','authenticated','u2@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000910011','authenticated','authenticated','m1@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000910012','authenticated','authenticated','ad@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000910013','authenticated','authenticated','nv@t.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000009100a0','ta91','TA91'),('00000000-0000-0000-0000-0000009100b0','tb91','TB91');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES
 ('00000000-0000-0000-0000-0000009100a0','{}'),('00000000-0000-0000-0000-0000009100b0','{}');
UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000009100a0',status='active' WHERE id IN
 ('00000000-0000-0000-0000-000000910001','00000000-0000-0000-0000-000000910002');
UPDATE public.profiles SET role='orgAdmin',tenant_id='00000000-0000-0000-0000-0000009100a0',status='active' WHERE id='00000000-0000-0000-0000-000000910011';
UPDATE public.profiles SET role='ralli_admin',tenant_id=NULL,status='active' WHERE id='00000000-0000-0000-0000-000000910012';
INSERT INTO public.readiness_formula_versions(id,tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at) VALUES
 ('00000000-0000-0000-0000-0000009100fa','00000000-0000-0000-0000-0000009100a0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now()),
 ('00000000-0000-0000-0000-0000009100fb','00000000-0000-0000-0000-0000009100b0',2,'active','{"model":"v2_quiz_mastery"}'::jsonb,80,'h','tenant_customized',now(),now());

\set TA '00000000-0000-0000-0000-0000009100a0'
\set TB '00000000-0000-0000-0000-0000009100b0'
\set VA '00000000-0000-0000-0000-0000009100fa'
\set VB '00000000-0000-0000-0000-0000009100fb'
\set u1 '00000000-0000-0000-0000-000000910001'
\set u2 '00000000-0000-0000-0000-000000910002'
\set mgr '00000000-0000-0000-0000-000000910011'
\set adm '00000000-0000-0000-0000-000000910012'

-- ══ E. CANONICAL ELIGIBILITY (fail-closed) ══
SELECT pg_temp.ok(public.readiness_is_scorable_rep(:'TA',:'u1'), 'E1: active user scorable');
UPDATE public.profiles SET status='suspended' WHERE id=:'u1';
SELECT pg_temp.ok(NOT public.readiness_is_scorable_rep(:'TA',:'u1'), 'E2: suspended NOT scorable');
UPDATE public.profiles SET status='invited' WHERE id=:'u1';
SELECT pg_temp.ok(NOT public.readiness_is_scorable_rep(:'TA',:'u1'), 'E3: invited NOT scorable');
UPDATE public.profiles SET status='inactive' WHERE id=:'u1';
SELECT pg_temp.ok(NOT public.readiness_is_scorable_rep(:'TA',:'u1'), 'E4: inactive NOT scorable');
UPDATE public.profiles SET status='archived_unknown' WHERE id=:'u1';
SELECT pg_temp.ok(NOT public.readiness_is_scorable_rep(:'TA',:'u1'), 'E5: unknown/free-text status NOT scorable (fail-closed)');
UPDATE public.profiles SET status='active' WHERE id=:'u1';
SELECT pg_temp.ok(NOT public.readiness_is_scorable_rep(:'TA',:'mgr'), 'E6: orgAdmin NOT scorable (role)');
-- enqueue gate mirrors is_scorable_rep: suspended enqueues nothing; active user enqueues one
UPDATE public.profiles SET status='suspended' WHERE id=:'u2';
SELECT public.enqueue_readiness_recalc(:'TA',:'u2',NULL,'manual','{}'::jsonb);
SELECT pg_temp.ok(pg_temp.job_cnt(:'TA',:'u2')=0, 'E7a: enqueue gate drops suspended learner');
UPDATE public.profiles SET status='active' WHERE id=:'u2';
SELECT public.enqueue_readiness_recalc(:'TA',:'u2',NULL,'manual','{}'::jsonb);
SELECT pg_temp.ok(pg_temp.job_cnt(:'TA',:'u2')=1, 'E7b: enqueue gate admits active user');
DELETE FROM public.readiness_recalc_queue WHERE tenant_id=:'TA';

-- ══ F. FK MODEL + history preservation ══
SELECT pg_temp.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='rsh_user_fk')
  = 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE RESTRICT', 'F1: history identity FK RESTRICT');
SELECT pg_temp.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='rrq_user_fk')
  = 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE', 'F2: queue identity FK CASCADE');
SELECT pg_temp.ok((SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='rsc_user_same_tenant')
  = 'FOREIGN KEY (user_id, tenant_id) REFERENCES profiles(id, tenant_id) ON DELETE CASCADE', 'F3: current keeps composite FK');

-- ══ L. LIFECYCLE TRANSITIONS (via the advisory-first engine; marker path exercises the guard) ══
-- seed u1 current + history in TA
SELECT pg_temp.mkcur(:'TA',:'u1',:'VA');
SELECT pg_temp.mkhist(:'TA',:'u1',:'VA','k1');
-- L1 deactivate: current gone, history kept
SELECT public.readiness_lifecycle_apply(:'u1','inactive','user',:'TA', NULL,NULL,NULL,false);
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u1')=0, 'L1a: deactivate removes current');
SELECT pg_temp.ok(pg_temp.hist_cnt(:'TA',:'u1')=1, 'L1b: deactivate preserves history');
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u1')='inactive', 'L1c: status inactive');
-- L7 reversible: reactivate into TA
SELECT public.readiness_lifecycle_apply(:'u1','active','user',:'TA', NULL,NULL,NULL,false);
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u1')='active' AND (SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TA', 'L7: remove is reversible (reactivate active in TA)');
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u1')=0, 'L2: reactivate leaves current absent (async recompute)');

-- L3 role learner->manager: current removed
SELECT pg_temp.mkcur(:'TA',:'u1',:'VA');
SELECT public.readiness_lifecycle_apply(:'u1','active','orgAdmin',:'TA', NULL,NULL,NULL,false);
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u1')=0 AND (SELECT role FROM public.profiles WHERE id=:'u1')='orgAdmin', 'L3: learner->manager removes current');
-- L4 manager->user: role back to user, current absent (async)
SELECT public.readiness_lifecycle_apply(:'u1','active','user',:'TA', NULL,NULL,NULL,false);
SELECT pg_temp.ok((SELECT role FROM public.profiles WHERE id=:'u1')='user' AND pg_temp.cur_cnt(:'TA',:'u1')=0, 'L4: manager->user (async recompute)');

-- L5 transfer TA->TB: A current gone, A history preserved under TA, tenant now TB, transfer NOT FK-blocked by history
SELECT pg_temp.mkcur(:'TA',:'u1',:'VA');
SELECT pg_temp.ok(pg_temp.hist_cnt(:'TA',:'u1')=1, 'L5-pre: A history present before transfer');
SELECT public.readiness_lifecycle_apply(:'u1','active','user',:'TB', NULL,NULL,NULL,false);
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TB', 'L5a: transfer applied (not FK-blocked by history)');
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u1')=0, 'L5b: old-tenant current removed');
SELECT pg_temp.ok(pg_temp.hist_cnt(:'TA',:'u1')=1, 'L5c: history preserved under ORIGINAL tenant TA');
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TB',:'u1')=0, 'L5d: no current carried into new tenant TB');
-- move u1 back to TA for later tests
SELECT public.readiness_lifecycle_apply(:'u1','active','user',:'TA', NULL,NULL,NULL,false);

-- L6 no-op: same state → changed=false, no delete
SELECT pg_temp.mkcur(:'TA',:'u1',:'VA');
SELECT pg_temp.ok((public.readiness_lifecycle_apply(:'u1','active','user',:'TA', NULL,NULL,NULL,false)->>'changed')='false', 'L6a: no-op reports changed=false');
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u1')=1, 'L6b: no-op leaves current untouched');
DELETE FROM public.readiness_scores_current WHERE tenant_id=:'TA' AND user_id=:'u1';

-- ══ W. SCORES_CURRENT WRITE-GUARD ══
UPDATE public.profiles SET status='inactive' WHERE id=:'u2';   -- keep tenant so composite FK ok
SELECT pg_temp.mkcur(:'TA',:'u2',:'VA');    -- write-guard should skip (non-scorable) → 0 rows
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u2')=0, 'W1: write-guard skips current insert for non-scorable learner');
UPDATE public.profiles SET status='active' WHERE id=:'u2';
SELECT pg_temp.mkcur(:'TA',:'u2',:'VA');
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u2')=1, 'W2: write-guard admits current insert for scorable learner');

-- ══ C. RECONCILE CLEANUP (advisory + delete; no enqueue) ══
-- u2 currently scorable with a current row; make u2 non-scorable directly (break-glass) leaving the stale row
UPDATE public.profiles SET status='inactive' WHERE id=:'u2';
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u2')=1, 'C-pre: stale current row exists for now-inactive u2');
SELECT public.readiness_reconcile_cleanup(500);
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u2')=0, 'C1: cleanup removes stale non-scorable current row');
UPDATE public.profiles SET status='active' WHERE id=:'u2';
SELECT pg_temp.mkcur(:'TA',:'u2',:'VA');
SELECT public.readiness_reconcile_cleanup(500);
SELECT pg_temp.ok(pg_temp.cur_cnt(:'TA',:'u2')=1, 'C2: cleanup retains scorable current row');
DELETE FROM public.readiness_scores_current WHERE tenant_id=:'TA' AND user_id=:'u2';

-- ══ G. PROFILES LIFECYCLE GUARD (fail-closed) ══
-- G1: direct status change with NO marker and break-glass OFF → guard RAISES
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','',true);
  PERFORM set_config('readiness.lifecycle_write','',true);   -- clear any leaked marker: simulate a bare direct write
  BEGIN
    UPDATE public.profiles SET status='inactive' WHERE id='00000000-0000-0000-0000-000000910002';
    RAISE EXCEPTION 'G1_NOT_BLOCKED';
  EXCEPTION
    WHEN others THEN
      IF SQLERRM LIKE '%G1_NOT_BLOCKED%' THEN RAISE EXCEPTION '091 FAIL: G1 guard did not block direct status change'; END IF;
  END;
  PERFORM set_config('readiness.allow_unguarded','1',true);  -- restore break-glass for remaining fixtures
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u2')='active', 'G1: blocked direct status change left row unchanged');
-- G2: team_id-only update is NOT guarded (passes even without marker/break-glass)
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','',true);
  UPDATE public.profiles SET team_id=NULL WHERE id='00000000-0000-0000-0000-000000910002';   -- no status/role/tenant change → guard no-op
  PERFORM set_config('readiness.allow_unguarded','1',true);
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok(true, 'G2: team_id-only update passes (not a guarded column)');
-- G3: lifecycle engine (marker path) with break-glass OFF still works
DO $g$ BEGIN
  PERFORM set_config('readiness.allow_unguarded','',true);
  PERFORM public.readiness_lifecycle_apply('00000000-0000-0000-0000-000000910002','inactive','user','00000000-0000-0000-0000-0000009100a0', NULL,NULL,NULL,false);
  PERFORM set_config('readiness.allow_unguarded','1',true);
END $g$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u2')='inactive', 'G3: lifecycle RPC (marker) applies with break-glass OFF');
SELECT public.readiness_lifecycle_apply(:'u2','active','user',:'TA', NULL,NULL,NULL,false);

-- ══ S. SELF-ESCALATION GRANT HARDENING ══
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','role','UPDATE'), 'S1a: authenticated cannot UPDATE role');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','status','UPDATE'), 'S1b: authenticated cannot UPDATE status');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','tenant_id','UPDATE'), 'S1c: authenticated cannot UPDATE tenant_id');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','team_id','UPDATE'), 'S1d: authenticated cannot UPDATE team_id');
SELECT pg_temp.ok(NOT has_column_privilege('authenticated','public.profiles','xp','UPDATE'), 'S1e: authenticated cannot UPDATE xp');
SELECT pg_temp.ok(has_column_privilege('authenticated','public.profiles','name','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','nickname','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','avatar_emoji','UPDATE')
  AND has_column_privilege('authenticated','public.profiles','notif_prefs','UPDATE'), 'S2: authenticated may UPDATE safe presentation fields');
SELECT pg_temp.ok(NOT has_table_privilege('anon','public.profiles','SELECT')
  AND NOT has_table_privilege('anon','public.profiles','UPDATE')
  AND NOT has_table_privilege('anon','public.profiles','INSERT'), 'S3: anon has no profiles privileges');
-- S4: ensure_self_profile creates own row as user/active
INSERT INTO public.tenants(id,slug,name) VALUES ('00000000-0000-0000-0000-0000009100c0','tc91','TC91');
SELECT set_config('request.jwt.claims', json_build_object('sub','00000000-0000-0000-0000-000000910013')::text, true);
SELECT public.ensure_self_profile('New Voter');
SELECT pg_temp.ok((SELECT role FROM public.profiles WHERE id='00000000-0000-0000-0000-000000910013')='user'
  AND (SELECT status FROM public.profiles WHERE id='00000000-0000-0000-0000-000000910013')='active'
  AND (SELECT tenant_id FROM public.profiles WHERE id='00000000-0000-0000-0000-000000910013') IS NULL, 'S4: ensure_self_profile → user/active/no-tenant');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ A. AUTHORIZATION on the wrapper RPCs ══
-- non-admin (learner u2) cannot remove a member
SELECT set_config('request.jwt.claims', json_build_object('sub',:'u2')::text, true);
DO $a$ BEGIN
  BEGIN PERFORM public.readiness_lifecycle_remove_member('00000000-0000-0000-0000-000000910001'); RAISE EXCEPTION 'A_NOAUTHZ_FAIL';
  EXCEPTION WHEN others THEN IF SQLERRM LIKE '%A_NOAUTHZ_FAIL%' THEN RAISE EXCEPTION '091 FAIL: A1 learner could remove a member'; END IF; END;
END $a$ LANGUAGE plpgsql;
SELECT pg_temp.ok(true, 'A1: learner cannot call remove_member (authz denied)');
-- orgAdmin of TA can remove u1
SELECT set_config('request.jwt.claims', json_build_object('sub',:'mgr')::text, true);
SELECT public.readiness_lifecycle_remove_member(:'u1');
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u1')='inactive' AND (SELECT tenant_id FROM public.profiles WHERE id=:'u1') IS NULL, 'A2: orgAdmin removed member (inactive, detached)');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ R. RE-READ CONTRACT + AUTHZ PRECONDITIONS (correction round) ══
-- restore u1 to a known active-in-TA baseline (earlier sections deactivated/removed it); break-glass is on.
UPDATE public.profiles SET status='active', role='user', tenant_id=:'TA' WHERE id=:'u1';
-- R1 (#7): expected-status mismatch aborts with 40001 (u1 is active; assert expected 'inactive')
DO $r$ BEGIN
  BEGIN
    PERFORM public.readiness_lifecycle_apply('00000000-0000-0000-0000-000000910001','inactive','user',
              '00000000-0000-0000-0000-0000009100a0','inactive',NULL,NULL,false);
    RAISE EXCEPTION 'R1_NO_ABORT';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%R1_NO_ABORT%' THEN RAISE EXCEPTION '091 FAIL: R1 expected-status mismatch did not abort'; END IF;
    IF SQLSTATE <> '40001' THEN RAISE EXCEPTION '091 FAIL: R1 aborted % not 40001', SQLSTATE; END IF;
  END;
END $r$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'u1')='active', 'R1: expected-status mismatch aborted 40001, row unchanged');

-- R2 (#1/#3): stale expected-tenant aborts with 40001 (u1 in TA; assert expected TB)
DO $r$ BEGIN
  BEGIN
    PERFORM public.readiness_lifecycle_apply('00000000-0000-0000-0000-000000910001','active','user',
              '00000000-0000-0000-0000-0000009100a0',NULL,NULL,'00000000-0000-0000-0000-0000009100b0',true);
    RAISE EXCEPTION 'R2_NO_ABORT';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%R2_NO_ABORT%' THEN RAISE EXCEPTION '091 FAIL: R2 stale expected-tenant did not abort'; END IF;
    IF SQLSTATE <> '40001' THEN RAISE EXCEPTION '091 FAIL: R2 aborted % not 40001', SQLSTATE; END IF;
  END;
END $r$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TA', 'R2: stale expected-tenant aborted 40001 (authorization stale), row unchanged');

-- R3 (#2): a destination admin cannot reactivate/claim a member ATTACHED to another org.
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);   -- adm = ralli_admin
DO $r$ BEGIN
  BEGIN
    -- u1 is ACTIVE and ATTACHED to TA; reactivating "into" TB must be refused (must use transfer).
    PERFORM public.readiness_lifecycle_reactivate_member('00000000-0000-0000-0000-000000910001',
              '00000000-0000-0000-0000-0000009100b0','user');
    RAISE EXCEPTION 'R3_NO_ABORT';
  EXCEPTION WHEN others THEN
    IF SQLERRM LIKE '%R3_NO_ABORT%' THEN RAISE EXCEPTION '091 FAIL: R3 reactivate claimed an attached member'; END IF;
  END;
END $r$ LANGUAGE plpgsql;
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TA', 'R3: reactivate cannot claim an attached member (still in TA)');

-- R4: reactivation of a genuinely DETACHED (removed) member succeeds.
SELECT public.readiness_lifecycle_remove_member(:'u1');   -- as adm → detached/inactive
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1') IS NULL, 'R4-pre: member detached after remove');
SELECT public.readiness_lifecycle_reactivate_member(:'u1', :'TB', 'user');
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TB' AND (SELECT status FROM public.profiles WHERE id=:'u1')='active', 'R4: detached member reactivated into TB');
SELECT public.readiness_lifecycle_transfer_member(:'u1', :'TA', 'user');   -- move back for tidiness
SELECT set_config('request.jwt.claims', NULL, true);

-- R5 (#6): direct authenticated INSERT on profiles is denied; creation is only via ensure_self_profile.
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.profiles','INSERT'), 'R5: authenticated has NO direct INSERT on profiles');

-- ══ SEC. security metadata + static "no advisory-holder writes the queue" ══
SELECT pg_temp.ok((SELECT bool_and(prosecdef AND pg_get_userbyid(proowner)='postgres' AND array_to_string(proconfig,',')='search_path=""')
  FROM pg_proc WHERE proname IN ('readiness_is_scorable_rep','enqueue_readiness_recalc','readiness_begin_lifecycle_write',
     'readiness_lifecycle_apply','readiness_reconcile_cleanup','ensure_self_profile','accept_invitation','delete_tenant',
     'readiness_scores_current_write_guard')), 'SEC1: 091 fns SECDEF, owner postgres, empty search_path');
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.readiness_lifecycle_remove_member(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.delete_tenant(uuid)','EXECUTE')
  AND NOT has_function_privilege('anon','public.accept_invitation(text,text)','EXECUTE'), 'SEC2: anon cannot execute lifecycle/admin RPCs');
-- STATIC INVARIANT: every function that takes the READINESS lifecycle advisory (references
-- readiness_lock_key — i.e. begin_lifecycle_write / write-guard / reconcile_cleanup) must NOT write the
-- queue. (readiness_v2_activate uses a SEPARATE activation advisory, not readiness_lock_key, and may
-- enqueue; the 088 worker holds the readiness advisory only via the write-guard and writes solely the
-- queue rows it already claimed via FOR UPDATE SKIP LOCKED — neither participates in a readiness cycle.)
SELECT pg_temp.ok((
  SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.prokind='f'
     AND pg_get_functiondef(p.oid) ~* 'readiness_lock_key'
     AND pg_get_functiondef(p.oid) ~* '(enqueue_readiness_recalc|INSERT\s+INTO\s+public\.readiness_recalc_queue|UPDATE\s+public\.readiness_recalc_queue)'
  )=0, 'SEC3: no readiness-advisory-holding function writes the queue');

SELECT '091 ALL TESTS PASSED' AS result;
ROLLBACK;
