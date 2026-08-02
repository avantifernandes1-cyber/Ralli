-- Real-JWT test for migration 076 (lock down the internal authz helper).
-- Runs against a DB with migration 075 ALREADY APPLIED (the seven functions exist).
-- SELF-CONTAINED: applies the 076 REVOKE inside a transaction, seeds ephemeral
-- identities/sessions, proves the helper is now owner-only while the six SECURITY
-- DEFINER RPCs still work (they call the helper as owner) and their grants are
-- unchanged, then ROLLS BACK — the REVOKE and all seed data are undone (076 stays
-- unapplied; the helper's pre-076 grants are restored). Expect "076 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- The 076 correction (verbatim from supabase/migrations/076_...):
REVOKE EXECUTE ON FUNCTION public.ralli_can_manage_session(text, text) FROM authenticated, service_role, PUBLIC, anon;

-- Ephemeral fixtures (reserved 0762xxxx id space).
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000762a0','r76_ta','R76 A'),
 ('00000000-0000-0000-0000-0000000762b0','r76_tb','R76 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000076201','authenticated','authenticated','r76mgr@t.test',now(),now()),   -- MG manager (tA)
 ('00000000-0000-0000-0000-000000076202','authenticated','authenticated','r76oa@t.test',now(),now()),    -- OA orgAdmin (tA)
 ('00000000-0000-0000-0000-000000076203','authenticated','authenticated','r76ra@t.test',now(),now()),    -- RA ralli_admin
 ('00000000-0000-0000-0000-000000076204','authenticated','authenticated','r76learn@t.test',now(),now()), -- LN ordinary learner (tA)
 ('00000000-0000-0000-0000-000000076205','authenticated','authenticated','r76xmgr@t.test',now(),now()),  -- XM cross-tenant manager (tB)
 ('00000000-0000-0000-0000-000000076206','authenticated','authenticated','r76host@t.test',now(),now());  -- UH exact host, role=user (tA)
UPDATE public.profiles SET role='manager',     tenant_id='00000000-0000-0000-0000-0000000762a0', status='active' WHERE id='00000000-0000-0000-0000-000000076201';
UPDATE public.profiles SET role='orgAdmin',    tenant_id='00000000-0000-0000-0000-0000000762a0', status='active' WHERE id='00000000-0000-0000-0000-000000076202';
UPDATE public.profiles SET role='ralli_admin', tenant_id=NULL,                                    status='active' WHERE id='00000000-0000-0000-0000-000000076203';
UPDATE public.profiles SET role='user',        tenant_id='00000000-0000-0000-0000-0000000762a0', status='active' WHERE id='00000000-0000-0000-0000-000000076204';
UPDATE public.profiles SET role='manager',     tenant_id='00000000-0000-0000-0000-0000000762b0', status='active' WHERE id='00000000-0000-0000-0000-000000076205';
UPDATE public.profiles SET role='user',        tenant_id='00000000-0000-0000-0000-0000000762a0', status='active' WHERE id='00000000-0000-0000-0000-000000076206';
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000000762f1','00000000-0000-0000-0000-0000000762a0','q','00000000-0000-0000-0000-000000076206','762001','SH','started',1,false,'[{"id":"q"}]'::jsonb);
INSERT INTO public.game_session_participants (session_id, tenant_id, player_id, name, status) VALUES
 ('00000000-0000-0000-0000-0000000762f1','00000000-0000-0000-0000-0000000762a0','00000000-0000-0000-0000-000000076204','LN','joined');

DO $$
DECLARE ok boolean; v jsonb; SH uuid := '00000000-0000-0000-0000-0000000762f1'; tA uuid := '00000000-0000-0000-0000-0000000762a0';
  HELP text := 'public.ralli_can_manage_session(text,text)';
BEGIN
  -- 1. helper is NOT directly executable by any client role (grant-level).
  IF has_function_privilege('authenticated', HELP, 'EXECUTE') THEN RAISE EXCEPTION 'T1 authenticated still has helper EXECUTE'; END IF;
  IF has_function_privilege('service_role',  HELP, 'EXECUTE') THEN RAISE EXCEPTION 'T1 service_role still has helper EXECUTE'; END IF;
  IF has_function_privilege('anon',          HELP, 'EXECUTE') THEN RAISE EXCEPTION 'T1 anon still has helper EXECUTE'; END IF;
  IF has_function_privilege('public',        HELP, 'EXECUTE') THEN RAISE EXCEPTION 'T1 PUBLIC still has helper EXECUTE'; END IF;
  RAISE NOTICE '1. helper not client-executable (authenticated/service_role/anon/PUBLIC): PASS';

  -- 2. owner (postgres) retains EXECUTE — proacl is exactly {postgres=X/postgres}.
  IF NOT has_function_privilege('postgres', HELP, 'EXECUTE') THEN RAISE EXCEPTION 'T2 owner lost helper EXECUTE'; END IF;
  RAISE NOTICE '2. function owner retains EXECUTE: PASS';

  -- 3. the six SECURITY DEFINER RPCs STILL work (they call the helper as owner):
  --    exact host (role=user), same-tenant manager, same-tenant orgAdmin, ralli_admin allowed.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076206","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_host_session_restore(SH)->'session'->>'id') <> SH::text THEN RAISE EXCEPTION 'T3 exact-host RPC broke after helper revoke'; END IF;
  IF jsonb_array_length(public.rpc_lobby_participants(SH)) < 0 THEN RAISE EXCEPTION 'T3 host lobby'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076201","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_host_session_restore(SH)->'session'->>'id') <> SH::text THEN RAISE EXCEPTION 'T3 manager restore'; END IF;
  IF jsonb_typeof(public.rpc_manager_session_analytics(SH)->'snapshot') <> 'array' THEN RAISE EXCEPTION 'T3 manager analytics'; END IF;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.rpc_manager_active_sessions(tA)) e WHERE e->>'id'=SH::text) THEN RAISE EXCEPTION 'T3 manager active'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076202","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_host_session_restore(SH)->'session'->>'id') <> SH::text THEN RAISE EXCEPTION 'T3 orgAdmin restore'; END IF; RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076203","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_host_session_restore(SH)->'session'->>'id') <> SH::text THEN RAISE EXCEPTION 'T3 ralli_admin restore'; END IF; RESET ROLE;
  RAISE NOTICE '3. RPCs still succeed for host/manager/orgAdmin/ralli_admin (helper reached as owner): PASS';

  -- 4. denials preserved: ordinary learner + cross-tenant manager + anon still denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076204","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v:=public.rpc_host_session_restore(SH); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T4 learner not denied'; END IF; RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000076205","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v:=public.rpc_manager_session_analytics(SH); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T4 cross-tenant manager not denied'; END IF; RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  BEGIN v:=public.rpc_host_session_restore(SH); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T4 anon not denied'; END IF; RESET ROLE;
  RAISE NOTICE '4. learner / cross-tenant manager / anon remain denied: PASS';

  -- 5. the six RPC grants are UNCHANGED by 076 (authenticated + service_role EXECUTE; anon none).
  IF NOT (has_function_privilege('authenticated','public.rpc_host_session_restore(uuid)','EXECUTE')
      AND has_function_privilege('authenticated','public.rpc_manager_active_sessions(uuid)','EXECUTE')
      AND has_function_privilege('authenticated','public.rpc_manager_session_history(uuid,integer)','EXECUTE')
      AND has_function_privilege('authenticated','public.rpc_manager_session_analytics(uuid)','EXECUTE')
      AND has_function_privilege('authenticated','public.rpc_session_player_counts(uuid[])','EXECUTE')
      AND has_function_privilege('authenticated','public.rpc_lobby_participants(uuid)','EXECUTE'))
    THEN RAISE EXCEPTION 'T5 an RPC lost authenticated EXECUTE'; END IF;
  IF    has_function_privilege('anon','public.rpc_host_session_restore(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.rpc_manager_session_analytics(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.rpc_lobby_participants(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'T5 an RPC gained anon EXECUTE'; END IF;
  RAISE NOTICE '5. six RPC grants unchanged (authenticated yes / anon no): PASS';

  RAISE NOTICE '076 ALL TESTS PASSED';
END $$;

ROLLBACK;
