-- Repeatable behavioral tests for migration 093 (durable tenant-membership record / Deactivated Users).
-- Assumes 091 + 093 applied (092 optional). One rolled-back transaction. Local only. Expect "093 ALL TESTS PASSED".
-- Covers: strengthened constraints (#3); previous-role freeze at removal (#4); atomic record write under the
-- lifecycle lock — a failed op leaves no membership change (#5); tenant-scoped reader authz, orgAdmins never
-- see other tenants / transferred rows (#3,#6); reactivate flips active; transfer excluded; backfill logic
-- (active only, never detached); accept_invitation cross-tenant hardening (#8/#9); grants/RLS.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL readiness.allow_unguarded = '1';   -- lets fixture/guard pass if 092 is also applied (current_user=postgres)

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION '093 FAIL: %', label; END IF; END $$;

-- Assert an arbitrary statement RAISES (negative test). Any error = pass; no error = fail.
CREATE FUNCTION pg_temp.expect_fail(p_sql text, p_label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN RETURN; END;
  RAISE EXCEPTION '093 FAIL: % (expected an error, none was raised)', p_label;
END $$;

CREATE FUNCTION pg_temp.tm(p_tenant uuid, p_user uuid)
  RETURNS TABLE(state text, end_reason text, role_at_membership text, removed_at timestamptz, removed_by uuid)
  LANGUAGE sql AS $$
  SELECT state, end_reason, role_at_membership, removed_at, removed_by
    FROM public.tenant_memberships WHERE tenant_id=p_tenant AND user_id=p_user; $$;
CREATE FUNCTION pg_temp.tm_exists(p_tenant uuid, p_user uuid) RETURNS boolean LANGUAGE sql AS $$
  SELECT EXISTS(SELECT 1 FROM public.tenant_memberships WHERE tenant_id=p_tenant AND user_id=p_user); $$;
CREATE FUNCTION pg_temp.reader_cnt(p_tenant uuid, p_user uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.readiness_list_deactivated_members(p_tenant) r WHERE r.user_id=p_user; $$;

-- ── fixtures ──
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-000000930001','authenticated','authenticated','u1@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930002','authenticated','authenticated','u2@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930003','authenticated','authenticated','u3@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930004','authenticated','authenticated','u4@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930005','authenticated','authenticated','u5@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930006','authenticated','authenticated','u6@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930011','authenticated','authenticated','mgra@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930012','authenticated','authenticated','mgrb@t93.test',now(),now()),
 ('00000000-0000-0000-0000-000000930013','authenticated','authenticated','adm@t93.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES
 ('00000000-0000-0000-0000-0000009300a0','ta93','TA93'),('00000000-0000-0000-0000-0000009300b0','tb93','TB93');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES
 ('00000000-0000-0000-0000-0000009300a0','{}'),('00000000-0000-0000-0000-0000009300b0','{}');

UPDATE public.profiles SET role='user',tenant_id='00000000-0000-0000-0000-0000009300a0',status='active' WHERE id IN
 ('00000000-0000-0000-0000-000000930001','00000000-0000-0000-0000-000000930002',
  '00000000-0000-0000-0000-000000930004','00000000-0000-0000-0000-000000930006');
-- u3,u5 detached (simulate prior removal state — tenant NULL, inactive). No membership rows (not backfilled).
UPDATE public.profiles SET role='user',tenant_id=NULL,status='inactive' WHERE id IN
 ('00000000-0000-0000-0000-000000930003','00000000-0000-0000-0000-000000930005');
UPDATE public.profiles SET role='orgAdmin',tenant_id='00000000-0000-0000-0000-0000009300a0',status='active' WHERE id='00000000-0000-0000-0000-000000930011';
UPDATE public.profiles SET role='orgAdmin',tenant_id='00000000-0000-0000-0000-0000009300b0',status='active' WHERE id='00000000-0000-0000-0000-000000930012';
UPDATE public.profiles SET role='ralli_admin',tenant_id=NULL,status='active' WHERE id='00000000-0000-0000-0000-000000930013';

-- active membership rows as backfill would have created (u1,u2,u6 in TA). u4 intentionally has NONE (backfill test).
INSERT INTO public.tenant_memberships(tenant_id,user_id,state,role_at_membership) VALUES
 ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930001','active','user'),
 ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930002','active','user'),
 ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930006','active','user');

-- invitation to TB (used by the accept_invitation hardening tests)
INSERT INTO public.tenant_invitations(id,tenant_id,admin_email,token,status,onboarding_state,expires_at,role) VALUES
 ('00000000-0000-0000-0000-0000009300e1','00000000-0000-0000-0000-0000009300b0','u3@t93.test','tok93tb','pending','{"stepsCompleted":[]}'::jsonb, now()+interval '1 day','user'),
 ('00000000-0000-0000-0000-0000009300e2','00000000-0000-0000-0000-0000009300b0','u6@t93.test','tok93tb2','pending','{"stepsCompleted":[]}'::jsonb, now()+interval '1 day','user');

\set TA '00000000-0000-0000-0000-0000009300a0'
\set TB '00000000-0000-0000-0000-0000009300b0'
\set u1 '00000000-0000-0000-0000-000000930001'
\set u2 '00000000-0000-0000-0000-000000930002'
\set u3 '00000000-0000-0000-0000-000000930003'
\set u4 '00000000-0000-0000-0000-000000930004'
\set u5 '00000000-0000-0000-0000-000000930005'
\set u6 '00000000-0000-0000-0000-000000930006'
\set mgrA '00000000-0000-0000-0000-000000930011'
\set mgrB '00000000-0000-0000-0000-000000930012'
\set adm '00000000-0000-0000-0000-000000930013'

-- ══ §1. STRENGTHENED CONSTRAINTS (#3) ══
-- active row must clear end_reason/removed_at/removed_by
SELECT pg_temp.expect_fail($$INSERT INTO public.tenant_memberships(tenant_id,user_id,state,role_at_membership,removed_at)
  VALUES ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930004','active','user',now())$$,
  'C1: active row with removed_at rejected');
SELECT pg_temp.expect_fail($$INSERT INTO public.tenant_memberships(tenant_id,user_id,state,end_reason,role_at_membership)
  VALUES ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930004','active','removed','user')$$,
  'C2: active row with end_reason rejected');
-- removed row must have removed_at
SELECT pg_temp.expect_fail($$INSERT INTO public.tenant_memberships(tenant_id,user_id,state,end_reason,role_at_membership)
  VALUES ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930004','ended','removed','user')$$,
  'C3: removed row without removed_at rejected');
-- transferred row must NOT have removed_at/removed_by
SELECT pg_temp.expect_fail($$INSERT INTO public.tenant_memberships(tenant_id,user_id,state,end_reason,role_at_membership,removed_at)
  VALUES ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930004','ended','transferred','user',now())$$,
  'C4: transferred row with removed_at rejected');
-- ended row must carry a reason
SELECT pg_temp.expect_fail($$INSERT INTO public.tenant_memberships(tenant_id,user_id,state,role_at_membership)
  VALUES ('00000000-0000-0000-0000-0000009300a0','00000000-0000-0000-0000-000000930004','ended','user')$$,
  'C5: ended row without reason rejected');

-- ══ §2. REMOVE records with FROZEN previous role (#4) ══
SELECT set_config('request.jwt.claims', json_build_object('sub',:'mgrA')::text, true);
SELECT public.readiness_lifecycle_change_role(:'u1','manager');   -- previous role becomes manager
SELECT public.readiness_lifecycle_remove_member(:'u1');
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TA',:'u1'))='ended',                 'R1: u1 membership ended');
SELECT pg_temp.ok((SELECT end_reason FROM pg_temp.tm(:'TA',:'u1'))='removed',          'R2: reason=removed');
SELECT pg_temp.ok((SELECT role_at_membership FROM pg_temp.tm(:'TA',:'u1'))='manager',  'R3: previous role frozen = manager (#4)');
SELECT pg_temp.ok((SELECT removed_at FROM pg_temp.tm(:'TA',:'u1')) IS NOT NULL,        'R4: removed_at set');
SELECT pg_temp.ok((SELECT removed_by FROM pg_temp.tm(:'TA',:'u1'))=:'mgrA',            'R5: removed_by = actor');
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u1') IS NULL,      'R6: profile detached');
SELECT pg_temp.ok((SELECT role FROM public.profiles WHERE id=:'u1')='user',            'R7: profile role reset to user');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §3. READER RPC tenant-scoping (#6) + never leaks other tenants / transferred (#3) ══
SELECT set_config('request.jwt.claims', json_build_object('sub',:'mgrA')::text, true);
SELECT pg_temp.ok(pg_temp.reader_cnt(:'TA',:'u1')=1, 'D1: orgAdmin of TA sees u1 in TA deactivated list');
SELECT set_config('request.jwt.claims', json_build_object('sub',:'mgrB')::text, true);
SELECT pg_temp.expect_fail($$SELECT public.readiness_list_deactivated_members('00000000-0000-0000-0000-0000009300a0')$$,
  'D2: orgAdmin of TB CANNOT read TA deactivated list (cross-tenant denied)');
SELECT pg_temp.ok((SELECT count(*) FROM public.readiness_list_deactivated_members(NULL))=0, 'D3: orgAdmin of TB sees none in own tenant');
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);   -- ralli_admin
SELECT pg_temp.ok(pg_temp.reader_cnt(:'TA',:'u1')=1, 'D4: ralli admin may read any tenant');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §4. REACTIVATE flips active + clears removal fields; leaves the deactivated list ══
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);
SELECT public.readiness_lifecycle_reactivate_member(:'u1',:'TA','user');
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TA',:'u1'))='active',              'RA1: membership active again');
SELECT pg_temp.ok((SELECT end_reason FROM pg_temp.tm(:'TA',:'u1')) IS NULL
                  AND (SELECT removed_at FROM pg_temp.tm(:'TA',:'u1')) IS NULL
                  AND (SELECT removed_by FROM pg_temp.tm(:'TA',:'u1')) IS NULL,       'RA2: removal fields cleared');
SELECT pg_temp.ok(pg_temp.reader_cnt(:'TA',:'u1')=0,                                  'RA3: u1 no longer in deactivated list');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §5. TRANSFER ends OLD as transferred (EXCLUDED from list), opens NEW active ══
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);   -- transfer = ralli only
SELECT public.readiness_lifecycle_transfer_member(:'u2',:'TB','user');
SELECT pg_temp.ok((SELECT end_reason FROM pg_temp.tm(:'TA',:'u2'))='transferred',      'T1: old membership ended=transferred');
SELECT pg_temp.ok((SELECT removed_at FROM pg_temp.tm(:'TA',:'u2')) IS NULL,            'T2: transferred row has NO removed_at (#3)');
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TB',:'u2'))='active',                'T3: new membership active in TB');
SELECT set_config('request.jwt.claims', json_build_object('sub',:'mgrA')::text, true);
SELECT pg_temp.ok(pg_temp.reader_cnt(:'TA',:'u2')=0,                                   'T4: transferred user NOT in TA deactivated list (#3)');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §6. ATOMICITY: a FAILED lifecycle op leaves NO membership change (#5) ══
-- reactivate requires a DETACHED (inactive/invited) profile; u1 is active/attached → apply aborts 40001.
SELECT set_config('request.jwt.claims', json_build_object('sub',:'adm')::text, true);
SELECT pg_temp.expect_fail($$SELECT public.readiness_lifecycle_reactivate_member(
  '00000000-0000-0000-0000-000000930001','00000000-0000-0000-0000-0000009300b0','user')$$,
  'AT1: reactivate of an attached member fails (40001)');
SELECT pg_temp.ok(NOT pg_temp.tm_exists(:'TB',:'u1'),                                  'AT2: NO stray TB membership row created for u1');
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TA',:'u1'))='active'
                  AND (SELECT tenant_id FROM public.profiles WHERE id=:'u1')=:'TA',    'AT3: u1 TA membership + profile unchanged');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §7. accept_invitation HARDENING — no cross-tenant transfer via acceptance (#8/#9) ══
-- (a) existing ACTIVE member of TA accepting a TB invitation → REJECTED; nothing moves.
SELECT set_config('request.jwt.claims', json_build_object('sub',:'u6')::text, true);
SELECT pg_temp.expect_fail($$SELECT public.accept_invitation('tok93tb2', NULL)$$,
  'IX1: active member of TA cannot use TB invitation as a cross-tenant transfer (#9)');
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u6')=:'TA',        'IX2: u6 still in TA');
SELECT pg_temp.ok(NOT pg_temp.tm_exists(:'TB',:'u6'),                                  'IX3: no TB membership created for u6');
SELECT pg_temp.ok((SELECT status FROM public.tenant_invitations WHERE token='tok93tb2')='pending', 'IX4: invitation still pending');
-- (b) a DETACHED user accepting the TB invitation → ATTACHED (legitimate onboarding), membership active.
SELECT set_config('request.jwt.claims', json_build_object('sub',:'u3')::text, true);
SELECT public.accept_invitation('tok93tb', NULL);
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'u3')=:'TB',        'IX5: detached u3 attached to TB via acceptance');
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TB',:'u3'))='active',                'IX6: u3 active TB membership recorded');
SELECT set_config('request.jwt.claims', NULL, true);

-- ══ §8. BACKFILL logic — ACTIVE only, never detached (#2) ══
-- u4 is active in TA with NO membership row; u5 is detached. Run the exact backfill statement.
INSERT INTO public.tenant_memberships
  (tenant_id, user_id, state, end_reason, role_at_membership, joined_at, removed_at, removed_by, created_at, updated_at)
SELECT p.tenant_id, p.id, 'active', NULL, p.role, p.created_at, NULL, NULL, now(), now()
  FROM public.profiles p
 WHERE p.tenant_id IS NOT NULL AND p.role IN ('user','manager','orgAdmin')
ON CONFLICT (tenant_id, user_id) DO NOTHING;
SELECT pg_temp.ok((SELECT state FROM pg_temp.tm(:'TA',:'u4'))='active',                'BF1: active member u4 backfilled');
SELECT pg_temp.ok(NOT pg_temp.tm_exists(:'TA',:'u5') AND NOT pg_temp.tm_exists(:'TB',:'u5'), 'BF2: detached u5 NOT backfilled (no fabricated tenant)');

-- ══ §9. GRANTS / RLS ══
SELECT pg_temp.ok(NOT has_function_privilege('anon','public.readiness_list_deactivated_members(uuid)','EXECUTE'), 'G1: anon cannot execute reader');
SELECT pg_temp.ok(NOT has_table_privilege('authenticated','public.tenant_memberships','INSERT')
              AND NOT has_table_privilege('authenticated','public.tenant_memberships','UPDATE')
              AND NOT has_table_privilege('authenticated','public.tenant_memberships','DELETE'), 'G2: authenticated has no membership DML');
SELECT pg_temp.ok(has_table_privilege('authenticated','public.tenant_memberships','SELECT'), 'G3: authenticated may SELECT (RLS-gated)');
SELECT pg_temp.ok(NOT has_function_privilege('authenticated','public.readiness_membership_end(uuid,uuid,text,text,uuid)','EXECUTE')
              AND NOT has_function_privilege('authenticated','public.readiness_membership_activate(uuid,uuid,text)','EXECUTE'),
              'G4: record helpers are internal (not client-executable)');
SELECT pg_temp.ok(EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.tenant_memberships'::regclass AND polname='tm_select'), 'G5: tenant-scoped RLS policy present');

SELECT '093 ALL TESTS PASSED' AS result;
ROLLBACK;
