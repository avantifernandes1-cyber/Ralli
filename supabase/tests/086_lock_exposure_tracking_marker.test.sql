-- Repeatable tests for migration 086 (server-authoritative exposure_fully_tracked marker).
-- Runs against a local DB migrated through 086 (prelude + 085 + game_sessions RLS/policies + 086).
-- Uses REAL role contexts (SET LOCAL ROLE authenticated/anon/service_role + request.jwt.claims),
-- not source scans. Proves: without the guard a client write succeeds (vuln); with the guard, direct
-- learner/manager/orgAdmin/cross-tenant/anon marker writes are denied, mixed-field bypass is denied,
-- true→false reset is denied, unchanged-marker updates still work, the authoritative q0 RPC still sets
-- the marker, q2+ never sets it, and service_role/postgres retain controlled write. One rolled-back
-- transaction, no residual rows. Expect "086 ALL TESTS PASSED".
\set ON_ERROR_STOP on
-- Mirror production: service_role bypasses RLS (Supabase grants it BYPASSRLS). Harmless if already set.
-- (Local test roles created by the prelude do not have it by default.) Must run outside the txn.
ALTER ROLE service_role BYPASSRLS;
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
INSERT INTO public.tenants(id,name) VALUES
 ('00000000-0000-0000-0000-0000000860a0','TA'),
 ('00000000-0000-0000-0000-0000000860b0','TB') ON CONFLICT DO NOTHING;
INSERT INTO auth.users(id,aud,role,email) VALUES
 ('00000000-0000-0000-0000-000000086001','authenticated','authenticated','l1'),
 ('00000000-0000-0000-0000-0000000860f1','authenticated','authenticated','h1'),
 ('00000000-0000-0000-0000-0000000860f2','authenticated','authenticated','mg'),
 ('00000000-0000-0000-0000-0000000860b1','authenticated','authenticated','b1');
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000860a0',name='L1' WHERE id='00000000-0000-0000-0000-000000086001';
UPDATE public.profiles SET role='orgAdmin',status='active',tenant_id='00000000-0000-0000-0000-0000000860a0',name='H1' WHERE id='00000000-0000-0000-0000-0000000860f1';
UPDATE public.profiles SET role='manager',status='active',tenant_id='00000000-0000-0000-0000-0000000860a0',name='MG' WHERE id='00000000-0000-0000-0000-0000000860f2';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000860b0',name='B1' WHERE id='00000000-0000-0000-0000-0000000860b1';

-- Mirror the PRODUCTION game_sessions client-write posture: RLS on + permissive same-tenant
-- authenticated UPDATE/SELECT/INSERT policies (the pre-existing path 086 must neutralize for the marker).
ALTER TABLE public.game_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_update_game_sessions ON public.game_sessions;
DROP POLICY IF EXISTS auth_select_game_sessions ON public.game_sessions;
DROP POLICY IF EXISTS auth_insert_game_sessions ON public.game_sessions;
CREATE POLICY auth_update_game_sessions ON public.game_sessions FOR UPDATE TO authenticated USING (tenant_id = (public.get_my_tenant_id())::text);
CREATE POLICY auth_select_game_sessions ON public.game_sessions FOR SELECT TO authenticated USING (tenant_id = (public.get_my_tenant_id())::text OR tenant_id IS NULL);
CREATE POLICY auth_insert_game_sessions ON public.game_sessions FOR INSERT TO authenticated WITH CHECK (tenant_id = (public.get_my_tenant_id())::text OR tenant_id IS NULL);

\set snap '[{"id":"q0","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q1","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q2","type":"mc","options":["a","b"],"timeLimit":20}]'
-- A completed real session in TA, marker currently false (the ranking-admission target).
INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,demo_mode,question_count,question_snapshot,ended_at,current_question_index,phase)
  VALUES ('00000000-0000-0000-0000-0000008600d1','00000000-0000-0000-0000-0000000860a0','q','00000000-0000-0000-0000-0000000860f1','pd1','completed',false,3, :'snap'::jsonb, now(),2,'scoreboard');
