-- Real-JWT test for migration 081 (Ralli Live durable scoreboard recovery).
-- SELF-CONTAINED: recreates the 081 publish + phase + end + player-restore supersets in a
-- transaction, seeds ephemeral tenants/users/quizzes/sessions/participants, exercises publish /
-- authorization / identity / version / restore / cleanup under real request.jwt.claims, asserts,
-- then ROLLS BACK. Expect "081 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- 081 additive columns (rolled back with the rest; required so the recreated function %ROWTYPEs
-- resolve the new fields — production does not have them until 081 is applied).
ALTER TABLE public.game_sessions
  ADD COLUMN IF NOT EXISTS live_scoreboard         jsonb,
  ADD COLUMN IF NOT EXISTS scoreboard_version      bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scoreboard_published_at timestamptz;

-- ── 081 publish RPC (verbatim) ──
CREATE OR REPLACE FUNCTION public.rpc_publish_scoreboard(p_session_id uuid, p_qidx integer, p_scores jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_new_version bigint; v_now timestamptz := now(); v_entries jsonb; v_unknown int; v_payload jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id' USING ERRCODE='no_data_found'; END IF;
  IF p_scores IS NULL OR jsonb_typeof(p_scores)<>'array' THEN RAISE EXCEPTION 'scores' USING ERRCODE='check_violation'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status<>'started' THEN RAISE EXCEPTION 'not started (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  IF v_s.phase IS DISTINCT FROM 'question' AND v_s.phase IS DISTINCT FROM 'reveal' AND v_s.phase IS DISTINCT FROM 'open-review' THEN
    RAISE EXCEPTION 'phase (%)',v_s.phase USING ERRCODE='check_violation'; END IF;
  IF p_qidx IS DISTINCT FROM v_s.current_question_index THEN RAISE EXCEPTION 'qidx (%/%)',p_qidx,v_s.current_question_index USING ERRCODE='check_violation'; END IF;
  SELECT count(*) INTO v_unknown FROM jsonb_array_elements(p_scores) e
   WHERE NOT EXISTS (SELECT 1 FROM public.game_session_participants gsp WHERE gsp.session_id=v_s.id AND gsp.player_id=(e->>'id'));
  IF v_unknown>0 THEN RAISE EXCEPTION 'unknown % ids',v_unknown USING ERRCODE='check_violation'; END IF;
  WITH input AS (SELECT (e->>'id') AS id, COALESCE((e->>'score')::numeric,0) AS score, COALESCE((e->>'delta')::numeric,0) AS delta FROM jsonb_array_elements(p_scores) e),
  resolved AS (SELECT gsp.player_id AS id, gsp.name AS name, gsp.emoji AS emoji, i.score::bigint AS score, i.delta::bigint AS delta
               FROM input i JOIN public.game_session_participants gsp ON gsp.session_id=v_s.id AND gsp.player_id=i.id),
  ranked AS (SELECT id,name,emoji,score,delta, rank() OVER (ORDER BY score DESC) AS rank,
                    row_number() OVER (ORDER BY score DESC, lower(coalesce(name,'')) ASC, id ASC) AS ord FROM resolved)
  SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'emoji',emoji,'score',score,'delta',delta,'rank',rank) ORDER BY ord) INTO v_entries FROM ranked;
  v_entries := COALESCE(v_entries,'[]'::jsonb);
  v_new_version := v_s.scoreboard_version + 1;
  v_payload := jsonb_build_object('session_id',v_s.id,'q_idx',v_s.current_question_index,'version',v_new_version,'published_at',v_now,'entries',v_entries);
  UPDATE public.game_sessions SET phase='scoreboard', live_scoreboard=v_payload, scoreboard_version=v_new_version, scoreboard_published_at=v_now WHERE id=v_s.id;
  RETURN v_payload;
END; $function$;

-- ── 081 phase superset (clear-on-leave) ──
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status IN ('completed','canceled','ended') THEN RAISE EXCEPTION 'immutable' USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET phase=p_phase,
    current_question_index=CASE WHEN p_set_cqi THEN p_cqi ELSE current_question_index END,
    paused=CASE WHEN p_set_paused THEN p_paused ELSE paused END,
    live_question=CASE WHEN p_set_live THEN p_live_question ELSE live_question END,
    live_scoreboard=CASE WHEN p_phase<>'scoreboard' THEN NULL ELSE live_scoreboard END,
    scoreboard_version=CASE WHEN p_phase<>'scoreboard' AND live_scoreboard IS NOT NULL THEN scoreboard_version+1 ELSE scoreboard_version END
  WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true);
