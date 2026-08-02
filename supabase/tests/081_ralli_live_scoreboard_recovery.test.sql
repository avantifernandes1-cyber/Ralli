-- Real-JWT test for migration 081 (Ralli Live durable scoreboard recovery), rolled back.
-- Recreates the 081 publish (idempotent, locked, hardened) + phase + end + player-restore supersets,
-- seeds ephemeral fixtures, exercises publish / authz / identity / version / idempotency / input /
-- restore / cleanup under real request.jwt.claims, asserts, then ROLLS BACK. Expect "081 ALL TESTS
-- PASSED". (True two-connection idempotency/locking is proven separately by
-- supabase/tests/concurrency/081_scoreboard_concurrency_run.sh against the exact committed artifact.)
\set ON_ERROR_STOP on
BEGIN;
ALTER TABLE public.game_sessions
  ADD COLUMN IF NOT EXISTS live_scoreboard jsonb,
  ADD COLUMN IF NOT EXISTS scoreboard_version bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scoreboard_published_at timestamptz;

CREATE OR REPLACE FUNCTION public.rpc_publish_scoreboard(p_session_id uuid, p_qidx integer, p_scores jsonb, p_publish_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_new_version bigint; v_now timestamptz := now();
        v_entries jsonb; v_bad int; v_total int; v_distinct int; v_payload jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id' USING ERRCODE='no_data_found'; END IF;
  IF p_publish_key IS NULL OR length(p_publish_key)<8 OR length(p_publish_key)>200 THEN RAISE EXCEPTION 'key' USING ERRCODE='check_violation'; END IF;
  IF p_scores IS NULL OR jsonb_typeof(p_scores)<>'array' THEN RAISE EXCEPTION 'scores' USING ERRCODE='check_violation'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.phase='scoreboard' AND v_s.live_scoreboard IS NOT NULL AND (v_s.live_scoreboard->>'q_idx')::int=p_qidx AND (v_s.live_scoreboard->>'publish_key')=p_publish_key THEN
    RETURN v_s.live_scoreboard; END IF;
  IF v_s.phase='scoreboard' AND v_s.live_scoreboard IS NOT NULL THEN RAISE EXCEPTION 'already published' USING ERRCODE='check_violation'; END IF;
  IF v_s.status<>'started' THEN RAISE EXCEPTION 'not started' USING ERRCODE='check_violation'; END IF;
  IF v_s.phase IS DISTINCT FROM 'question' AND v_s.phase IS DISTINCT FROM 'reveal' AND v_s.phase IS DISTINCT FROM 'open-review' THEN RAISE EXCEPTION 'phase' USING ERRCODE='check_violation'; END IF;
  IF p_qidx IS DISTINCT FROM v_s.current_question_index THEN RAISE EXCEPTION 'qidx' USING ERRCODE='check_violation'; END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_scores) e
   WHERE jsonb_typeof(e)<>'object' OR (e->>'id') IS NULL OR jsonb_typeof(e->'score')<>'number'
      OR (e->>'score')::numeric<0 OR (e->>'score')::numeric<>floor((e->>'score')::numeric) OR (e->>'score')::numeric>1000000000000000
      OR (e ? 'delta' AND jsonb_typeof(e->'delta')='number' AND ((e->>'delta')::numeric<0 OR (e->>'delta')::numeric<>floor((e->>'delta')::numeric)))
      OR (e ? 'delta' AND jsonb_typeof(e->'delta')<>'number' AND jsonb_typeof(e->'delta')<>'null');
  IF v_bad>0 THEN RAISE EXCEPTION 'malformed' USING ERRCODE='check_violation'; END IF;
  SELECT count(*), count(DISTINCT (e->>'id')) INTO v_total, v_distinct FROM jsonb_array_elements(p_scores) e;
  IF v_total<>v_distinct THEN RAISE EXCEPTION 'duplicate ids' USING ERRCODE='check_violation'; END IF;
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_scores) e WHERE NOT EXISTS (SELECT 1 FROM public.game_session_participants gsp WHERE gsp.session_id=v_s.id AND gsp.player_id=(e->>'id'));
  IF v_bad>0 THEN RAISE EXCEPTION 'unknown id' USING ERRCODE='check_violation'; END IF;
  WITH input AS (SELECT (e->>'id') AS id, (e->>'score')::bigint AS score, COALESCE((e->>'delta')::bigint,0) AS delta FROM jsonb_array_elements(p_scores) e),
  resolved AS (SELECT gsp.player_id AS id, gsp.name AS name, gsp.emoji AS emoji, i.score, i.delta FROM input i JOIN public.game_session_participants gsp ON gsp.session_id=v_s.id AND gsp.player_id=i.id),
  ranked AS (SELECT id,name,emoji,score,delta, rank() OVER (ORDER BY score DESC) AS rank, row_number() OVER (ORDER BY score DESC, lower(coalesce(name,'')) ASC, id ASC) AS ord FROM resolved)
  SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'emoji',emoji,'score',score,'delta',delta,'rank',rank) ORDER BY ord) INTO v_entries FROM ranked;
  v_entries := COALESCE(v_entries,'[]'::jsonb);
  v_new_version := v_s.scoreboard_version+1;
  v_payload := jsonb_build_object('session_id',v_s.id,'q_idx',v_s.current_question_index,'version',v_new_version,'published_at',v_now,'publish_key',p_publish_key,'entries',v_entries);
  UPDATE public.game_sessions SET phase='scoreboard', live_scoreboard=v_payload, scoreboard_version=v_new_version, scoreboard_published_at=v_now WHERE id=v_s.id;
  RETURN v_payload;