-- Two STARTED sessions in TA for the authoritative q0 / q2 RPC tests.
INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,demo_mode,question_count,question_snapshot,current_question_index,phase)
  VALUES ('00000000-0000-0000-0000-0000008600e1','00000000-0000-0000-0000-0000000860a0','q','00000000-0000-0000-0000-0000000860f1','pe1','started',false,3, :'snap'::jsonb,0,'countdown'),
         ('00000000-0000-0000-0000-0000008600e2','00000000-0000-0000-0000-0000000860a0','q','00000000-0000-0000-0000-0000000860f1','pe2','started',false,3, :'snap'::jsonb,0,'countdown');

DO $$
DECLARE ok boolean; v_rows int; v_marker boolean; v_name text;
  l1 text := '00000000-0000-0000-0000-000000086001';
  h1 text := '00000000-0000-0000-0000-0000000860f1';
  mg text := '00000000-0000-0000-0000-0000000860f2';
  b1 text := '00000000-0000-0000-0000-0000000860b1';
  s_done uuid := '00000000-0000-0000-0000-0000008600d1';
  s_e1   uuid := '00000000-0000-0000-0000-0000008600e1';
  s_e2   uuid := '00000000-0000-0000-0000-0000008600e2';
BEGIN
  -- 1. PRE-GUARD VULN: with the guard trigger disabled, a same-tenant authenticated client CAN flip
  --    the marker → proves the direct-write path exists and the guard is what closes it.
  ALTER TABLE public.game_sessions DISABLE TRIGGER trg_guard_exposure_marker;
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  SELECT exposure_fully_tracked INTO v_marker FROM public.game_sessions WHERE id = s_done;
  IF v_rows <> 1 OR v_marker <> true THEN RAISE EXCEPTION '1 FAIL pre-guard vuln did not reproduce (rows=% marker=%)', v_rows, v_marker; END IF;
  UPDATE public.game_sessions SET exposure_fully_tracked = false WHERE id = s_done;   -- reset for post-guard tests
  ALTER TABLE public.game_sessions ENABLE TRIGGER trg_guard_exposure_marker;
  RAISE NOTICE '1. pre-guard: same-tenant authenticated direct marker write SUCCEEDS with guard disabled (vuln reproduced): PASS';

  -- 2. learner direct false→true DENIED
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done; ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION '2 FAIL learner set marker'; END IF;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_done) <> false THEN RAISE EXCEPTION '2 FAIL marker changed'; END IF;
  RAISE NOTICE '2. learner direct marker write DENIED: PASS';

  -- 3. manager DENIED
  PERFORM set_config('request.jwt.claims', json_build_object('sub',mg,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done; ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE; IF ok THEN RAISE EXCEPTION '3 FAIL manager set marker'; END IF;
  -- 4. orgAdmin DENIED
  PERFORM set_config('request.jwt.claims', json_build_object('sub',h1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done; ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE; IF ok THEN RAISE EXCEPTION '4 FAIL orgAdmin set marker'; END IF;
  RAISE NOTICE '3-4. manager + orgAdmin direct marker write DENIED: PASS';

  -- 5. cross-tenant DENIED (RLS makes the row invisible → 0 rows; marker unchanged)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',b1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  IF v_rows <> 0 OR (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_done) <> false THEN RAISE EXCEPTION '5 FAIL cross-tenant changed marker (rows=%)', v_rows; END IF;
  RAISE NOTICE '5. cross-tenant marker write blocked (0 rows, unchanged): PASS';

  -- 6. anonymous DENIED (no same-tenant visibility/grant; marker unchanged)
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  ok:=true; BEGIN UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_done; GET DIAGNOSTICS v_rows = ROW_COUNT; EXCEPTION WHEN insufficient_privilege OR others THEN v_rows := 0; END;
  RESET ROLE;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_done) <> false THEN RAISE EXCEPTION '6 FAIL anon changed marker'; END IF;
  RAISE NOTICE '6. anonymous marker write blocked: PASS';

  -- 7. mixed-field bypass DENIED (marker changed alongside another allowed field)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN UPDATE public.game_sessions SET name='hacked', exposure_fully_tracked = true WHERE id = s_done; ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION '7 FAIL mixed-field bypass allowed'; END IF;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_done) <> false THEN RAISE EXCEPTION '7 FAIL marker changed via mixed-field'; END IF;
  RAISE NOTICE '7. mixed-field bypass (name + marker) DENIED, no partial write: PASS';

  -- 8. unchanged-marker legitimate update ALLOWED (other fields still updatable directly)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  UPDATE public.game_sessions SET name='renamed-ok' WHERE id = s_done;  -- marker untouched
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RESET ROLE;
  SELECT name INTO v_name FROM public.game_sessions WHERE id=s_done;
  IF v_rows <> 1 OR v_name <> 'renamed-ok' THEN RAISE EXCEPTION '8 FAIL legitimate unchanged-marker update blocked'; END IF;
  RAISE NOTICE '8. unchanged-marker legitimate client update ALLOWED: PASS';

  -- 9. authoritative Q1 (idx 0) RPC sets the marker (guard allows the SECURITY DEFINER path)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',h1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase(s_e1,'question',true,0,false,false,true,'{}'::jsonb);
  RESET ROLE;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_e1) <> true THEN RAISE EXCEPTION '9 FAIL q0 RPC did not set marker'; END IF;
  RAISE NOTICE '9. authoritative question-1 RPC sets marker (server-authoritative path allowed): PASS';

  -- 10. Q2+ transition does NOT set the marker
  PERFORM set_config('request.jwt.claims', json_build_object('sub',h1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase(s_e2,'question',true,2,false,false,true,'{}'::jsonb);
  RESET ROLE;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_e2) <> false THEN RAISE EXCEPTION '10 FAIL q2 set marker'; END IF;
  RAISE NOTICE '10. question-2+ transition does NOT set marker: PASS';

  -- 11. direct true→false reset DENIED (s_e1 marker is now true)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN UPDATE public.game_sessions SET exposure_fully_tracked = false WHERE id = s_e1; ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION '11 FAIL learner reset marker true→false'; END IF;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_e1) <> true THEN RAISE EXCEPTION '11 FAIL marker reset'; END IF;
  RAISE NOTICE '11. direct true→false reset by learner DENIED: PASS';

  -- 12. service_role controlled maintenance ALLOWED
  SET LOCAL ROLE service_role;
  UPDATE public.game_sessions SET exposure_fully_tracked = false WHERE id = s_e1;
  RESET ROLE;
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_e1) <> false THEN RAISE EXCEPTION '12 FAIL service_role could not maintain marker'; END IF;
  RAISE NOTICE '12. service_role controlled marker maintenance ALLOWED: PASS';

  -- 13. postgres (superuser/migration/DEFINER-owner) ALLOWED
  UPDATE public.game_sessions SET exposure_fully_tracked = true WHERE id = s_e1;  -- current_user=postgres here
  IF (SELECT exposure_fully_tracked FROM public.game_sessions WHERE id=s_e1) <> true THEN RAISE EXCEPTION '13 FAIL postgres could not set marker'; END IF;
  RAISE NOTICE '13. postgres controlled marker write ALLOWED: PASS';

  -- 14. client INSERT of a marker-true session DENIED (server-authoritative on insert too)
  PERFORM set_config('request.jwt.claims', json_build_object('sub',l1,'role','authenticated')::text, true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN
    INSERT INTO public.game_sessions(id,tenant_id,host_id,pin,status,demo_mode,question_count,exposure_fully_tracked)
    VALUES (gen_random_uuid(),'00000000-0000-0000-0000-0000000860a0',l1,'pins','completed',false,3,true); ok:=true;
  EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION '14 FAIL client inserted marker-true session'; END IF;
  RAISE NOTICE '14. client INSERT with marker=true DENIED (default-false creation still works): PASS';

  RAISE NOTICE '086 ALL TESTS PASSED';
END $$;
ROLLBACK;