END; $function$;

-- ── 081 end superset (clear) ──
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.status<>'started' THEN RAISE EXCEPTION 'not endable' USING ERRCODE='check_violation'; END IF;
  UPDATE public.game_sessions SET status='completed', ended_at=now(), live_scoreboard=NULL,
    scoreboard_version=scoreboard_version+CASE WHEN live_scoreboard IS NOT NULL THEN 1 ELSE 0 END WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true);
END; $function$;

-- ── 081 player restore superset (returns scoreboard while phase='scoreboard') ──
CREATE OR REPLACE FUNCTION public.rpc_player_session_restore(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_session public.game_sessions%ROWTYPE; v_uid text := auth.uid()::text; v_my_tenant text := (public.get_my_tenant_id())::text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth'; END IF;
  SELECT * INTO v_session FROM public.game_sessions WHERE id=p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'nf'; END IF;
  IF NOT ((v_session.tenant_id IS NULL OR (v_my_tenant IS NOT NULL AND v_session.tenant_id=v_my_tenant))
    AND (EXISTS (SELECT 1 FROM public.game_session_participants gsp WHERE gsp.session_id=p_session_id AND gsp.player_id=v_uid)
      OR EXISTS (SELECT 1 FROM public.game_answers ga WHERE ga.session_id=p_session_id AND ga.player_id=v_uid))) THEN
    RAISE EXCEPTION 'not a participant'; END IF;
  RETURN jsonb_build_object('session', jsonb_build_object(
    'id',v_session.id,'phase',v_session.phase,'current_question_index',v_session.current_question_index,'status',v_session.status,
    'live_scoreboard', CASE WHEN v_session.phase='scoreboard' THEN v_session.live_scoreboard ELSE NULL END,
    'scoreboard_version', v_session.scoreboard_version), 'my_answers','[]'::jsonb);
END; $function$;

-- ── Seed ──
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000810a0','r81_ta','R81 A'),('00000000-0000-0000-0000-0000000810b0','r81_tb','R81 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000081001','authenticated','authenticated','h81@t.test',now(),now()),   -- host (orgAdmin A)
 ('00000000-0000-0000-0000-000000081002','authenticated','authenticated','p1@t.test',now(),now()),     -- player 1
 ('00000000-0000-0000-0000-000000081003','authenticated','authenticated','p2@t.test',now(),now()),     -- player 2
 ('00000000-0000-0000-0000-000000081004','authenticated','authenticated','out@t.test',now(),now()),    -- non-participant (A)
 ('00000000-0000-0000-0000-000000081005','authenticated','authenticated','mgrb@t.test',now(),now());   -- cross-tenant manager (B)
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id='00000000-0000-0000-0000-000000081001';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000810a0', status='active' WHERE id IN ('00000000-0000-0000-0000-000000081002','00000000-0000-0000-0000-000000081003','00000000-0000-0000-0000-000000081004');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000810b0', status='active' WHERE id='00000000-0000-0000-0000-000000081005';
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-0000000810a0','QA','[]'::jsonb,'active',false,now(),now());
-- started session S1 (host, tenant A), phase='reveal', cqi=0; demo session SD; other session S2
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-0000000810a0','00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-000000081001','810011','S1','started',3,false,'reveal',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100e2','00000000-0000-0000-0000-0000000810a0','00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-000000081001','810022','S2','started',3,false,'reveal',0,'[{"q":1}]'::jsonb),
 ('00000000-0000-0000-0000-0000008100ed','00000000-0000-0000-0000-0000000810a0','00000000-0000-0000-0000-0000008100a1','00000000-0000-0000-0000-000000081001','810033','SD','started',3,true ,'reveal',0,'[{"q":1}]'::jsonb);
