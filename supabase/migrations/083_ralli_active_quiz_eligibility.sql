-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 083: Ralli Live active-quiz eligibility + durable waiting-session integrity.
--
-- ADDITIVE / forward-only. No schema/column/policy change, no destructive cleanup, no change to
-- completed sessions / snapshots / answers / scores / analytics, no new client hard-delete path.
--
-- Canonical eligibility rule (authoritative): a Ralli Live game may be created / joined / started
-- from a quiz ONLY when tenant_quizzes.status = 'active' (exact — never "not archived"; unknown /
-- null / malformed / future statuses are NOT playable). Quiz identity is compared SAFELY as text
-- (tenant_quizzes.id::text = quiz_id) so a malformed text id is rejected honestly rather than
-- raising a raw uuid-cast error. One stable reason is surfaced: 'quiz_unavailable'. Demo sessions
-- are unaffected (isolation preserved).
--
-- Lifecycle invariant (the correction that BLOCKED the earlier draft): a real, non-demo game
-- session must never remain 'waiting' (and therefore joinable) once its quiz stops being active.
-- Enforced at the SOURCE by a database trigger so it holds no matter HOW the quiz status changes
-- (the archive_quiz RPC, a direct authenticated UPDATE via upsertQuiz, service_role, or SQL) —
-- because tenant_quizzes.status is writable outside archive_quiz, an RPC-only cancellation could
-- be bypassed. The trigger cancels atomically in the same transaction as the status change, so no
-- other transaction ever sees a joinable waiting session on a non-active quiz. Defense-in-depth
-- exact-active guards on the join boundary + the joinable list, the start-time durable cancel, and
-- a one-time correction of pre-existing orphans complete the closure.
--
-- Sections: 1) create guard  2) start guard  3) join-boundary guard  4) joinable-list guard
--           5) source-of-truth trigger  6) one-time data correction.
-- Sections 1–4 are faithful supersets of the deployed functions (CREATE OR REPLACE preserves owner
-- + grants + signature + return type + security + search_path); each adds ONLY the eligibility
-- behavior. Section 5 adds one trigger. Section 6 is bounded + idempotent.
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
--    an orphaned joinable waiting session. This is defense-in-depth: the trigger (§5) normally
--    cancels the session the instant its quiz is archived, so a live host typically never reaches
--    here with an unavailable quiz. Faithful superset of the deployed rpc_start_session
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

-- 3. JOIN-BOUNDARY guard — the authoritative point at which a learner actually becomes a
--    participant in a WAITING session. Even though §5 cancels waiting sessions the instant their
--    quiz is archived (so a waiting session should always have an active quiz), a stale or forged
--    client must never be able to join an unavailable one. Add the exact-active same-tenant quiz
--    check right after the existing status='waiting' guard, before the participant INSERT. Faithful
--    superset of the deployed rpc_participant_join (search_path ''; owner/grants preserved); all
--    existing auth / tenant / demo / status guards and the upsert are unchanged.
CREATE OR REPLACE FUNCTION public.rpc_participant_join(p_session_id uuid, p_name text, p_emoji text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant for caller' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  -- Unknown session AND cross-tenant collapse to the same "not found" path (no existence leak).
  IF v_s.id IS NULL OR v_s.tenant_id IS DISTINCT FROM v_tenant::text THEN
    RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found';
  END IF;
  -- Real + waiting only. Started/paused/terminal/demo normal joins are rejected here
  -- (started/paused → rpc_rejoin_session; terminal → closed).
  IF v_s.demo_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo session not joinable here' USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.status <> 'waiting' THEN
    RAISE EXCEPTION 'session not joinable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  -- Active-quiz eligibility at join (083): reject a stale/forged join to a waiting session whose
  -- quiz is not an active same-tenant quiz. Safe text id comparison.
  IF NOT EXISTS (
    SELECT 1 FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id
      AND q.tenant_id::text = v_s.tenant_id
      AND q.status = 'active'
  ) THEN
    RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, 'active', now(), now())
  ON CONFLICT (session_id, player_id) DO UPDATE
    SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color,
        status = 'active',                 -- restore lobby state (a prior 'left' row rejoins)
        joined_at = EXCLUDED.joined_at, last_seen_at = EXCLUDED.last_seen_at,
        tenant_id = EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- 4. JOINABLE-LIST guard — the learner's list of joinable games must never surface a waiting
