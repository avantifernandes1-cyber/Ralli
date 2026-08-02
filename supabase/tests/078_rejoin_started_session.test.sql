-- Real-JWT test for migration 078 (safe rejoin to a started/paused session).
-- SELF-CONTAINED: creates the 078 function in a transaction, seeds ephemeral
-- identities/sessions/participants, exercises rpc_rejoin_session under real
-- request.jwt.claims, asserts the rejoin authorization contract + that reactivation
-- preserves identity/answers and creates no duplicate, then ROLLS BACK. Runs against
-- a DB with the base schema present. Expect "078 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_rejoin_session(p_pin text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions; v_part public.game_session_participants;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE pin = p_pin AND tenant_id = v_tenant::text ORDER BY created_at DESC LIMIT 1;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF v_s.status <> 'started' THEN RAISE EXCEPTION 'not rejoinable (status=%)', v_s.status USING ERRCODE = 'check_violation'; END IF;
  SELECT * INTO v_part FROM public.game_session_participants WHERE session_id = v_s.id AND player_id = v_uid::text;
  IF v_part.session_id IS NULL THEN RAISE EXCEPTION 'not a participant' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.game_session_participants SET status = 'active', last_seen_at = now() WHERE session_id = v_s.id AND player_id = v_uid::text;
  RETURN jsonb_build_object('ok', true,
    'session', jsonb_build_object('id', v_s.id, 'pin', v_s.pin, 'name', v_s.name, 'status', v_s.status, 'phase', v_s.phase, 'paused', v_s.paused),
    'participant', jsonb_build_object('player_id', v_part.player_id, 'name', v_part.name, 'emoji', v_part.emoji));
END; $$;

-- Fixtures. tA started+paused session S with participant P (who LEFT); tA started S2
-- with participant P2; tA waiting W; tA completed C; tB started SB with participant PB.
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000780a0','r78_ta','R78 A'),('00000000-0000-0000-0000-0000000780b0','r78_tb','R78 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000078001','authenticated','authenticated','r78p@t.test',now(),now()),   -- P participant of S (tA)
 ('00000000-0000-0000-0000-000000078002','authenticated','authenticated','r78new@t.test',now(),now()), -- NEW never participated (tA)
 ('00000000-0000-0000-0000-000000078003','authenticated','authenticated','r78pb@t.test',now(),now());  -- PB participant of SB (tB)
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000780a0', status='active' WHERE id='00000000-0000-0000-0000-000000078001';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000780a0', status='active' WHERE id='00000000-0000-0000-0000-000000078002';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000780b0', status='active' WHERE id='00000000-0000-0000-0000-000000078003';
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, paused, phase) VALUES
 ('00000000-0000-0000-0000-0000000780f1','00000000-0000-0000-0000-0000000780a0','q','h','780001','S','started',  1,false,true ,'question'),
 ('00000000-0000-0000-0000-0000000780f2','00000000-0000-0000-0000-0000000780a0','q','h','780002','W','waiting',  1,false,false,'waiting'),
 ('00000000-0000-0000-0000-0000000780f3','00000000-0000-0000-0000-0000000780a0','q','h','780003','C','completed',1,false,false,'ended'),
 ('00000000-0000-0000-0000-0000000780f4','00000000-0000-0000-0000-0000000780b0','q','h','780004','SB','started', 1,false,true ,'question');
-- P is a participant of S but has LEFT; also seed an answer row (points) to prove it survives.
INSERT INTO public.game_session_participants (session_id, tenant_id, player_id, name, emoji, status) VALUES
 ('00000000-0000-0000-0000-0000000780f1','00000000-0000-0000-0000-0000000780a0','00000000-0000-0000-0000-000000078001','P','🦊','left'),
 ('00000000-0000-0000-0000-0000000780f4','00000000-0000-0000-0000-0000000780b0','00000000-0000-0000-0000-000000078003','PB',NULL,'left');
INSERT INTO public.game_answers (session_id, tenant_id, player_id, question_idx, option_idx, is_correct, points) VALUES
 ('00000000-0000-0000-0000-0000000780f1','00000000-0000-0000-0000-0000000780a0','00000000-0000-0000-0000-000000078001',0,1,true,100);

DO $$
DECLARE v jsonb; ok boolean; n int;
BEGIN
  -- 1. P (prior participant, LEFT) rejoins S → ok; row reactivated (status active), NO duplicate,
  --    answer/points preserved, host stays paused.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000078001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_rejoin_session('780001');
  IF (v->>'ok') <> 'true' OR (v->'session'->>'status') <> 'started' OR (v->'session'->>'paused') <> 'true' THEN RAISE EXCEPTION 'T1 rejoin failed/resumed'; END IF;
  IF (v->'participant'->>'name') <> 'P' THEN RAISE EXCEPTION 'T1 identity not preserved'; END IF;
  RESET ROLE;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id='00000000-0000-0000-0000-0000000780f1' AND player_id='00000000-0000-0000-0000-000000078001';
  IF n <> 1 THEN RAISE EXCEPTION 'T1 duplicate participant (n=%)', n; END IF;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id='00000000-0000-0000-0000-0000000780f1' AND player_id='00000000-0000-0000-0000-000000078001' AND status='active';
  IF n <> 1 THEN RAISE EXCEPTION 'T1 row not reactivated'; END IF;
  SELECT count(*) INTO n FROM public.game_answers WHERE session_id='00000000-0000-0000-0000-0000000780f1' AND player_id='00000000-0000-0000-0000-000000078001' AND points=100;
  IF n <> 1 THEN RAISE EXCEPTION 'T1 answer/points lost'; END IF;
  IF (SELECT paused FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000780f1') <> true THEN RAISE EXCEPTION 'T1 rejoin auto-resumed the game'; END IF;
  RAISE NOTICE '1. prior participant rejoins started/paused; reactivated, no dup, points kept, host still paused: PASS';

  -- 2. brand-new user (never a participant) denied on S.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000078002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_rejoin_session('780001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T2 brand-new user NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '2. brand-new (never-participated) user denied: PASS';

  -- 3. cross-tenant: tA participant P cannot rejoin tB session SB (pin 780004 not in tA) → not found.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000078001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_rejoin_session('780004'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T3 cross-tenant NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '3. cross-tenant rejoin denied: PASS';

  -- 4. waiting (780002) and completed (780003) are not rejoinable.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000078001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_rejoin_session('780002'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T4 waiting was rejoinable'; END IF;
  BEGIN v := public.rpc_rejoin_session('780003'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T4 completed was rejoinable'; END IF;
  RESET ROLE;
  RAISE NOTICE '4. waiting + completed not rejoinable: PASS';

  -- 5. anon denied.
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  BEGIN v := public.rpc_rejoin_session('780001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T5 anon NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '5. anon denied: PASS';

  RAISE NOTICE '078 ALL TESTS PASSED';
END $$;

ROLLBACK;
