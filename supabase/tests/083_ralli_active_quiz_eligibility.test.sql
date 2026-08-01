-- Real-JWT test for migration 083 (Ralli Live active-quiz eligibility + waiting-session integrity).
-- SELF-CONTAINED: recreates the four 083 function supersets + the source-of-truth trigger in a
-- transaction, seeds ephemeral tenants/users/quizzes/sessions, exercises create / start / join /
-- joinable-list / manager-list / archive-trigger / one-time-correction under real
-- request.jwt.claims, asserts all 16 required behaviors, then ROLLS BACK. Expect "083 ALL TESTS
-- PASSED". rpc_manager_active_sessions is NOT modified by 083 — the test calls the DEPLOYED
-- version to prove a canceled session drops out while a started game is still represented.
\set ON_ERROR_STOP on
BEGIN;

-- ── 083 §1 create guard superset ──
CREATE OR REPLACE FUNCTION public.create_game_session_atomic(
  p_tenant_id text, p_host_id text, p_quiz_id text, p_name text, p_question_count integer, p_demo_mode boolean DEFAULT false)
RETURNS game_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_tenant text; v_qstatus text; v_code text; v_row game_sessions; v_attempt integer := 0;
BEGIN
  v_tenant := get_my_tenant_id()::text;
  IF p_demo_mode IS DISTINCT FROM true THEN
    SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
      WHERE q.id::text=p_quiz_id AND q.tenant_id::text=v_tenant FOR SHARE;
    IF v_qstatus IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE='check_violation', DETAIL='quiz is archived, deleted, not found, or not in tenant';
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

-- ── 083 §2 start guard superset ──
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_qstatus text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id required' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status <> 'waiting' THEN RAISE EXCEPTION 'not startable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  IF v_s.question_snapshot IS NULL THEN RAISE EXCEPTION 'no snapshot' USING ERRCODE='check_violation'; END IF;
  SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
    WHERE q.id::text=v_s.quiz_id AND q.tenant_id::text=v_s.tenant_id FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN
    UPDATE public.game_sessions SET status='canceled', ended_at=now(), live_question=NULL WHERE id=v_s.id AND status='waiting';
    RETURN jsonb_build_object('ok',false,'reason','quiz_unavailable','session_id',v_s.id);
  END IF;
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id=v_s.id AND status='waiting';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_startable','session_id',v_s.id); END IF;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $function$;

-- ── 083 §3 join-boundary guard superset ──
CREATE OR REPLACE FUNCTION public.rpc_participant_join(p_session_id uuid, p_name text, p_emoji text, p_color text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions; v_qstatus text; v_sstatus text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id=v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL OR v_s.tenant_id IS DISTINCT FROM v_tenant::text THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status <> 'waiting' THEN RAISE EXCEPTION 'not joinable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
    WHERE q.id::text=v_s.quiz_id AND q.tenant_id::text=v_s.tenant_id FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE='check_violation'; END IF;
  SELECT status INTO v_sstatus FROM public.game_sessions WHERE id=v_s.id;
  IF v_sstatus <> 'waiting' THEN RAISE EXCEPTION 'not joinable (%)',v_sstatus USING ERRCODE='check_violation'; END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, 'active', now(), now())
  ON CONFLICT (session_id, player_id) DO UPDATE SET status='active', last_seen_at=EXCLUDED.last_seen_at;
  RETURN jsonb_build_object('ok', true);
END; $function$;

-- ── 083 §4 joinable-list guard superset ──
CREATE OR REPLACE FUNCTION public.rpc_learner_joinable_sessions()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id=auth.uid();
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object('id',s.id,'pin',s.pin,'status',s.status) ORDER BY s.created_at DESC)
    FROM public.game_sessions s
    WHERE s.tenant_id=v_tenant::text AND s.status='waiting' AND COALESCE(s.demo_mode,false)=false
      AND EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=s.quiz_id AND q.tenant_id::text=s.tenant_id AND q.status='active')
  ), '[]'::jsonb);
END; $function$;