END; $function$;
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status IN ('completed','canceled','ended') THEN RAISE EXCEPTION 'immutable' USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET phase=p_phase,
    current_question_index=CASE WHEN p_set_cqi THEN p_cqi ELSE current_question_index END,
    live_scoreboard=CASE WHEN p_phase<>'scoreboard' THEN NULL ELSE live_scoreboard END,
    scoreboard_version=CASE WHEN p_phase<>'scoreboard' AND live_scoreboard IS NOT NULL THEN scoreboard_version+1 ELSE scoreboard_version END
  WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true);
END; $function$;
CREATE OR REPLACE FUNCTION public.rpc_player_session_restore(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_session public.game_sessions%ROWTYPE; v_uid text := auth.uid()::text; v_my_tenant text := (public.get_my_tenant_id())::text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth'; END IF;
  SELECT * INTO v_session FROM public.game_sessions WHERE id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'nf'; END IF;
  IF NOT ((v_session.tenant_id IS NULL OR (v_my_tenant IS NOT NULL AND v_session.tenant_id=v_my_tenant))
    AND (EXISTS (SELECT 1 FROM public.game_session_participants gsp WHERE gsp.session_id=p_session_id AND gsp.player_id=v_uid)
      OR EXISTS (SELECT 1 FROM public.game_answers ga WHERE ga.session_id=p_session_id AND ga.player_id=v_uid))) THEN RAISE EXCEPTION 'not a participant'; END IF;
  RETURN jsonb_build_object('session', jsonb_build_object('id',v_session.id,'phase',v_session.phase,'status',v_session.status,
    'live_scoreboard', CASE WHEN v_session.phase='scoreboard' THEN v_session.live_scoreboard ELSE NULL END,
    'scoreboard_version', v_session.scoreboard_version), 'my_answers','[]'::jsonb);
END; $function$;

INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000810a0','r81_ta','R81 A'),('00000000-0000-0000-0000-0000000810b0','r81_tb','R81 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000081001','authenticated','authenticated','h81@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081002','authenticated','authenticated','p1@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081003','authenticated','authenticated','p2@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000081004','authenticated','authenticated','out@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081001';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id IN ('00000000-0000-0000-0000-000000081002','00000000-0000-0000-0000-000000081003','00000000-0000-0000-0000-000000081004');
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, created_at, updated_at) VALUES ('00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-0000000810a0','QA','[]'::jsonb,'active',false,now(),now());
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-0000000810a0','00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-000000081001','810011','S1','started',3,false,'reveal',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100ed','00000000-0000-0000-0000-0000000810a0','00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-000000081001','810033','SD','started',3,true ,'reveal',0,'[{"q":1}]'::jsonb);
INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at) VALUES
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-000000081002','00000000-0000-0000-0000-0000000810a0','Ann', NULL, '#111','active',now(),now()),
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-000000081003','00000000-0000-0000-0000-0000000810a0','Bob', 'X','#222','active',now(),now());

