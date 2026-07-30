-- Real-JWT authorization tests for migration 075 (host/manager safe-read RPCs).
-- SELF-CONTAINED: creates the 075 functions inside a transaction, seeds ephemeral
-- identities/sessions, exercises every RPC under real request.jwt.claims + SET LOCAL
-- ROLE authenticated/anon, asserts the authorization matrix, then ROLLS BACK — no
-- residual functions, users, sessions, or data. Runs against a DB with the base
-- schema (game_sessions/game_answers/game_players/game_session_participants/profiles/
-- tenants) present. Expect "075 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── 075 function bodies (verbatim from supabase/migrations/075_host_manager_safe_reads.sql) ──
CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT auth.uid() IS NOT NULL AND (
    p_host_id = auth.uid()::text
    OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid()
      AND ((p.role = 'orgAdmin' AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant) OR p.role = 'ralli_admin')));
$$;

CREATE OR REPLACE FUNCTION public.rpc_host_session_restore(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN jsonb_build_object(
    'session', jsonb_build_object('id', v_s.id, 'phase', v_s.phase, 'status', v_s.status, 'pin', v_s.pin, 'live_question', v_s.live_question),
    'answers', COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id', ga.player_id, 'question_idx', ga.question_idx, 'points', ga.points) ORDER BY ga.question_idx) FROM public.game_answers ga WHERE ga.session_id = p_session_id), '[]'::jsonb),
    'participants', COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id', gp.player_id, 'name', gp.name, 'emoji', gp.emoji) ORDER BY gp.joined_at) FROM public.game_session_participants gp WHERE gp.session_id = p_session_id), '[]'::jsonb));
END; $$;

CREATE OR REPLACE FUNCTION public.rpc_manager_active_sessions(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_tenant uuid; v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT role, tenant_id INTO v_role, v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_role = 'orgAdmin' AND v_tenant IS NOT NULL THEN v_target := v_tenant::text;
  ELSIF v_role = 'ralli_admin' THEN v_target := p_tenant_id::text;
  ELSE RETURN '[]'::jsonb; END IF;
  IF v_target IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', s.id, 'pin', s.pin, 'status', s.status) ORDER BY s.created_at DESC)
    FROM public.game_sessions s WHERE s.tenant_id = v_target AND s.status IN ('waiting','started','live','active','paused')), '[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION public.rpc_manager_session_history(p_tenant_id uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_role text; v_tenant uuid; v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT role, tenant_id INTO v_role, v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_role = 'orgAdmin' AND v_tenant IS NOT NULL THEN v_target := v_tenant::text;
  ELSIF v_role = 'ralli_admin' THEN v_target := p_tenant_id::text;
  ELSE RETURN '[]'::jsonb; END IF;
  IF v_target IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.ended_at DESC NULLS LAST) FROM (
    SELECT s.id, s.pin, s.status, s.ended_at,
      (SELECT count(*) FROM public.game_players gp WHERE gp.session_id = s.id) AS player_count
    FROM public.game_sessions s WHERE s.tenant_id = v_target AND s.status = 'completed'
    ORDER BY s.ended_at DESC NULLS LAST LIMIT GREATEST(p_limit,0)) t), '[]'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION public.rpc_manager_session_analytics(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN jsonb_build_object('session', jsonb_build_object('id', v_s.id, 'status', v_s.status),
    'players', COALESCE((SELECT jsonb_agg(to_jsonb(gp)) FROM public.game_players gp WHERE gp.session_id = p_session_id), '[]'::jsonb),
    'answers', COALESCE((SELECT jsonb_agg(to_jsonb(ga)) FROM public.game_answers ga WHERE ga.session_id = p_session_id), '[]'::jsonb),
    'snapshot', v_s.question_snapshot);
END; $$;

CREATE OR REPLACE FUNCTION public.rpc_session_player_counts(p_session_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF auth.uid() IS NULL OR p_session_ids IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN COALESCE((SELECT jsonb_object_agg(x.id::text, x.cnt) FROM (
    SELECT gs.id, (SELECT count(*) FROM public.game_players gp WHERE gp.session_id = gs.id) AS cnt
    FROM public.game_sessions gs WHERE gs.id = ANY(p_session_ids)
      AND (public.ralli_can_manage_session(gs.host_id, gs.tenant_id)
           OR EXISTS (SELECT 1 FROM public.game_session_participants pp WHERE pp.session_id = gs.id AND pp.player_id = auth.uid()::text))) x), '{}'::jsonb);
END; $$;

CREATE OR REPLACE FUNCTION public.rpc_lobby_participants(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE='no_data_found'; END IF;
  IF NOT (public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id)
          OR EXISTS (SELECT 1 FROM public.game_session_participants pp WHERE pp.session_id = p_session_id AND pp.player_id = auth.uid()::text))
  THEN RAISE EXCEPTION 'not authorized' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('player_id', gp.player_id, 'name', gp.name, 'emoji', gp.emoji, 'status', gp.status) ORDER BY gp.joined_at)
    FROM public.game_session_participants gp WHERE gp.session_id = p_session_id), '[]'::jsonb);
