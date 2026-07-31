-- Real-JWT test for migration 080 (server-authorized Ralli Live lifecycle write RPCs).
-- SELF-CONTAINED: creates the ralli_can_manage_session helper + the 8 write RPCs in a
-- transaction, seeds ephemeral identities/sessions, exercises them under real
-- request.jwt.claims, asserts authorization + behavior, then ROLLS BACK. Expect
-- "080 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Dependency + the 8 RPCs (copied verbatim from migration 080 so the test is standalone).
CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT auth.uid() IS NOT NULL AND (p_host_id = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
      AND ((p.role IN ('orgAdmin','manager') AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant) OR p.role = 'ralli_admin')));
$$;
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_pin text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE pin=p_pin AND tenant_id=v_tenant::text ORDER BY created_at DESC LIMIT 1;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid, p_pin text) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NOT NULL THEN SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  ELSE SELECT * INTO v_s FROM public.game_sessions WHERE pin=p_pin AND tenant_id=v_tenant::text ORDER BY created_at DESC LIMIT 1; END IF;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id=v_s.id;
  UPDATE public.game_session_participants SET status='completed', last_seen_at=now() WHERE session_id=v_s.id AND status IN ('active','joined');
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_cancel_session(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET status='canceled', ended_at=now() WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET phase=p_phase,
    current_question_index = CASE WHEN p_set_cqi THEN p_cqi ELSE current_question_index END,
    paused = CASE WHEN p_set_paused THEN p_paused ELSE paused END,
    live_question = CASE WHEN p_set_live THEN p_live_question ELSE live_question END
  WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_save_question_snapshot(p_session_id uuid, p_questions jsonb) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_written int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET question_snapshot=p_questions WHERE id=v_s.id AND question_snapshot IS NULL;
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
  IF v_s.id IS NULL OR v_s.tenant_id <> v_tenant::text THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, joined_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, now())
  ON CONFLICT (session_id, player_id) DO UPDATE SET name=EXCLUDED.name, emoji=EXCLUDED.emoji, color=EXCLUDED.color, joined_at=EXCLUDED.joined_at, tenant_id=EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok',true);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_participant_leave(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_session_participants SET status='left', last_seen_at=now() WHERE session_id=p_session_id AND player_id=v_uid::text;
  RETURN jsonb_build_object('ok',true);
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_participant_heartbeat(p_session_id uuid) RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_session_participants SET last_seen_at=now() WHERE session_id=p_session_id AND player_id=v_uid::text;
  RETURN jsonb_build_object('ok',true);
END; $$;

-- Seed: tenant A + B, host H(orgAdmin,A), manager M(manager,A), learners L,L2(user,A), xtenant X(orgAdmin,B).
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000800a0','r80_ta','R80 A'),('00000000-0000-0000-0000-0000000800b0','r80_tb','R80 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000080001','authenticated','authenticated','h80@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000080002','authenticated','authenticated','m80@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000080003','authenticated','authenticated','l80@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000080004','authenticated','authenticated','l80b@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000080005','authenticated','authenticated','x80@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000800a0', status='active' WHERE id='00000000-0000-0000-0000-000000080001';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000800a0', status='active' WHERE id='00000000-0000-0000-0000-000000080002';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000800a0', status='active' WHERE id='00000000-0000-0000-0000-000000080003';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000800a0', status='active' WHERE id='00000000-0000-0000-0000-000000080004';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000800b0', status='active' WHERE id='00000000-0000-0000-0000-000000080005';
-- S1 host-lifecycle session; S2 for manager-start + cancel
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, paused, phase, current_question_index) VALUES
 ('00000000-0000-0000-0000-0000000800f1','00000000-0000-0000-0000-0000000800a0','q','00000000-0000-0000-0000-000000080001','800001','S1','waiting',3,false,false,'question',0),
 ('00000000-0000-0000-0000-0000000800f2','00000000-0000-0000-0000-0000000800a0','q','00000000-0000-0000-0000-000000080001','800002','S2','waiting',3,false,false,'question',0);

DO $$
DECLARE v jsonb; ok boolean; s1 uuid := '00000000-0000-0000-0000-0000000800f1'; s2 uuid := '00000000-0000-0000-0000-0000000800f2';
        v_status text; v_phase text; v_cqi int; v_paused boolean; v_live jsonb; v_snap jsonb; n int; v_emoji text;