-- participants: p1 (null avatar), p2 (emoji) in S1; p1 also in S2
INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at) VALUES
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-000000081002','00000000-0000-0000-0000-0000000810a0','Ann', NULL, '#111','active',now(),now()),
 ('00000000-0000-0000-0000-0000008100e1','00000000-0000-0000-0000-000000081003','00000000-0000-0000-0000-0000000810a0','Bob', '🦊','#222','active',now(),now()),
 ('00000000-0000-0000-0000-0000008100e2','00000000-0000-0000-0000-000000081002','00000000-0000-0000-0000-0000000810a0','Ann2','🐯','#333','active',now(),now());

DO $$
DECLARE v jsonb; ok boolean; st text; ver bigint; sb jsonb; n int;
  h text := '00000000-0000-0000-0000-000000081001'; p1 text := '00000000-0000-0000-0000-000000081002';
  p2 text := '00000000-0000-0000-0000-000000081003'; outp text := '00000000-0000-0000-0000-000000081004';
  mgrb text := '00000000-0000-0000-0000-000000081005';
  s1 uuid := '00000000-0000-0000-0000-0000008100e1'; s2 uuid := '00000000-0000-0000-0000-0000008100e2'; sd uuid := '00000000-0000-0000-0000-0000008100ed';
  sc jsonb := '[{"id":"00000000-0000-0000-0000-000000081002","score":100,"delta":50},{"id":"00000000-0000-0000-0000-000000081003","score":100,"delta":20}]'::jsonb;