END; $$;

-- ── Ephemeral fixtures (reserved 075xxxx id space) ──
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000750a0','r75_ta','R75 A'),
 ('00000000-0000-0000-0000-0000000750b0','r75_tb','R75 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000075001','authenticated','authenticated','r75_host@t.test',now(),now()),  -- HU host (orgAdmin tA)
 ('00000000-0000-0000-0000-000000075002','authenticated','authenticated','r75_mgrA@t.test',now(),now()),  -- MA same-tenant manager
 ('00000000-0000-0000-0000-000000075003','authenticated','authenticated','r75_mgrB@t.test',now(),now()),  -- MB other-tenant manager
 ('00000000-0000-0000-0000-000000075004','authenticated','authenticated','r75_ra@t.test',now(),now()),    -- RA ralli_admin
 ('00000000-0000-0000-0000-000000075005','authenticated','authenticated','r75_partL@t.test',now(),now()), -- L participant learner (tA)
 ('00000000-0000-0000-0000-000000075006','authenticated','authenticated','r75_learnX@t.test',now(),now());-- X non-participant learner (tA)
UPDATE public.profiles SET role='orgAdmin',   tenant_id='00000000-0000-0000-0000-0000000750a0', status='active' WHERE id='00000000-0000-0000-0000-000000075001';
UPDATE public.profiles SET role='orgAdmin',   tenant_id='00000000-0000-0000-0000-0000000750a0', status='active' WHERE id='00000000-0000-0000-0000-000000075002';
UPDATE public.profiles SET role='orgAdmin',   tenant_id='00000000-0000-0000-0000-0000000750b0', status='active' WHERE id='00000000-0000-0000-0000-000000075003';
UPDATE public.profiles SET role='ralli_admin', tenant_id=NULL,                                    status='active' WHERE id='00000000-0000-0000-0000-000000075004';
UPDATE public.profiles SET role='user',        tenant_id='00000000-0000-0000-0000-0000000750a0', status='active' WHERE id='00000000-0000-0000-0000-000000075005';
UPDATE public.profiles SET role='user',        tenant_id='00000000-0000-0000-0000-0000000750a0', status='active' WHERE id='00000000-0000-0000-0000-000000075006';