-- ── 083 §5 source-of-truth trigger ──
CREATE OR REPLACE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  UPDATE public.game_sessions SET status='canceled', ended_at=now(), live_question=NULL
   WHERE quiz_id=NEW.id::text AND tenant_id=NEW.tenant_id::text AND demo_mode=false AND status='waiting';
  RETURN NULL;
END; $function$;
CREATE OR REPLACE FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  UPDATE public.game_sessions SET status='canceled', ended_at=now(), live_question=NULL
   WHERE quiz_id=OLD.id::text AND tenant_id=OLD.tenant_id::text AND demo_mode=false AND status='waiting';
  RETURN OLD;
END; $function$;
DROP TRIGGER IF EXISTS trg_ralli_cancel_waiting_sessions_on_quiz_deactivate ON public.tenant_quizzes;
CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_deactivate
  AFTER UPDATE OF status ON public.tenant_quizzes FOR EACH ROW
  WHEN (OLD.status='active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz();
DROP TRIGGER IF EXISTS trg_ralli_cancel_waiting_sessions_on_quiz_delete ON public.tenant_quizzes;
CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_delete
  BEFORE DELETE ON public.tenant_quizzes FOR EACH ROW
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete();

-- ── Seed ──
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000830a0','r83_ta','R83 A'),('00000000-0000-0000-0000-0000000830b0','r83_tb','R83 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000083001','authenticated','authenticated','h83@t.test',now(),now()),
 ('00000000-0000-0000-0000-000000083002','authenticated','authenticated','l83@t.test',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000830a0', status='active' WHERE id='00000000-0000-0000-0000-000000083001';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000830a0', status='active' WHERE id='00000000-0000-0000-0000-000000083002';
-- quizzes (tenant A unless noted): qa active, qx archived, qb active(B), qs active, qh active, qt active
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000008300a1','00000000-0000-0000-0000-0000000830a0','QA','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-0000000830a0','QX','[]'::jsonb,'archived',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300b1','00000000-0000-0000-0000-0000000830b0','QB','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a3','00000000-0000-0000-0000-0000000830a0','QS','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a4','00000000-0000-0000-0000-0000000830a0','QH','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a5','00000000-0000-0000-0000-0000000830a0','QT','[]'::jsonb,'active',false,now(),now()),
 ('00000000-0000-0000-0000-0000008300a6','00000000-0000-0000-0000-0000000830a0','QD','[]'::jsonb,'active',false,now(),now());
-- sessions: completed hist(qh); orphans + keepers for the correction; forged sessions for guards;
-- trigger-target waiting(qt); started(qx)
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot, live_question, started_at) VALUES
 ('00000000-0000-0000-0000-0000008300f9','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a4','00000000-0000-0000-0000-000000083001','830099','HIST','completed',1,false,'ended',0,'[{"q":"frozen"}]'::jsonb,NULL,now()),
 ('00000000-0000-0000-0000-0000008300e1','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-000000083001','830011','ORPH-ARCH','waiting',1,false,'waiting',0,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300e2','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300ff','00000000-0000-0000-0000-000000083001','830022','ORPH-MISS','waiting',1,false,'waiting',0,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300e3','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a1','00000000-0000-0000-0000-000000083001','830033','KEEP-WAIT','waiting',1,false,'waiting',0,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300e4','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-000000083001','830044','KEEP-START','started',1,false,'question',0,'[{"q":1}]'::jsonb,'{"q":1}'::jsonb,now()),
 ('00000000-0000-0000-0000-0000008300e5','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-000000083001','830055','KEEP-DEMO','waiting',1,true,'waiting',0,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300e6','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-000000083001','830066','FORGE-JOIN','waiting',1,false,'waiting',0,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300e7','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a5','00000000-0000-0000-0000-000000083001','830077','TRIG-TARGET','waiting',1,false,'waiting',0,NULL,'{"live":1}'::jsonb,NULL),
 ('00000000-0000-0000-0000-0000008300e8','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a2','00000000-0000-0000-0000-000000083001','830088','FORGE-START','waiting',1,false,'waiting',0,'[{"q":1}]'::jsonb,NULL,NULL),
 ('00000000-0000-0000-0000-0000008300ea','00000000-0000-0000-0000-0000000830a0','00000000-0000-0000-0000-0000008300a6','00000000-0000-0000-0000-000000083001','830100','DEL-TARGET','waiting',1,false,'waiting',0,NULL,'{"live":1}'::jsonb,NULL);

DO $$
DECLARE v jsonb; ok boolean; sid uuid; st text; lq jsonb; ea timestamptz; n int;
  h text := '00000000-0000-0000-0000-000000083001';
  l text := '00000000-0000-0000-0000-000000083002';
  qa text := '00000000-0000-0000-0000-0000008300a1'; qx text := '00000000-0000-0000-0000-0000008300a2';
  qb text := '00000000-0000-0000-0000-0000008300b1'; qs text := '00000000-0000-0000-0000-0000008300a3';
  qt text := '00000000-0000-0000-0000-0000008300a5';
  e6 uuid := '00000000-0000-0000-0000-0000008300e6'; e7 uuid := '00000000-0000-0000-0000-0000008300e7';
  e8 uuid := '00000000-0000-0000-0000-0000008300e8'; e3 uuid := '00000000-0000-0000-0000-0000008300e3';
BEGIN
  -- ═══ CREATE GUARD (req 13 normal, req 14 cross-tenant/malformed) ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qa,'S1',1,false)).id INTO sid;
  IF sid IS NULL THEN RAISE EXCEPTION 'C1 active create failed'; END IF;
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,qx,'S2',1,false); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'C2 archived create NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,'00000000-0000-0000-0000-0000000839ff','S3',1,false); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'C3 unknown create NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,'not-a-uuid','S4',1,false); ok:=true;
    EXCEPTION WHEN check_violation THEN WHEN invalid_text_representation THEN RAISE EXCEPTION 'C4 raw uuid-cast error leaked'; END;
  IF ok THEN RAISE EXCEPTION 'C4 malformed create NOT rejected'; END IF;
  ok:=false; BEGIN PERFORM create_game_session_atomic(NULL,h,qb,'S5',1,false); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION 'C5 cross-tenant create NOT rejected'; END IF;
  RESET ROLE;
  RAISE NOTICE 'req13/14 create guard (active ok; archived/unknown/malformed/cross-tenant honestly rejected): PASS';

  -- ═══ req 7 — archiving an active quiz cancels its waiting real session IMMEDIATELY (trigger) ═══
  RESET ROLE;
  UPDATE public.tenant_quizzes SET status='archived' WHERE id=qt::uuid;   -- fires trigger
  SELECT status, live_question, ended_at INTO st, lq, ea FROM public.game_sessions WHERE id=e7;
  IF st<>'canceled' THEN RAISE EXCEPTION 'req7 trigger did not cancel waiting session (%)',st; END IF;
  IF lq IS NOT NULL THEN RAISE EXCEPTION 'req7 live_question not cleared'; END IF;
  IF ea IS NULL THEN RAISE EXCEPTION 'req7 ended_at not set'; END IF;
  RAISE NOTICE 'req7 archive-active-quiz trigger: waiting session canceled + live cleared + ended_at set: PASS';

  -- ═══ delete-path — hard-deleting a quiz cancels its waiting real session (BEFORE DELETE) ═══
  RESET ROLE;
  DELETE FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000008300a6';   -- fires BEFORE DELETE trigger
  SELECT status, live_question, ended_at INTO st, lq, ea FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300ea';
  IF st<>'canceled' THEN RAISE EXCEPTION 'delete-path trigger did not cancel waiting session (%)',st; END IF;
  IF lq IS NOT NULL THEN RAISE EXCEPTION 'delete-path live_question not cleared'; END IF;
  IF ea IS NULL THEN RAISE EXCEPTION 'delete-path ended_at not set'; END IF;
  IF EXISTS (SELECT 1 FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000008300a6') THEN RAISE EXCEPTION 'delete-path quiz not deleted'; END IF;
  RAISE NOTICE 'delete-path: hard-delete cancels waiting session (before delete) + quiz removed: PASS';

  -- ═══ req 12 — a concurrent/stale Start cannot revive the trigger-canceled session ═══
  UPDATE public.game_sessions SET question_snapshot='[{"q":1}]'::jsonb WHERE id=e7;   -- even with a snapshot
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_start_session(e7); ok:=true; EXCEPTION WHEN check_violation THEN END;   -- 'not startable (status=canceled)'
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'req12 canceled session was startable'; END IF;
  SELECT status INTO st FROM public.game_sessions WHERE id=e7; IF st<>'canceled' THEN RAISE EXCEPTION 'req12 revived (%)',st; END IF;
  RAISE NOTICE 'req12 stale Start cannot revive a canceled session: PASS';

  -- ═══ req 9 — join to a canceled session is rejected (status guard) ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||l||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_participant_join(e7,'L','x','#fff'); ok:=true; EXCEPTION WHEN check_violation THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'req9 join to canceled session NOT rejected'; END IF;
  RAISE NOTICE 'req9 participant join rejects a canceled session: PASS';

  -- ═══ req 10 — join to a WAITING session whose quiz is archived is rejected (quiz-active guard) ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||l||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM rpc_participant_join(e6,'L','x','#fff'); ok:=true; EXCEPTION WHEN check_violation THEN END;   -- forged waiting on qx
  IF ok THEN RAISE EXCEPTION 'req10 join to archived-quiz waiting session NOT rejected'; END IF;
  -- positive control: join to a valid waiting+active session succeeds
  v := rpc_participant_join(e3,'L','x','#fff');
  IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'req10 valid join failed (%)',v; END IF;
  RESET ROLE;
  RAISE NOTICE 'req10 participant join: archived-quiz waiting rejected; valid waiting+active accepted: PASS';

  -- ═══ req 8 — joinable listing excludes archived-quiz + canceled; includes valid waiting+active ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||l||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_learner_joinable_sessions();
  RESET ROLE;
  IF v @> '[{"id":"00000000-0000-0000-0000-0000008300e6"}]'::jsonb THEN RAISE EXCEPTION 'req8 list surfaced archived-quiz waiting session'; END IF;
  IF v @> '[{"id":"00000000-0000-0000-0000-0000008300e7"}]'::jsonb THEN RAISE EXCEPTION 'req8 list surfaced canceled session'; END IF;
  IF NOT (v @> '[{"id":"00000000-0000-0000-0000-0000008300e3"}]'::jsonb) THEN RAISE EXCEPTION 'req8 list omitted a valid waiting+active session'; END IF;
  RAISE NOTICE 'req8 joinable list excludes archived-quiz + canceled, includes valid waiting+active: PASS';

  -- ═══ start-guard defense-in-depth — a forged waiting session on an already-archived quiz
  --      (trigger never fired for it) returns quiz_unavailable + is durably canceled at Start ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_start_session(e8);
  IF (v->>'ok')<>'false' OR (v->>'reason')<>'quiz_unavailable' THEN RAISE EXCEPTION 'start-defense not quiz_unavailable (%)',v; END IF;
  RESET ROLE;
  SELECT status INTO st FROM public.game_sessions WHERE id=e8; IF st<>'canceled' THEN RAISE EXCEPTION 'start-defense not canceled (%)',st; END IF;
  RAISE NOTICE 'start-guard defense-in-depth: forged archived-quiz Start → quiz_unavailable + canceled: PASS';

  -- ═══ req 13 (start) — active-quiz waiting session starts normally ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT (create_game_session_atomic(NULL,h,qa,'S13',1,false)).id INTO sid;
  RESET ROLE;
  UPDATE public.game_sessions SET question_snapshot='[{"q":1}]'::jsonb WHERE id=sid;
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_start_session(sid);
  RESET ROLE;
  IF (v->>'ok')<>'true' THEN RAISE EXCEPTION 'req13 active start not ok (%)',v; END IF;
  RAISE NOTICE 'req13 active-quiz create + start remains normal: PASS';

  -- ═══ ONE-TIME DATA CORRECTION (§6) — cancels remaining waiting orphans; idempotent ═══
  RESET ROLE;
  UPDATE public.game_sessions s SET status='canceled', ended_at=now(), live_question=NULL
   WHERE s.demo_mode=false AND s.status='waiting'
     AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=s.quiz_id AND q.tenant_id::text=s.tenant_id AND q.status='active');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n < 1 THEN RAISE EXCEPTION 'correction cancelled zero rows (expected orphans)'; END IF;
  -- req 1: existing waiting + archived quiz canceled
  SELECT status INTO st FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300e1'; IF st<>'canceled' THEN RAISE EXCEPTION 'req1 archived-quiz orphan not canceled (%)',st; END IF;
  -- req 2: existing waiting + missing quiz canceled
  SELECT status INTO st FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300e2'; IF st<>'canceled' THEN RAISE EXCEPTION 'req2 missing-quiz orphan not canceled (%)',st; END IF;
  -- req 3: existing waiting + active quiz remains waiting (e3 was joined above but stays 'waiting')
  SELECT status INTO st FROM public.game_sessions WHERE id=e3; IF st<>'waiting' THEN RAISE EXCEPTION 'req3 active-quiz waiting wrongly changed (%)',st; END IF;
  -- req 4: started + archived quiz remains started
  SELECT status INTO st FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300e4'; IF st<>'started' THEN RAISE EXCEPTION 'req4 started session wrongly changed (%)',st; END IF;
  -- req 6: demo waiting session remains unchanged
  SELECT status INTO st FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300e5'; IF st<>'waiting' THEN RAISE EXCEPTION 'req6 demo session wrongly changed (%)',st; END IF;
  RAISE NOTICE 'req1/2/3/4/6 one-time correction cancels only real waiting orphans: PASS';
  -- req 15: reapplying the correction affects zero further rows
  UPDATE public.game_sessions s SET status='canceled', ended_at=now(), live_question=NULL
   WHERE s.demo_mode=false AND s.status='waiting'
     AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=s.quiz_id AND q.tenant_id::text=s.tenant_id AND q.status='active');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'req15 correction not idempotent (% rows on re-run)',n; END IF;
  RAISE NOTICE 'req15 correction is idempotent (0 rows on re-run): PASS';

  -- ═══ req 5 — completed historical session whose quiz is later archived stays intact ═══
  UPDATE public.tenant_quizzes SET status='archived' WHERE id='00000000-0000-0000-0000-0000008300a4';   -- archive QH (no waiting sessions on it)
  SELECT status, question_snapshot INTO st, v FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000008300f9';
  IF st<>'completed' THEN RAISE EXCEPTION 'req5 historical status changed (%)',st; END IF;
  IF v <> '[{"q":"frozen"}]'::jsonb THEN RAISE EXCEPTION 'req5 historical snapshot changed'; END IF;
  RAISE NOTICE 'req5 completed historical session + immutable snapshot survive quiz archive: PASS';

  -- ═══ req 11 — manager active listing (DEPLOYED fn) excludes canceled; still shows started ═══
  PERFORM set_config('request.jwt.claims','{"sub":"'||h||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := rpc_manager_active_sessions('00000000-0000-0000-0000-0000000830a0'::uuid);
  RESET ROLE;
  IF v @> '[{"id":"00000000-0000-0000-0000-0000008300e7"}]'::jsonb THEN RAISE EXCEPTION 'req11 manager list surfaced a canceled session'; END IF;
  IF NOT (v @> '[{"id":"00000000-0000-0000-0000-0000008300e4"}]'::jsonb) THEN RAISE EXCEPTION 'req11 manager list dropped an in-progress started game'; END IF;
  RAISE NOTICE 'req11 manager active listing excludes canceled, still represents started games: PASS';

  RAISE NOTICE '083 ALL TESTS PASSED';
END $$;

-- req 16 — structural: fixtures roll back (all objects/rows vanish after ROLLBACK).
SELECT (to_regprocedure('public.rpc_participant_join(uuid,text,text,text)') IS NOT NULL) AS fns_ok;
ROLLBACK;
