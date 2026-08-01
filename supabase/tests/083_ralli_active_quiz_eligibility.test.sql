-- Real-JWT test for migration 083 (Ralli Live active-quiz eligibility).
-- SELF-CONTAINED: recreates the two 083 function supersets in a transaction, seeds ephemeral
-- tenants/users/quizzes/sessions, exercises create + start under real request.jwt.claims, asserts,
-- then ROLLS BACK. Expect "083 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── 083 function supersets (verbatim from migration 083) ──
CREATE OR REPLACE FUNCTION public.create_game_session_atomic(
  p_tenant_id text, p_host_id text, p_quiz_id text, p_name text, p_question_count integer, p_demo_mode boolean DEFAULT false)
RETURNS game_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_tenant text; v_code text; v_row game_sessions; v_attempt integer := 0;
BEGIN
  v_tenant := get_my_tenant_id()::text;
  IF p_demo_mode IS DISTINCT FROM true THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=p_quiz_id AND q.tenant_id::text=v_tenant AND q.status='active') THEN
      RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE='check_violation', DETAIL='quiz is archived, not found, or not in tenant';
    END IF;
  END IF;
  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad(floor(random()*1000000)::text,6,'0');
    BEGIN
      INSERT INTO game_sessions (tenant_id, quiz_id, host_id, pin, name, question_count, demo_mode, status)
      VALUES (v_tenant, p_quiz_id, p_host_id, v_code, p_name, p_question_count, p_demo_mode, 'waiting')
      RETURNING * INTO v_row;
      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN IF v_attempt>=8 THEN RAISE EXCEPTION 'code alloc failed'; END IF; END;
  END LOOP;
END; $function$;

CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status <> 'waiting' THEN RAISE EXCEPTION 'not startable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  IF v_s.question_snapshot IS NULL THEN RAISE EXCEPTION 'no snapshot' USING ERRCODE='check_violation'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=v_s.quiz_id AND q.tenant_id::text=v_s.tenant_id AND q.status='active') THEN
    UPDATE public.game_sessions SET status='canceled', ended_at=now(), live_question=NULL WHERE id=v_s.id AND status='waiting';
    RETURN jsonb_build_object('ok',false,'reason','quiz_unavailable','session_id',v_s.id);
  END IF;
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id=v_s.id;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $function$;

-- ── Seed ──
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000830a0','r83_ta','R83 A'),('00000000-0000-0000-0000-0000000830b0','r83_tb','R83 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000083001','authenticated','authenticated','h83@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000083002','authenticated','authenticated','l83@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000830a0', status='active' WHERE id='00000000-0000-0000-0000-000000083001';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000830a0', status='active' WHERE id='00000000-0000-0000-0000-000000083002';
-- quizzes: QA active(A), QX archived(A), QB active(B), QS active(A) for archive-after-create,
-- QH active(A) for the historical case.
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000008300a1','00000000-0000-0000-0000-0000000830a0','QA','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-0000000830a0','QX','[]'::jsonb,'archived',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300b1','00000000-0000-0000-0000-0000000830b0','QB','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a3','00000000-0000-0000-0000-0000000830a0','QS','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a4','00000000-0000-0000-0000-0000000830a0','QH','[]'::jsonb,'active',false,now(),now());
-- historical COMPLETED session using QH (created while QH active)
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot) VALUES
 ('00000000-0000-0000-0000-0000008300f9','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a4','00000000-0000-0000-0000-000000083001','839999','HIST','completed',1,false,'ended',0,'[{"q":"frozen"}]'::jsonb);

DO $$
DECLARE v jsonb; ok boolean; sid uuid; n int; st text; snap jsonb;
  h text := '00000000-0000-0000-0000-000000083001';  -- host
  l text := '00000000-0000-0000-0000-000000083002';  -- learner
  qa text := '00000000-0000-0000-0000-0000008300a1'; qx text := '00000000-0000-0000-0000-0000008300a2';
  qb text := '00000000-0000-0000-0000-0000008300b1'; qs text := '00000000-0000-0000-0000-0000008300a3';