--    session whose quiz is not an active same-tenant quiz. Add an exact-active EXISTS to the
--    existing WHERE. Faithful superset of the deployed rpc_learner_joinable_sessions (search_path
--    ''; owner/grants/return shape preserved). Only same-tenant waiting non-demo sessions with an
--    active quiz are listed; safe fields only (no snapshot / live_question / answers / analytics).
CREATE OR REPLACE FUNCTION public.rpc_learner_joinable_sessions()
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb;  -- no tenant → nothing joinable
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'pin', s.pin, 'name', s.name, 'quiz_id', s.quiz_id,
      'question_count', s.question_count, 'status', s.status,
      'player_count', s.player_count, 'demo_mode', s.demo_mode)
      ORDER BY s.created_at DESC)
    FROM public.game_sessions s
    WHERE s.tenant_id = v_tenant::text
      AND s.status = 'waiting'
      AND COALESCE(s.demo_mode, false) = false
      AND EXISTS (
        SELECT 1 FROM public.tenant_quizzes q
        WHERE q.id::text = s.quiz_id
          AND q.tenant_id::text = s.tenant_id
          AND q.status = 'active'
      )), '[]'::jsonb);
END;
$function$;

-- 5. SOURCE-OF-TRUTH TRIGGER — the single authoritative enforcement of the lifecycle invariant.
--    When a quiz leaves 'active' (archived or any non-active status), atomically cancel every
--    same-tenant, non-demo game session still 'waiting' on that quiz, in the SAME transaction as
--    the status change. Because tenant_quizzes.status is writable outside archive_quiz (a direct
--    authenticated UPDATE via upsertQuiz), the trigger — not an RPC edit — is what makes the
--    invariant universal; it also covers the archive_quiz RPC path, so there is exactly ONE
--    cancellation implementation (no duplication). SECURITY DEFINER (owner postgres) so the write
--    to game_sessions succeeds regardless of which role updated the quiz. Started/completed/
--    terminal sessions are untouched (only status='waiting' matches); answers/scores/snapshots/
--    analytics are never read or written. Restore (→ 'active') never matches the WHEN clause.
CREATE OR REPLACE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.game_sessions
     SET status = 'canceled', ended_at = now(), live_question = NULL
   WHERE quiz_id = NEW.id::text
     AND tenant_id = NEW.tenant_id::text
     AND demo_mode = false
     AND status = 'waiting';
  RETURN NULL;  -- AFTER trigger: return value is ignored
END;
$function$;

DROP TRIGGER IF EXISTS trg_ralli_cancel_waiting_sessions_on_quiz_deactivate ON public.tenant_quizzes;
CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_deactivate
  AFTER UPDATE OF status ON public.tenant_quizzes
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz();

-- 6. ONE-TIME DATA CORRECTION — cancel pre-existing real waiting sessions orphaned by an
--    already-archived / missing / cross-tenant / non-active quiz (the trigger only fires on FUTURE
--    status changes, so existing orphans need this explicit sweep). Bounded + idempotent: after it
--    runs, those rows are 'canceled' and no longer match status='waiting', so re-applying the
--    migration cancels zero additional rows. It never touches active-quiz waiting sessions, started
--    or completed games, or demo sessions. (Verified read-only pre-apply: exactly 2 production rows
--    match this predicate today.)
UPDATE public.game_sessions s
   SET status = 'canceled', ended_at = now(), live_question = NULL
 WHERE s.demo_mode = false
   AND s.status = 'waiting'
   AND NOT EXISTS (
     SELECT 1 FROM public.tenant_quizzes q
     WHERE q.id::text = s.quiz_id
       AND q.tenant_id::text = s.tenant_id
       AND q.status = 'active'
   );

-- CREATE OR REPLACE preserves owner (postgres) and existing EXECUTE grants for every function
-- above (create_game_session_atomic: PUBLIC/anon/authenticated/service_role; rpc_start_session,
-- rpc_participant_join, rpc_learner_joinable_sessions: authenticated/service_role). The new
-- trigger function is owned by postgres and is invoked only by the trigger (not granted to
-- clients). No GRANT/REVOKE issued; no privilege expanded.
