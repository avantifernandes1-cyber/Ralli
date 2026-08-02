-- Minimal faithful schema for the migration-083 two-connection concurrency test.
-- Loads the REAL 083 locking logic (create/start + deactivate/delete triggers), with auth stubbed.
CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE public.tenant_quizzes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active'
);

CREATE TABLE public.game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text,
  quiz_id text NOT NULL,
  host_id text NOT NULL DEFAULT 'anon',
  pin text NOT NULL,
  name text,
  status text NOT NULL DEFAULT 'waiting',
  question_count int NOT NULL DEFAULT 0,
  demo_mode boolean NOT NULL DEFAULT false,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  live_question jsonb,
  question_snapshot jsonb,
  UNIQUE (tenant_id, pin)
);

-- Auth/identity stubs (the concurrency property under test is the row LOCK, not auth).
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION public.get_my_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-0000000000aa'::uuid $$;
CREATE FUNCTION public.ralli_can_manage_session(p_host text, p_tenant text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

-- ── REAL 083 create guard (verbatim locking logic) ──
CREATE OR REPLACE FUNCTION public.create_game_session_atomic(
  p_tenant_id text, p_host_id text, p_quiz_id text, p_name text, p_question_count integer, p_demo_mode boolean DEFAULT false)
RETURNS game_sessions LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_tenant text; v_qstatus text; v_code text; v_row game_sessions; v_attempt integer := 0;
BEGIN
  v_tenant := get_my_tenant_id()::text;
  IF p_demo_mode IS DISTINCT FROM true THEN
    SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
      WHERE q.id::text = p_quiz_id AND q.tenant_id::text = v_tenant FOR SHARE;
    IF v_qstatus IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE='check_violation';
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

-- ── REAL 083 start guard (verbatim locking logic) ──
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_qstatus text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'auth' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'id' USING ERRCODE='no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id=p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'nf' USING ERRCODE='no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN RAISE EXCEPTION 'na' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN RAISE EXCEPTION 'demo' USING ERRCODE='check_violation'; END IF;
  IF v_s.status <> 'waiting' THEN RAISE EXCEPTION 'not startable (%)',v_s.status USING ERRCODE='check_violation'; END IF;
  IF v_s.question_snapshot IS NULL THEN RAISE EXCEPTION 'no snapshot' USING ERRCODE='check_violation'; END IF;
  SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id AND q.tenant_id::text = v_s.tenant_id FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN
    UPDATE public.game_sessions SET status='canceled', ended_at=now(), live_question=NULL WHERE id=v_s.id AND status='waiting';
    RETURN jsonb_build_object('ok',false,'reason','quiz_unavailable','session_id',v_s.id);
  END IF;
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id=v_s.id AND status='waiting';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'reason','not_startable','session_id',v_s.id); END IF;
  RETURN jsonb_build_object('ok',true,'session_id',v_s.id);
END; $function$;

-- ── REAL 083 triggers ──
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

CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_deactivate
  AFTER UPDATE OF status ON public.tenant_quizzes FOR EACH ROW
  WHEN (OLD.status='active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz();

CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_delete
  BEFORE DELETE ON public.tenant_quizzes FOR EACH ROW
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete();
