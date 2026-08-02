-- Real-JWT test for migration 080 (server-authorized Ralli Live lifecycle write RPCs) —
-- CORRECTED: exact-session identity + state-transition guards + canonical joinability.
-- SELF-CONTAINED: creates the helper + the 8 RPCs in a transaction, seeds ephemeral
-- identities/sessions, exercises them under real request.jwt.claims, asserts, ROLLS BACK.
-- Expect "080 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT auth.uid() IS NOT NULL AND (p_host_id = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
      AND ((p.role IN ('orgAdmin','manager') AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant) OR p.role = 'ralli_admin')));
$$;
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status<>'waiting' THEN RAISE EXCEPTION 'not startable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  IF v_s.question_snapshot IS NULL THEN RAISE EXCEPTION 'no snapshot' USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RETURN jsonb_build_object('ok',false,'matched',false); END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status='completed' THEN RETURN jsonb_build_object('ok',true,'matched',true,'already',true,'session_id',v_s.id); END IF;
  IF v_s.status<>'started' THEN RAISE EXCEPTION 'not endable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id=v_s.id;
  UPDATE public.game_session_participants SET status='completed', last_seen_at=now() WHERE session_id=v_s.id AND status IN ('active','joined');
  RETURN jsonb_build_object('ok',true,'matched',true,'already',false,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_cancel_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status='canceled' THEN RETURN jsonb_build_object('ok',true,'already',true,'session_id',v_s.id); END IF;
  IF v_s.status<>'waiting' THEN RAISE EXCEPTION 'not cancellable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET status='canceled', ended_at=now() WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true,'already',false,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status IN ('completed','canceled','ended') THEN RAISE EXCEPTION 'not mutable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET phase=p_phase,
    current_question_index=CASE WHEN p_set_cqi THEN p_cqi ELSE current_question_index END,
    paused=CASE WHEN p_set_paused THEN p_paused ELSE paused END,
    live_question=CASE WHEN p_set_live THEN p_live_question ELSE live_question END
  WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_save_question_snapshot(p_session_id uuid, p_questions jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_written int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET question_snapshot=p_questions WHERE id=v_s.id AND status='waiting' AND question_snapshot IS NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'written',v_written=1);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_participant_join(p_session_id uuid, p_name text, p_emoji text, p_color text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL OR v_s.tenant_id IS DISTINCT FROM v_tenant::text THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status<>'waiting' THEN RAISE EXCEPTION 'not joinable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, 'active', now(), now())
  ON CONFLICT (session_id, player_id) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji, color=EXCLUDED.color, status='active', joined_at=EXCLUDED.joined_at, last_seen_at=EXCLUDED.last_seen_at, tenant_id=EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok',true);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_participant_leave(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_session_participants SET status='left', last_seen_at=now() WHERE session_id=p_session_id AND player_id=v_uid::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'matched',v_n=1);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_participant_heartbeat(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_session_participants SET last_seen_at=now() WHERE session_id=p_session_id AND player_id=v_uid::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok',true,'matched',v_n=1);
END; $$;

INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000810a0','r81_ta','R81 A'),('00000000-0000-0000-0000-0000000810b0','r81_tb','R81 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000081001','authenticated','authenticated','h81@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081002','authenticated','authenticated','m81@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081003','authenticated','authenticated','l81@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081004','authenticated','authenticated','l81b@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081005','authenticated','authenticated','x81@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081001';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081002';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081003';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081004';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000810b0', status='active' WHERE id='00000000-0000-0000-0000-000000081005';
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, paused, phase, current_question_index, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000008100f1','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810001','S1','waiting',3,false,false,'question',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100f2','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810002','S2','waiting',3,false,false,'question',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100f3','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810003','S3','waiting',3,false,false,'question',0,NULL),
 ('00000000-0000-0000-0000-0000008100f4','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810004','S4','waiting',3,true, false,'question',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100f6','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810006','S6','waiting',3,false,false,'question',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100f7','00000000-0000-0000-0000-0000000810a0','q','00000000-0000-0000-0000-000000081001','810007','S7','waiting',3,false,false,'question',0,'[{"q":1}]'::jsonb);

DO $$
DECLARE v jsonb; ok boolean;
  s1 uuid:='00000000-0000-0000-0000-0000008100f1'; s2 uuid:='00000000-0000-0000-0000-0000008100f2';
  s3 uuid:='00000000-0000-0000-0000-0000008100f3'; s4 uuid:='00000000-0000-0000-0000-0000008100f4';
  s6 uuid:='00000000-0000-0000-0000-0000008100f6'; s7 uuid:='00000000-0000-0000-0000-0000008100f7';
  st text; n int; em text;
BEGIN
  -- ── L1: JOIN / LEAVE / REJOIN-STATE / DEDUP / NULL-AVATAR / HEARTBEAT on waiting S1 ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_participant_join(s1,'L',null,null);                 -- fresh join (null avatar)
  RESET ROLE; SELECT status,emoji INTO st,em FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000081003';
  IF st<>'active' THEN RAISE EXCEPTION 'J1 join status not active'; END IF;
  IF em IS NOT NULL THEN RAISE EXCEPTION 'J1 null avatar not preserved'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_participant_leave(s1); IF (v->>'matched')<>'true' THEN RAISE EXCEPTION 'J2 leave not matched'; END IF;
  RESET ROLE; SELECT status INTO st FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000081003';
  IF st<>'left' THEN RAISE EXCEPTION 'J2 not left'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_participant_join(s1,'L',null,null);                 -- returning 'left' → waiting rejoin
  v:=public.rpc_participant_join(s1,'L',null,null);                 -- idempotent
  RESET ROLE; SELECT status INTO st FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000081003';
  IF st<>'active' THEN RAISE EXCEPTION 'J3 returning join did not reactivate (%)',st; END IF;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000081003';
  IF n<>1 THEN RAISE EXCEPTION 'J3 duplicate participant (%)',n; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081004","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_participant_join(s1,'L2','X','#fff');
  RESET ROLE; SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id=s1;
  IF n<>2 THEN RAISE EXCEPTION 'J4 expected 2 participants (%)',n; END IF;
  -- heartbeat honest matched/not-matched
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_participant_heartbeat(s1); IF (v->>'matched')<>'true' THEN RAISE EXCEPTION 'HB own not matched'; END IF;
  v:=public.rpc_participant_heartbeat(s2); IF (v->>'matched')<>'false' THEN RAISE EXCEPTION 'HB no-row not honestly false'; END IF;
  RESET ROLE;
  RAISE NOTICE '1. join/leave/reactivate/dedup/null-avatar/heartbeat-honest: PASS';

  -- ── L2: START exact-id + reused-independence + snapshot/demo/null/random guards ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_start_session(s1); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'ST start s1 not ok'; END IF;
  RESET ROLE; SELECT status INTO st FROM public.game_sessions WHERE id=s1; IF st<>'started' THEN RAISE EXCEPTION 'ST s1 not started'; END IF;
  SELECT status INTO st FROM public.game_sessions WHERE id=s2; IF st<>'waiting' THEN RAISE EXCEPTION 'ST reused-independence: s2 changed (%)',st; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_start_session(NULL); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'ST null id NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session('00000000-0000-0000-0000-0000008109ff'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'ST random id NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'ST no-snapshot NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s4); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'ST demo NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s1); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'ST re-start started NOT rejected'; END IF;
  RESET ROLE;
  RAISE NOTICE '2. start exact-id + reused-independence + snapshot/demo/null/random guards: PASS';

  -- ── L3: started session rejects NORMAL join (rejoin is 078) ; phase mutable while live ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_participant_join(s1,'L',null,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'started normal-join NOT rejected'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_set_session_phase(s1,'reveal',true,1,true,true,true,'{"l":1}'::jsonb); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'phase live not ok'; END IF;
  RESET ROLE;
  RAISE NOTICE '3. started rejects normal join; phase mutable while live: PASS';

  -- ── L4: END exact-id + atomic + idempotent + null no-op ──
  UPDATE public.game_session_participants SET status='active' WHERE session_id=s1;  -- ensure active participants
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_end_session(s1); IF (v->>'ok')<>'true' OR (v->>'already')<>'false' THEN RAISE EXCEPTION 'END s1 not ok'; END IF;
  v:=public.rpc_end_session(s1); IF (v->>'already')<>'true' THEN RAISE EXCEPTION 'END idempotent not already'; END IF;
  v:=public.rpc_end_session(NULL); IF (v->>'matched')<>'false' THEN RAISE EXCEPTION 'END null not no-op'; END IF;
  RESET ROLE;
  SELECT status INTO st FROM public.game_sessions WHERE id=s1; IF st<>'completed' THEN RAISE EXCEPTION 'END s1 not completed'; END IF;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id=s1 AND status<>'completed'; IF n<>0 THEN RAISE EXCEPTION 'END participants not all completed (%)',n; END IF;
  RAISE NOTICE '4. end exact-id + atomic + idempotent + null no-op: PASS';

  -- ── L5: terminal session cannot be phase-mutated or cancelled ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_set_session_phase(s1,'x',false,null,false,null,false,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'completed phase NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_cancel_session(s1); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'cancel completed NOT rejected'; END IF;
  -- cancel a WAITING session (s2) ok + idempotent; then canceled rejects join
  v:=public.rpc_cancel_session(s2); IF (v->>'ok')<>'true' OR (v->>'already')<>'false' THEN RAISE EXCEPTION 'cancel s2 not ok'; END IF;
  v:=public.rpc_cancel_session(s2); IF (v->>'already')<>'true' THEN RAISE EXCEPTION 'cancel idempotent not already'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_participant_join(s2,'L',null,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'canceled normal-join NOT rejected'; END IF;
  RESET ROLE;
  RAISE NOTICE '5. terminal not mutable/cancellable; cancel waiting ok+idempotent; canceled join rejected: PASS';

  -- ── L6: authorized MANAGER start + cancel ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v:=public.rpc_cancel_session(s6); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'mgr cancel not ok'; END IF;
  v:=public.rpc_start_session(s7);  IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'mgr start not ok'; END IF;
  RESET ROLE;
  RAISE NOTICE '6. authorized manager start+cancel: PASS';

  -- ── L7: learner denied host RPCs; cross-tenant denied; anon denied ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'learner start NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_cancel_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'learner cancel NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_save_question_snapshot(s3,'[]'::jsonb); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'learner snapshot NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_set_session_phase(s3,'x',false,null,false,null,false,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'learner phase NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_end_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'learner end NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000081005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'xtenant start NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_cancel_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'xtenant cancel NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_participant_join(s3,'X',null,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'xtenant join NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  ok:=false; BEGIN PERFORM public.rpc_participant_heartbeat(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'anon heartbeat NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s3); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'anon start NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '7. learner/cross-tenant/anon denied: PASS';

  RAISE NOTICE '080 ALL TESTS PASSED';
END $$;

ROLLBACK;