BEGIN
  -- 1. active quiz → create succeeds
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qa,'S1',1,false)).id INTO sid;
  IF sid IS NULL THEN RAISE EXCEPTION 'C1 active create failed'; END IF;
  -- 2. archived quiz → rejected, zero rows
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,qx,'S2',1,false); ok:=true; EXCEPTION WHEN check_violation THEN ok:=false; END;
  IF ok THEN RAISE EXCEPTION 'C2 archived create NOT rejected'; END IF;
  -- 3. unknown quiz → rejected
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,'00000000-0000-0000-0000-0000000839ff','S3',1,false); ok:=true; EXCEPTION WHEN check_violation THEN ok:=false; END;
  IF ok THEN RAISE EXCEPTION 'C3 unknown create NOT rejected'; END IF;
  -- 4. malformed id → honest rejection (check_violation, NOT invalid_text_representation raw cast)
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,'not-a-uuid','S4',1,false); ok:=true;
    EXCEPTION WHEN check_violation THEN ok:=false; WHEN invalid_text_representation THEN RAISE EXCEPTION 'C4 raw uuid-cast error leaked'; END;
  IF ok THEN RAISE EXCEPTION 'C4 malformed create NOT rejected'; END IF;
  -- 5. cross-tenant active quiz → rejected
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,qb,'S5',1,false); ok:=true; EXCEPTION WHEN check_violation THEN ok:=false; END;
  IF ok THEN RAISE EXCEPTION 'C5 cross-tenant create NOT rejected'; END IF;
  RESET ROLE;
  -- 6. a learner is still subject to the guard: archived quiz create rejected (role-gating of
  --    creation itself is out of 083 scope — UI-gated; not added here).
  PERFORM set_config('request.jwt.claims','{"sub":"'||l||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,l,qx,'S6',1,false); ok:=true; EXCEPTION WHEN check_violation THEN ok:=false; END;
  IF ok THEN RAISE EXCEPTION 'C6 learner archived create NOT rejected'; END IF;
  RESET ROLE;
  -- 7. demo create is unaffected (demo_mode=true skips the guard) — even an archived quiz id
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qx,'S7demo',1,true)).id INTO sid;
  IF sid IS NULL THEN RAISE EXCEPTION 'C7 demo create blocked (should be allowed)'; END IF;
  RESET ROLE;
  RAISE NOTICE '1-7 create guard (active ok / archived,unknown,malformed,cross-tenant rejected / learner-archived rejected / demo unaffected): PASS';

  -- 8. active create → snapshot → archive quiz → start → durable cancel, non-start result
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qs,'S8',1,false)).id INTO sid;
  RESET ROLE;
  UPDATE public.game_sessions SET question_snapshot='[{"q":1}]'::jsonb WHERE id=sid;      -- app snapshot write
  UPDATE public.tenant_quizzes SET status='archived' WHERE id=qs::uuid;                    -- quiz archived after create
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_start_session(sid);
  IF (v->>'ok')<>'false' OR (v->>'reason')<>'quiz_unavailable' THEN RAISE EXCEPTION 'C8 start not quiz_unavailable (%)',v; END IF;
  RESET ROLE;
  SELECT status INTO st FROM public.game_sessions WHERE id=sid;
  IF st<>'canceled' THEN RAISE EXCEPTION 'C8 session not durably canceled (%)',st; END IF;
  SELECT count(*) INTO n FROM public.game_answers WHERE session_id=sid; IF n<>0 THEN RAISE EXCEPTION 'C8 answers created'; END IF;
  SELECT count(*) INTO n FROM public.game_players WHERE session_id=sid;  IF n<>0 THEN RAISE EXCEPTION 'C8 scores created'; END IF;
  RAISE NOTICE '8. archive-after-create: start returns quiz_unavailable + session durably canceled + no answers/scores: PASS';

  -- 9. completed historical session whose quiz is later archived stays intact + snapshot unchanged
  UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000008300a4';
  SELECT status, question_snapshot INTO st, snap FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300f9';
  IF st<>'completed' THEN RAISE EXCEPTION 'C9 historical status changed (%)',st; END IF;
  IF snap<>'[{"q":"frozen"}]'::jsonb THEN RAISE EXCEPTION 'C9 historical snapshot changed'; END IF;
  RAISE NOTICE '9. completed historical session with later-archived quiz remains completed + snapshot immutable: PASS';

  -- 10. active quiz waiting session starts normally
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qa,'S10',1,false)).id INTO sid;
  RESET ROLE;
  UPDATE public.game_sessions SET question_snapshot='[{"q":1}]'::jsonb WHERE id=sid;
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_start_session(sid);
  IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'C10 active start not ok (%)',v; END IF;
  RESET ROLE;
  SELECT status INTO st FROM public.game_sessions WHERE id=sid; IF st<>'started' THEN RAISE EXCEPTION 'C10 not started'; END IF;
  RAISE NOTICE '10. active-quiz waiting session starts normally: PASS';

  RAISE NOTICE '083 ALL TESTS PASSED';
END $$;

SELECT (to_regprocedure('public.create_game_session_atomic(text,text,text,text,integer,boolean)') IS NOT NULL) AS fns_ok;
ROLLBACK;