BEGIN
  -- ═══ HOST (H) lifecycle on S1 ═══
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  -- snapshot write-once
  v := public.rpc_save_question_snapshot(s1, '[{"q":"one"}]'::jsonb);
  IF (v->>'written') <> 'true' THEN RAISE EXCEPTION 'T-snap first write not written'; END IF;
  v := public.rpc_save_question_snapshot(s1, '[{"q":"OVERWRITE"}]'::jsonb);
  IF (v->>'written') <> 'false' THEN RAISE EXCEPTION 'T-snap immutable violated (second write applied)'; END IF;
  RESET ROLE; SELECT question_snapshot INTO v_snap FROM public.game_sessions WHERE id=s1;
  IF v_snap <> '[{"q":"one"}]'::jsonb THEN RAISE EXCEPTION 'T-snap content changed'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  -- start
  v := public.rpc_start_session('800001'); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'T-start not ok'; END IF;
  -- phase set (cqi+paused+live)
  v := public.rpc_set_session_phase(s1,'reveal', true, 2, true, true, true, '{"live":1}'::jsonb);
  RESET ROLE; SELECT status,phase,current_question_index,paused,live_question INTO v_status,v_phase,v_cqi,v_paused,v_live FROM public.game_sessions WHERE id=s1;
  IF v_status<>'started' OR v_phase<>'reveal' OR v_cqi<>2 OR v_paused<>true OR v_live<>'{"live":1}'::jsonb THEN RAISE EXCEPTION 'T-phase set wrong: % % % % %',v_status,v_phase,v_cqi,v_paused,v_live; END IF;
  -- phase partial: change phase, CLEAR live, LEAVE cqi & paused
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_set_session_phase(s1,'question', false, null, false, null, true, null);
  RESET ROLE; SELECT phase,current_question_index,paused,live_question INTO v_phase,v_cqi,v_paused,v_live FROM public.game_sessions WHERE id=s1;
  IF v_phase<>'question' OR v_cqi<>2 OR v_paused<>true OR v_live IS NOT NULL THEN RAISE EXCEPTION 'T-phase partial wrong: % % % %',v_phase,v_cqi,v_paused,v_live; END IF;

  -- learners join S1 (self writes) BEFORE end, to prove participant completion
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_participant_join(s1,'Lname',null,null);              -- null avatar
  v := public.rpc_participant_join(s1,'Lname2',null,null);             -- idempotent (2nd call)
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080004","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_participant_join(s1,'L2name','X','#fff');
  RESET ROLE;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id=s1;
  IF n <> 2 THEN RAISE EXCEPTION 'T-join dedup: expected 2 participants got %', n; END IF;
  SELECT emoji INTO v_emoji FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000080003';
  IF v_emoji IS NOT NULL THEN RAISE EXCEPTION 'T-join null avatar not preserved: %', v_emoji; END IF;

  -- learner heartbeat + leave target ONLY caller's row
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_participant_heartbeat(s1);
  v := public.rpc_participant_leave(s1);
  RESET ROLE;
  SELECT status INTO v_status FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000080003';
  IF v_status<>'left' THEN RAISE EXCEPTION 'T-leave own row not left'; END IF;
  SELECT status INTO v_status FROM public.game_session_participants WHERE session_id=s1 AND player_id='00000000-0000-0000-0000-000000080004';
  IF v_status='left' THEN RAISE EXCEPTION 'T-leave affected another participant (cross-write!)'; END IF;

  -- host END is atomic: session completed + remaining active participants completed
  -- (re-activate L first so end has an active participant to complete)
  UPDATE public.game_session_participants SET status='active' WHERE session_id=s1;  -- postgres, RESET ROLE already
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_end_session(s1, '800001'); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'T-end not ok'; END IF;
  RESET ROLE;
  SELECT status INTO v_status FROM public.game_sessions WHERE id=s1;
  IF v_status<>'completed' THEN RAISE EXCEPTION 'T-end session not completed'; END IF;
  SELECT count(*) INTO n FROM public.game_session_participants WHERE session_id=s1 AND status<>'completed';
  IF n<>0 THEN RAISE EXCEPTION 'T-end participants not all completed (% remain)', n; END IF;
  RAISE NOTICE '1. host lifecycle (snapshot write-once, start, phase set+partial, join/leave/heartbeat self, atomic end): PASS';

  -- ═══ AUTHORIZED MANAGER (M) on S2 ═══
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_start_session('800002'); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'T-mgr start not ok'; END IF;
  v := public.rpc_cancel_session(s2); IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'T-mgr cancel not ok'; END IF;
  RESET ROLE;
  RAISE NOTICE '2. authorized manager start+cancel: PASS';

  -- ═══ LEARNER (L) DENIED host RPCs ═══
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_start_session('800001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-learner start NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_set_session_phase(s1,'x',false,null,false,null,false,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-learner phase NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_cancel_session(s1); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-learner cancel NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_save_question_snapshot(s1,'[]'::jsonb); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-learner snapshot NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_end_session(s1,'800001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-learner end NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '3. learner denied all host RPCs: PASS';

  -- ═══ CROSS-TENANT (X, tenant B) ═══
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  -- cannot start A's session by pin (resolves in B → not found)
  ok:=false; BEGIN PERFORM public.rpc_start_session('800001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-xtenant start NOT denied'; END IF;
  -- cannot cancel A's session by id (authz fails)
  ok:=false; BEGIN PERFORM public.rpc_cancel_session(s1); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-xtenant cancel NOT denied'; END IF;
  -- cannot join A's session (tenant mismatch → not found)
  ok:=false; BEGIN PERFORM public.rpc_participant_join(s1,'X',null,null); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-xtenant join NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '4. cross-tenant denied (start/cancel/join): PASS';

  -- ═══ ANON ═══
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  ok:=false; BEGIN PERFORM public.rpc_participant_heartbeat(s1); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-anon heartbeat NOT denied'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_start_session('800001'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-anon start NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '5. anon denied: PASS';

  -- ═══ Honest failures ═══
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000080001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_cancel_session('00000000-0000-0000-0000-0000000809ff'); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T-cancel unknown NOT rejected'; END IF;
  RESET ROLE;
  RAISE NOTICE '6. honest failure on unknown session: PASS';

  RAISE NOTICE '080 ALL TESTS PASSED';
END $$;

ROLLBACK;