-- Completed session S (tA, hosted by HU) + active session S2 (tA) + other-tenant session S3 (tB).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000000750f1','00000000-0000-0000-0000-0000000750a0','q','00000000-0000-0000-0000-000000075001','750001','S','completed',1,false,now(),'[{"id":"qa","type":"mc","correct":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000000750f2','00000000-0000-0000-0000-0000000750a0','q','00000000-0000-0000-0000-000000075001','750002','S2','started',1,false,NULL,'[{"id":"qb","type":"mc","correct":0}]'::jsonb),
 ('00000000-0000-0000-0000-0000000750f3','00000000-0000-0000-0000-0000000750b0','q','00000000-0000-0000-0000-000000075003','750003','S3','completed',1,false,now(),'[{"id":"qc","type":"mc","correct":1}]'::jsonb);
INSERT INTO public.game_answers (session_id, tenant_id, player_id, question_idx, option_idx, is_correct, points) VALUES
 ('00000000-0000-0000-0000-0000000750f1','00000000-0000-0000-0000-0000000750a0','00000000-0000-0000-0000-000000075005',0,1,true,100);
INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank) VALUES
 ('00000000-0000-0000-0000-0000000750f1','00000000-0000-0000-0000-0000000750a0','00000000-0000-0000-0000-000000075005','L',100,1);
INSERT INTO public.game_session_participants (session_id, tenant_id, player_id, name, status) VALUES
 ('00000000-0000-0000-0000-0000000750f1','00000000-0000-0000-0000-0000000750a0','00000000-0000-0000-0000-000000075005','L','joined');

DO $$
DECLARE ok boolean; v jsonb;
  S  uuid := '00000000-0000-0000-0000-0000000750f1';
  S2 uuid := '00000000-0000-0000-0000-0000000750f2';
  tA uuid := '00000000-0000-0000-0000-0000000750a0';
  PROCEDURE_dummy int;
BEGIN
  -- helper macro via dynamic: set identity
  -- 1. host_session_restore: HU host ok; MA same-tenant ok; RA ok; MB denied; L(participant) denied; X denied; anon denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_host_session_restore(S); IF (v->'session'->>'id') <> S::text THEN RAISE EXCEPTION 'T1 host restore(host) failed'; END IF;
  IF jsonb_array_length(v->'answers') <> 1 OR jsonb_array_length(v->'participants') <> 1 THEN RAISE EXCEPTION 'T1 host restore payload wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_host_session_restore(S); IF (v->'session'->>'id') <> S::text THEN RAISE EXCEPTION 'T1 host restore(same-tenant mgr) failed'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075004","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_host_session_restore(S); IF (v->'session'->>'id') <> S::text THEN RAISE EXCEPTION 'T1 host restore(ralli_admin) failed'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_host_session_restore(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T1 host restore(other-tenant mgr) NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_host_session_restore(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T1 host restore(participant learner) NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  BEGIN v := public.rpc_host_session_restore(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T1 host restore(anon) NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '1. host_session_restore authz matrix: PASS';

  -- 2. manager_session_analytics: HU ok (snapshot present); MB denied; L denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_manager_session_analytics(S);
  IF jsonb_typeof(v->'snapshot') <> 'array' OR jsonb_array_length(v->'players') <> 1 OR jsonb_array_length(v->'answers') <> 1 THEN RAISE EXCEPTION 'T2 analytics payload wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_manager_session_analytics(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T2 analytics(other-tenant) NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_manager_session_analytics(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T2 analytics(learner) NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '2. manager_session_analytics authz + payload: PASS';

  -- 3. active_sessions: MA(orgAdmin tA) sees S2 (active) not S (completed); learner L sees []; no snapshot key.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_manager_active_sessions(tA);
  IF NOT (v @> jsonb_build_array(jsonb_build_object('id', S2::text)) ) THEN
    IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'id' = S2::text) THEN RAISE EXCEPTION 'T3 active missing S2'; END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'id' = S::text) THEN RAISE EXCEPTION 'T3 active wrongly included completed S'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e ? 'question_snapshot') THEN RAISE EXCEPTION 'T3 active leaked question_snapshot'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF public.rpc_manager_active_sessions(tA) <> '[]'::jsonb THEN RAISE EXCEPTION 'T3 active(learner) not empty'; END IF;
  RESET ROLE;
  RAISE NOTICE '3. active_sessions scope + no-snapshot + learner-empty: PASS';

  -- 4. session_history: MA sees completed S; learner L sees [].
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_manager_session_history(tA, 20);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e->>'id' = S::text) THEN RAISE EXCEPTION 'T4 history missing completed S'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e ? 'question_snapshot') THEN RAISE EXCEPTION 'T4 history leaked question_snapshot'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF public.rpc_manager_session_history(tA,20) <> '[]'::jsonb THEN RAISE EXCEPTION 'T4 history(learner) not empty'; END IF;
  RESET ROLE;
  RAISE NOTICE '4. session_history scope + no-snapshot + learner-empty: PASS';

  -- 5. player_counts: manager MA → {S:1}; participant L → {S:1}; non-participant X → {}; other-tenant MB → {}.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_session_player_counts(ARRAY[S]) ->> S::text) <> '1' THEN RAISE EXCEPTION 'T5 counts(manager) wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF (public.rpc_session_player_counts(ARRAY[S]) ->> S::text) <> '1' THEN RAISE EXCEPTION 'T5 counts(participant) wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075006","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF public.rpc_session_player_counts(ARRAY[S]) <> '{}'::jsonb THEN RAISE EXCEPTION 'T5 counts(non-participant) leaked'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF public.rpc_session_player_counts(ARRAY[S]) <> '{}'::jsonb THEN RAISE EXCEPTION 'T5 counts(other-tenant) leaked'; END IF;
  RESET ROLE;
  RAISE NOTICE '5. player_counts manager+participant only: PASS';

  -- 6. lobby_participants: host ok; participant L ok; non-participant X denied; other-tenant MB denied; anon denied.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF jsonb_array_length(public.rpc_lobby_participants(S)) <> 1 THEN RAISE EXCEPTION 'T6 lobby(host) wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075005","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF jsonb_array_length(public.rpc_lobby_participants(S)) <> 1 THEN RAISE EXCEPTION 'T6 lobby(participant) wrong'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075006","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_lobby_participants(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T6 lobby(non-participant) NOT denied'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000075003","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_lobby_participants(S); ok:=true; EXCEPTION WHEN OTHERS THEN ok:=false; END; IF ok THEN RAISE EXCEPTION 'T6 lobby(other-tenant) NOT denied'; END IF;
  RESET ROLE;
  RAISE NOTICE '6. lobby_participants host/manager/participant only: PASS';

  RAISE NOTICE '075 ALL TESTS PASSED';
END $$;

ROLLBACK;