BEGIN
  -- 1. authorized host publishes → phase=scoreboard, version=1, resolved entries
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_publish_scoreboard(s1, 0, sc);
  RESET ROLE;
  IF (v->>'version')<>'1' THEN RAISE EXCEPTION 'T1 version not 1 (%)',v; END IF;
  IF jsonb_array_length(v->'entries')<>2 THEN RAISE EXCEPTION 'T1 entries!=2'; END IF;
  SELECT phase, scoreboard_version INTO st, ver FROM public.game_sessions WHERE id=s1;
  IF st<>'scoreboard' OR ver<>1 THEN RAISE EXCEPTION 'T1 durable not set (%,%)',st,ver; END IF;
  -- 9/12/10/11 identity + tie: both score 100 → rank 1 & 1; names server-resolved; Ann avatar null
  IF NOT (v->'entries'->0->>'rank'='1' AND v->'entries'->1->>'rank'='1') THEN RAISE EXCEPTION 'T11 tie rank not equal (%)',v; END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'entries') e WHERE e->>'name'='Ann' AND e->>'emoji' IS NULL) THEN RAISE EXCEPTION 'T10/12 Ann null-avatar server name missing'; END IF;
  -- 14. no answer/solution keys in payload
  IF (v::text) ~* '(answer|is_correct|correct|solution|snapshot|question_snapshot)' THEN RAISE EXCEPTION 'T14 payload leaked answer/solution data'; END IF;
  RAISE NOTICE 'T1/9/10/11/12/14 authorized publish + server identity + tie rank + no-leak: PASS';

  -- 8. version increments exactly once per publish. Re-publishing from the scoreboard phase is
  --    correctly rejected (phase guard), so advance to the NEXT question's reveal, then publish → 2.
  UPDATE public.game_sessions SET phase='reveal', current_question_index=1 WHERE id=s1;   -- direct (test)
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_publish_scoreboard(s1, 1, sc); RESET ROLE;
  IF (v->>'version')<>'2' THEN RAISE EXCEPTION 'T8 version not 2 (%)',v; END IF;
  RAISE NOTICE 'T8 version increments once per publish (next-question republish): PASS';

  -- 15. learner participant restore returns the exact scoreboard (phase=scoreboard)
  PERFORM set_config('request.jwt.claims','{"sub":"'||p1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_player_session_restore(s1); RESET ROLE;
  IF (v->'session'->'live_scoreboard') IS NULL OR (v->'session'->'live_scoreboard'->>'version')<>'2' THEN RAISE EXCEPTION 'T15 learner restore missing scoreboard (%)',v; END IF;
  RAISE NOTICE 'T15 learner participant restore returns exact scoreboard: PASS';

  -- 16. non-participant cannot restore
  PERFORM set_config('request.jwt.claims','{"sub":"'||outp||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_player_session_restore(s1); ok:=true; EXCEPTION WHEN OTHERS THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T16 non-participant restore NOT rejected'; END IF;
  RAISE NOTICE 'T16 non-participant cannot restore: PASS';

  -- 3. learner cannot publish
  PERFORM set_config('request.jwt.claims','{"sub":"'||p1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T3 learner publish NOT rejected'; END IF;
  -- 21. cross-tenant manager cannot publish
  PERFORM set_config('request.jwt.claims','{"sub":"'||mgrb||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T21 cross-tenant manager publish NOT rejected'; END IF;
  RAISE NOTICE 'T3/T21 learner + cross-tenant manager cannot publish: PASS';

  -- next: reset s1 to reveal @ q0 for the negative-input cases (still started)
  UPDATE public.game_sessions SET phase='reveal', current_question_index=0 WHERE id=s1;
  -- 6. wrong qIdx rejected
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,5,sc); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'T6 wrong qIdx NOT rejected'; END IF;
  -- 4/7. unknown participant id rejected (id from another session's player added)
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,'[{"id":"00000000-0000-0000-0000-000000081004","score":10}]'::jsonb); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'T4 unknown participant NOT rejected'; END IF;
  RESET ROLE;
  -- 7b. wrong phase rejected (move s1 to countdown then publish)
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  UPDATE public.game_sessions SET phase='countdown' WHERE id=s1;   -- direct (host owns)
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(s1,0,sc); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'T7 wrong-phase publish NOT rejected'; END IF;
  RESET ROLE;
  RAISE NOTICE 'T4/T6/T7 unknown-id / wrong-qidx / wrong-phase rejected: PASS';

  -- 20. demo isolation: publish on demo session rejected
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_publish_scoreboard(sd,0,'[]'::jsonb); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'T20 demo publish NOT rejected'; END IF;
  RAISE NOTICE 'T20 demo scoreboard publish rejected (isolated): PASS';

  -- 19. next-question (set phase) clears live_scoreboard + bumps version
  -- publish fresh on s2, then move to countdown → cleared
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM rpc_publish_scoreboard(s2,0,'[{"id":"00000000-0000-0000-0000-000000081002","score":10}]'::jsonb);
  SELECT scoreboard_version INTO ver FROM public.game_sessions WHERE id=s2;
  PERFORM rpc_set_session_phase(s2,'countdown',true,1,false,false,false,NULL);
  RESET ROLE;
  SELECT live_scoreboard, scoreboard_version INTO sb, n FROM public.game_sessions WHERE id=s2;
  IF sb IS NOT NULL THEN RAISE EXCEPTION 'T19 next-question did not clear scoreboard'; END IF;
  IF n <= ver THEN RAISE EXCEPTION 'T19 version not bumped on clear (%,%)',n,ver; END IF;
  RAISE NOTICE 'T19 next-question phase change clears + bumps version: PASS';

  -- 20b/legacy: restore on a non-scoreboard session returns null scoreboard (honest degrade)
  PERFORM set_config('request.jwt.claims','{"sub":"'||p1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_player_session_restore(s2); RESET ROLE;   -- s2 now countdown
  IF (v->'session'->'live_scoreboard') IS NOT NULL AND jsonb_typeof(v->'session'->'live_scoreboard')<>'null' THEN RAISE EXCEPTION 'T22 stale/legacy restore leaked scoreboard (%)',v; END IF;
  RAISE NOTICE 'T22 stale/legacy (non-scoreboard) restore returns null scoreboard: PASS';

  -- 16b. end clears the durable scoreboard
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  UPDATE public.game_sessions SET phase='reveal' WHERE id=s1; UPDATE public.game_sessions SET status='started' WHERE id=s1;
  PERFORM rpc_publish_scoreboard(s1,0,sc);
  PERFORM rpc_end_session(s1);
  RESET ROLE;
  SELECT status, live_scoreboard INTO st, sb FROM public.game_sessions WHERE id=s1;
  IF st<>'completed' OR sb IS NOT NULL THEN RAISE EXCEPTION 'T-end did not clear scoreboard (%,%)',st,sb; END IF;
  RAISE NOTICE 'T-end game end clears durable scoreboard: PASS';

  RAISE NOTICE '081 ALL TESTS PASSED';
END $$;

SELECT (to_regprocedure('public.rpc_publish_scoreboard(uuid,integer,jsonb)') IS NOT NULL) AS fns_ok;
ROLLBACK;
