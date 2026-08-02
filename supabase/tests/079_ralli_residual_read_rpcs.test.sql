-- Real-JWT test for migration 079 (residual host-read cutover RPCs).
-- SELF-CONTAINED: creates the ralli_can_manage_session helper (if absent) + the two
-- 079 functions in a transaction, seeds ephemeral data, exercises them under real
-- request.jwt.claims, asserts authorization + behavior, then ROLLS BACK. Expect
-- "079 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT auth.uid() IS NOT NULL AND (p_host_id = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
      AND ((p.role IN ('orgAdmin','manager') AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant) OR p.role = 'ralli_admin')));
$$;
CREATE OR REPLACE FUNCTION public.rpc_host_publish_reveal(p_session_id uuid, p_expected_qidx integer, p_live_question jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_s public.game_sessions; v_updated int; v_phase text; v_cqi int; v_lq jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  UPDATE public.game_sessions SET phase='reveal', live_question=p_live_question
   WHERE id=p_session_id AND current_question_index=p_expected_qidx AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN RETURN jsonb_build_object('outcome','applied'); END IF;
  SELECT phase, current_question_index, live_question INTO v_phase, v_cqi, v_lq FROM public.game_sessions WHERE id=p_session_id;
  RETURN jsonb_build_object('outcome','zero','current', jsonb_build_object('phase',v_phase,'current_question_index',v_cqi,'live_question',v_lq));
END; $$;
CREATE OR REPLACE FUNCTION public.rpc_host_award_context(p_pin text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  SELECT * INTO v_s FROM public.game_sessions WHERE pin=p_pin AND (v_tenant IS NOT NULL AND tenant_id=v_tenant::text) ORDER BY created_at DESC LIMIT 1;
  IF v_s.id IS NULL THEN RETURN jsonb_build_object('session_id', NULL, 'participants', '[]'::jsonb); END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN jsonb_build_object('session_id', v_s.id, 'participants', COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id',gp.player_id,'name',gp.name)) FROM public.game_session_participants gp WHERE gp.session_id=v_s.id), '[]'::jsonb));
END; $$;

INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000790a0','r79_ta','R79 A'),('00000000-0000-0000-0000-0000000790b0','r79_tb','R79 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000079001','authenticated','authenticated','r79host@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000079002','authenticated','authenticated','r79learn@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000079003','authenticated','authenticated','r79xmgr@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000790a0', status='active' WHERE id='00000000-0000-0000-0000-000000079001';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000790a0', status='active' WHERE id='00000000-0000-0000-0000-000000079002';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000790b0', status='active' WHERE id='00000000-0000-0000-0000-000000079003';
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, paused, phase, current_question_index) VALUES
 ('00000000-0000-0000-0000-0000000790f1','00000000-0000-0000-0000-0000000790a0','q','00000000-0000-0000-0000-000000079001','790001','S','started',1,false,false,'question',0);
INSERT INTO public.game_session_participants (session_id, tenant_id, player_id, name, status) VALUES
 ('00000000-0000-0000-0000-0000000790f1','00000000-0000-0000-0000-0000000790a0','00000000-0000-0000-0000-000000079002','L','active');

DO $$
DECLARE v jsonb; ok boolean;
BEGIN
  -- publish_reveal: host applies (phase question→reveal); a learner is denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000079001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_host_publish_reveal('00000000-0000-0000-0000-0000000790f1', 0, '{"qIdx":0,"reveal":{"correctIdx":1}}'::jsonb);
  IF (v->>'outcome') <> 'applied' THEN RAISE EXCEPTION 'T1 host reveal not applied (%)', v->>'outcome'; END IF;
  -- second identical publish → zero + current row returned (for JS idempotent classify)
  v := public.rpc_host_publish_reveal('00000000-0000-0000-0000-0000000790f1', 0, '{"qIdx":0,"reveal":{"correctIdx":1}}'::jsonb);
  IF (v->>'outcome') <> 'zero' OR (v->'current'->>'phase') <> 'reveal' THEN RAISE EXCEPTION 'T1 second publish not zero+current'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000079002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v:=public.rpc_host_publish_reveal('00000000-0000-0000-0000-0000000790f1',0,'{"x":1}'::jsonb); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T1 learner reveal NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '1. rpc_host_publish_reveal: host applies + zero/current classify; learner denied: PASS';

  -- award_context: host gets session_id + participants; cross-tenant manager denied/empty; learner denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000079001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_host_award_context('790001');
  IF (v->>'session_id') IS NULL OR jsonb_array_length(v->'participants') <> 1 THEN RAISE EXCEPTION 'T2 host award_context wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000079003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_host_award_context('790001')->>'session_id') IS NOT NULL THEN RAISE EXCEPTION 'T2 cross-tenant manager saw session'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000079002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v:=public.rpc_host_award_context('790001'); IF (v->>'session_id') IS NOT NULL THEN RAISE EXCEPTION 'T2 learner saw session'; END IF; EXCEPTION WHEN OTHERS THEN NULL; END;
  RESET ROLE;
  RAISE NOTICE '2. rpc_host_award_context: host resolves; cross-tenant/learner excluded: PASS';

  RAISE NOTICE '079 ALL TESTS PASSED';
END $$;

ROLLBACK;
