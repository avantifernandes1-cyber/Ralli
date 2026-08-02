-- Tests for migration 074 (revoke anon EXECUTE from review/history RPCs).
-- Run against a local DB with migrations through 074 applied. Read-only checks +
-- a behavioral anon-denied probe in a rolled-back transaction.
-- Expect "074 ALL TESTS PASSED".
\set ON_ERROR_STOP on

DO $$
BEGIN
  -- 1. anon lacks EXECUTE at the GRANT level on both RPCs.
  IF has_function_privilege('anon','public.rpc_my_completed_session_review(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'T1 FAIL: anon still has EXECUTE on rpc_my_completed_session_review'; END IF;
  IF has_function_privilege('anon','public.rpc_list_my_game_history(integer)','EXECUTE')
    THEN RAISE EXCEPTION 'T1 FAIL: anon still has EXECUTE on rpc_list_my_game_history'; END IF;
  RAISE NOTICE '1. anon lacks EXECUTE (grant-level) on review + history: PASS';

  -- 2. authenticated + service_role EXECUTE preserved on all three RPCs.
  IF NOT has_function_privilege('authenticated','public.rpc_my_completed_session_review(uuid)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.rpc_list_my_game_history(integer)','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.rpc_player_session_restore(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'T2 FAIL: authenticated EXECUTE not preserved'; END IF;
  IF NOT has_function_privilege('service_role','public.rpc_list_my_game_history(integer)','EXECUTE')
    THEN RAISE EXCEPTION 'T2 FAIL: service_role EXECUTE not preserved'; END IF;
  -- restore was already anon-revoked in 073 and stays so.
  IF has_function_privilege('anon','public.rpc_player_session_restore(uuid)','EXECUTE')
    THEN RAISE EXCEPTION 'T2 FAIL: restore anon grant regressed'; END IF;
  RAISE NOTICE '2. authenticated + service_role EXECUTE preserved; restore stays anon-revoked: PASS';

  -- 3. No table grants or RLS policies changed by 074.
  IF NOT has_table_privilege('authenticated','public.game_sessions','SELECT')
    THEN RAISE EXCEPTION 'T3 FAIL: authenticated SELECT on game_sessions was altered'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE tablename='game_sessions') <> 6
     OR (SELECT count(*) FROM pg_policies WHERE tablename='game_answers') <> 2
    THEN RAISE EXCEPTION 'T3 FAIL: game_sessions/game_answers RLS policy set changed'; END IF;
  RAISE NOTICE '3. no table grants or RLS policies changed: PASS';
END $$;

-- 4. Behavioral: anon calling review/history is denied at the grant level now
--    (permission denied), and authenticated still works. Rolled back — no data.
BEGIN;
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000074a1','authenticated','authenticated','r74_a1@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000074a0','r74_ta','R74');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000074a0', status='active' WHERE id='00000000-0000-0000-0000-0000000074a1';
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-000000074f01','00000000-0000-0000-0000-0000000074a0','q','00000000-0000-0000-0000-0000000074a1','740901','R','completed',1,false,now(),'[{"id":"qa","type":"mc","correct":1}]'::jsonb);
INSERT INTO public.game_answers (session_id, tenant_id, player_id, question_idx, option_idx, is_correct, points)
 VALUES ('00000000-0000-0000-0000-000000074f01','00000000-0000-0000-0000-0000000074a0','00000000-0000-0000-0000-0000000074a1',0,1,true,100);
DO $$
DECLARE v jsonb; v_b bool;
BEGIN
  -- anon → permission denied (grant-level) now
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  BEGIN v := public.rpc_my_completed_session_review('00000000-0000-0000-0000-000000074f01'); v_b:=true; EXCEPTION WHEN OTHERS THEN v_b:=false; END;
  IF v_b THEN RAISE EXCEPTION 'T4 FAIL: anon review not denied'; END IF;
  BEGIN v := public.rpc_list_my_game_history(20); v_b:=true; EXCEPTION WHEN OTHERS THEN v_b:=false; END;
  IF v_b THEN RAISE EXCEPTION 'T4 FAIL: anon history not denied'; END IF;
  RESET ROLE;
  -- authenticated participant still works
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000074a1","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_my_completed_session_review('00000000-0000-0000-0000-000000074f01');
  IF jsonb_typeof(v->'snapshot') <> 'array' THEN RAISE EXCEPTION 'T4 FAIL: authenticated review broke'; END IF;
  RESET ROLE;
  RAISE NOTICE '4. anon behaviorally denied (permission denied); authenticated works: PASS';
  RAISE NOTICE '074 ALL TESTS PASSED';
END $$;
ROLLBACK;