DO $$
DECLARE v jsonb; ok boolean; st text; ver bigint;
  h text := '00000000-0000-0000-0000-000000081001'; p1 text := '00000000-0000-0000-0000-000000081002'; outp text := '00000000-0000-0000-0000-000000081004';
  s1 uuid := '00000000-0000-0000-0000-0000008100e1'; sd uuid := '00000000-0000-0000-0000-0000008100ed';
  sc jsonb := '[{"id":"00000000-0000-0000-0000-000000081002","score":100,"delta":50},{"id":"00000000-0000-0000-0000-000000081003","score":100,"delta":20}]'::jsonb;
  K text := 'EPISODE-KEY-1';
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_publish_scoreboard(s1,0,sc,K); RESET ROLE;
  IF (v->>'version')<>'1' OR jsonb_array_length(v->'entries')<>2 THEN RAISE EXCEPTION 'T1 publish (%)',v; END IF;
  IF NOT (v->'entries'->0->>'rank'='1' AND v->'entries'->1->>'rank'='1') THEN RAISE EXCEPTION 'T-tie'; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'entries') e WHERE e->>'name'='Ann' AND e->>'emoji' IS NULL) THEN RAISE EXCEPTION 'T-nullavatar'; END IF;
  IF (v::text) ~* '(is_correct|solution|snapshot|answer_text)' THEN RAISE EXCEPTION 'T-leak'; END IF;
  -- idempotent same-key retry → same board, version unchanged
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_publish_scoreboard(s1,0,sc,K); RESET ROLE;
  IF (v->>'version')<>'1' THEN RAISE EXCEPTION 'T-idem version bumped (%)',v; END IF;
  SELECT scoreboard_version INTO ver FROM public.game_sessions WHERE id=s1; IF ver<>1 THEN RAISE EXCEPTION 'T-idem durable version (%)',ver; END IF;
  -- different key after publication → rejected
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc,'EPISODE-KEY-2'); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T-diffkey not rejected'; END IF;
  RAISE NOTICE 'T1/tie/nullavatar/no-leak/idempotent-same-key/different-key-rejected: PASS';

  -- learner restore returns exact board
  PERFORM set_config('request.jwt.claims','{"sub":"'||p1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_player_session_restore(s1); RESET ROLE;
  IF (v->'session'->'live_scoreboard'->>'version')<>'1' THEN RAISE EXCEPTION 'T-restore (%)',v; END IF;
  -- non-participant restore rejected
  PERFORM set_config('request.jwt.claims','{"sub":"'||outp||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_player_session_restore(s1); ok:=true; EXCEPTION WHEN OTHERS THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T-nonparticipant restore'; END IF;
  RAISE NOTICE 'T-restore participant / non-participant: PASS';

  -- learner cannot publish; short key rejected; negative + duplicate + unknown + wrong-qidx rejected
  UPDATE public.game_sessions SET phase='reveal', live_scoreboard=NULL WHERE id=s1;
  PERFORM set_config('request.jwt.claims','{"sub":"'||p1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc,K); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T-learner publish'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc,'short'); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-shortkey'; END IF;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,'[{"id":"00000000-0000-0000-0000-000000081002","score":-5}]'::jsonb,K); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-negative'; END IF;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,'[{"id":"00000000-0000-0000-0000-000000081002","score":5},{"id":"00000000-0000-0000-0000-000000081002","score":6}]'::jsonb,K); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-duplicate'; END IF;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,'[{"id":"00000000-0000-0000-0000-000000081004","score":5}]'::jsonb,K); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-unknown'; END IF;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,9,sc,K); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-qidx'; END IF;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(sd,0,'[]'::jsonb,K); ok:=true; EXCEPTION WHEN check_violation THEN END; IF ok THEN RAISE EXCEPTION 'T-demo'; END IF;
  RESET ROLE;
  RAISE NOTICE 'T-authz/shortkey/negative/duplicate/unknown/qidx/demo rejected: PASS';

  -- next-question clears; then publish retry cannot resurrect (phase not publishable + no board)
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM rpc_publish_scoreboard(s1,0,sc,K);
  PERFORM rpc_set_session_phase(s1,'countdown',true,1,false,false,false,NULL);
  RESET ROLE;
  SELECT live_scoreboard IS NULL INTO ok FROM public.game_sessions WHERE id=s1; IF NOT ok THEN RAISE EXCEPTION 'T-clear'; END IF;
  RAISE NOTICE 'T-next-question clears board: PASS';

  RAISE NOTICE '081 ALL TESTS PASSED';
END $$;
SELECT (to_regprocedure('public.rpc_publish_scoreboard(uuid,integer,jsonb,text)') IS NOT NULL) AS fns_ok;
ROLLBACK;
