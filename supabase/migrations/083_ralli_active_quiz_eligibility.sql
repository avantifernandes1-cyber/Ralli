-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 083: Ralli Live active-quiz eligibility (create + start guards).
--
-- ADDITIVE / forward-only. Recreates two EXISTING SECURITY DEFINER functions as faithful
-- supersets (same signatures, return types, ownership, security model, search_path; CREATE OR
-- REPLACE preserves owner + grants) — adding ONLY the approved eligibility behavior. No schema
-- change, no data change, no destructive cleanup, no completed-session / snapshot / answer /
-- score / analytics change, no new client hard-delete path, no RLS change.
--
-- Canonical eligibility rule (authoritative): a Ralli Live game may be created/started from a quiz
-- ONLY when tenant_quizzes.status = 'active' (exact — never "not archived"; unknown/null/malformed/
-- future statuses are NOT playable). Quiz identity is compared SAFELY as text
-- (tenant_quizzes.id::text = quiz_id) so a malformed text id is rejected honestly rather than
-- raising a raw uuid-cast error. One stable reason is surfaced: 'quiz_unavailable' (covers
-- archived / not found / malformed / cross-tenant). Demo sessions are unaffected (isolation kept).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. CREATE guard — a persisted (non-demo) session may only be created from an active,
--    same-tenant quiz. The check runs BEFORE any INSERT, so a failure leaves zero new sessions/
--    participants/answers/Presence. Faithful superset of the deployed definition (search_path
--    'public'; v_tenant from get_my_tenant_id(); grants/owner preserved by CREATE OR REPLACE).
CREATE OR REPLACE FUNCTION public.create_game_session_atomic(
  p_tenant_id text, p_host_id text, p_quiz_id text, p_name text, p_question_count integer, p_demo_mode boolean DEFAULT false)
RETURNS game_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant  text;
  v_code    text;
  v_row     game_sessions;
  v_attempt integer := 0;
BEGIN
  v_tenant := get_my_tenant_id()::text;

  -- Active-quiz eligibility (083): non-demo (persisted) sessions only. Safe text id comparison.
  IF p_demo_mode IS DISTINCT FROM true THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.tenant_quizzes q
      WHERE q.id::text = p_quiz_id
        AND q.tenant_id::text = v_tenant
        AND q.status = 'active'
    ) THEN
      RAISE EXCEPTION 'quiz_unavailable'
        USING ERRCODE = 'check_violation',
              DETAIL  = 'quiz is archived, not found, or not in the caller''s tenant';
    END IF;
  END IF;

  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    BEGIN
      INSERT INTO game_sessions
        (tenant_id, quiz_id, host_id, pin, name, question_count, demo_mode, status)
      VALUES
        (v_tenant, p_quiz_id, p_host_id, v_code, p_name, p_question_count, p_demo_mode, 'waiting')
      RETURNING * INTO v_row;
      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 8 THEN
        RAISE EXCEPTION 'Could not allocate a unique game code after % attempts', v_attempt;
      END IF;
    END;
  END LOOP;
END;
$function$;

-- 2. START guard — if the session's quiz was archived (or is no longer an active same-tenant quiz)
--    AFTER creation but BEFORE start, DO NOT start. Durably CANCEL the still-waiting session and
--    clear its live question/reveal state, then RETURN a structured non-start result. It must NOT
--    RAISE after the cancellation write — an exception would roll the cancellation back and leave
--    an orphaned joinable waiting session. Faithful superset of the deployed rpc_start_session
--    (search_path ''; owner/grants preserved). All prior guards + success path are unchanged.
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session id required' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo session is not server-persisted' USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.status <> 'waiting' THEN
    RAISE EXCEPTION 'session not startable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.question_snapshot IS NULL THEN
    RAISE EXCEPTION 'session has no question snapshot' USING ERRCODE = 'check_violation';
  END IF;
  -- Active-quiz eligibility at start (083): archived/unavailable → durably cancel, do NOT raise.
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id
      AND q.tenant_id::text = v_s.tenant_id
      AND q.status = 'active'
  ) THEN
    UPDATE public.game_sessions
       SET status = 'canceled', ended_at = now(), live_question = NULL
     WHERE id = v_s.id AND status = 'waiting';
    RETURN jsonb_build_object('ok', false, 'reason', 'quiz_unavailable', 'session_id', v_s.id);
  END IF;
  UPDATE public.game_sessions SET status = 'started', started_at = now() WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$function$;

-- CREATE OR REPLACE preserves owner (postgres) and existing EXECUTE grants for both functions:
--   create_game_session_atomic: PUBLIC, anon, authenticated, service_role (unchanged — demo/anon
--     create path retained; the guard is skipped for demo_mode = true).
--   rpc_start_session: authenticated, service_role (unchanged). No GRANT/REVOKE issued.
