-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 083: Ralli Live active-quiz eligibility + durable waiting-session integrity
--                (concurrency-safe via quiz-row locking; archive AND delete paths).
--
-- ADDITIVE / forward-only. No schema/column/policy change, no destructive cleanup, no change to
-- completed sessions / snapshots / answers / scores / analytics, no new client hard-delete path.
--
-- Canonical rule: a Ralli Live game may be created / joined / started from a quiz ONLY when
-- tenant_quizzes.status = 'active' (exact — never "not archived"). Quiz identity is compared
-- SAFELY as text (tenant_quizzes.id::text = quiz_id) so a malformed text id is rejected honestly
-- rather than raising a raw uuid-cast error. Stable reason surfaced: 'quiz_unavailable'. Demo
-- sessions are unaffected.
--
-- Lifecycle invariant: a real, non-demo game session must never remain 'waiting' (joinable) once
-- its quiz stops being active OR is deleted. Enforced at the SOURCE by triggers on tenant_quizzes
-- (UPDATE-of-status AND DELETE) so it holds no matter HOW the quiz changes (archive_quiz RPC, a
-- direct authenticated UPDATE via upsertQuiz, delete_quiz, or service_role).
--
-- Concurrency: the eligibility-sensitive mutators (create / start / join) take a SHARE row lock on
-- the canonical tenant_quizzes row and RE-CHECK status after acquiring it. archive_quiz already
-- SELECT ... FOR UPDATE + UPDATEs that row, a direct upsertQuiz UPDATE locks it, and delete_quiz
-- DELETEs it — all take a row-exclusive lock that conflicts with SHARE. Lock order is ALWAYS
-- quiz-row-first, then session-row, in every mutator (create/start/join and both triggers), so
-- there is one consistent order and no deadlock. Whichever operation wins the quiz-row lock
-- determines the outcome (linearizable): if archive/delete wins, create/start re-read and reject;
-- if create/start wins, the archive/delete trigger then cancels the just-created waiting session.
--
-- Sections: 1) create guard  2) start guard  3) join guard  4) joinable-list guard
--           5) source-of-truth triggers (deactivate + delete)  6) one-time data correction.
-- Sections 1–4 are faithful supersets of the deployed functions (CREATE OR REPLACE preserves owner
-- + grants + signature + return type + security + search_path).
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. CREATE guard — a persisted (non-demo) session may only be created from an active same-tenant
--    quiz. SHARE-lock that quiz row and re-check status BEFORE the INSERT loop: this serializes
--    against a concurrent archive/delete (which row-exclusive-lock the same row), closing the
--    "read active, then archive commits, then insert orphan" race. A failure leaves zero new rows.
CREATE OR REPLACE FUNCTION public.create_game_session_atomic(
  p_tenant_id text, p_host_id text, p_quiz_id text, p_name text, p_question_count integer, p_demo_mode boolean DEFAULT false)
RETURNS game_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_tenant   text;
  v_qstatus  text;
  v_code     text;
  v_row      game_sessions;
  v_attempt  integer := 0;
BEGIN
  v_tenant := get_my_tenant_id()::text;

  -- Active-quiz eligibility (083), non-demo only: SHARE-lock the canonical quiz row, then verify
  -- it is active. Safe text id comparison (never casts p_quiz_id to uuid). Missing / cross-tenant /
  -- malformed / non-active → no locked active row → reject before any INSERT.
  IF p_demo_mode IS DISTINCT FROM true THEN
    SELECT q.status INTO v_qstatus
      FROM public.tenant_quizzes q
      WHERE q.id::text = p_quiz_id AND q.tenant_id::text = v_tenant
      FOR SHARE;
    IF v_qstatus IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'quiz_unavailable'
        USING ERRCODE = 'check_violation',
              DETAIL  = 'quiz is archived, deleted, not found, or not in the caller''s tenant';
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

-- 2. START guard — SHARE-lock the quiz row and re-check active (serializes vs archive/delete). If
--    unavailable, durably CANCEL the still-waiting session and RETURN quiz_unavailable (no raise
--    after the write). Otherwise transition with a CONDITIONAL update guarded on status='waiting':
--    if a concurrent archive/delete/cancel already moved the session, FOUND is false and we return
--    a non-start result INSTEAD OF reviving a canceled session. Faithful superset of the deployed
--    rpc_start_session (all prior guards + success shape preserved; search_path '').
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_qstatus text;
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
  -- Quiz-first lock: SHARE-lock the quiz row, then re-check status (serialize vs archive/delete).
  SELECT q.status INTO v_qstatus
    FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id AND q.tenant_id::text = v_s.tenant_id
    FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN
    UPDATE public.game_sessions
       SET status = 'canceled', ended_at = now(), live_question = NULL
     WHERE id = v_s.id AND status = 'waiting';
    RETURN jsonb_build_object('ok', false, 'reason', 'quiz_unavailable', 'session_id', v_s.id);
  END IF;
  -- Conditional transition: only a still-'waiting' session may start. Prevents reviving a session
  -- that a concurrent archive/delete/cancel moved out of 'waiting' after our read above.
  UPDATE public.game_sessions SET status = 'started', started_at = now()
   WHERE id = v_s.id AND status = 'waiting';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_startable', 'session_id', v_s.id);
  END IF;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$function$;

-- 3. JOIN-BOUNDARY guard — the authoritative point a learner becomes a participant in a WAITING
--    session. SHARE-lock the quiz row and re-check active (serialize vs archive/delete), then
--    re-check the session is still 'waiting' after the lock, before the participant upsert. Rejects
--    a stale/forged join to a session whose quiz became unavailable. Faithful superset of the
--    deployed rpc_participant_join (all auth/tenant/demo/status guards + the upsert preserved).
CREATE OR REPLACE FUNCTION public.rpc_participant_join(p_session_id uuid, p_name text, p_emoji text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions; v_qstatus text; v_sstatus text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant for caller' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL OR v_s.tenant_id IS DISTINCT FROM v_tenant::text THEN
    RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo session not joinable here' USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.status <> 'waiting' THEN
    RAISE EXCEPTION 'session not joinable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  -- Quiz-first lock: SHARE-lock the quiz row, re-check active (serialize vs archive/delete).
  SELECT q.status INTO v_qstatus
    FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id AND q.tenant_id::text = v_s.tenant_id
    FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'quiz_unavailable' USING ERRCODE = 'check_violation';
  END IF;
  -- Re-check the session is still waiting after acquiring the quiz lock (a concurrent archive/
  -- delete trigger may have canceled it while we waited on the lock).
  SELECT status INTO v_sstatus FROM public.game_sessions WHERE id = v_s.id;
  IF v_sstatus <> 'waiting' THEN
    RAISE EXCEPTION 'session not joinable (status=%)', v_sstatus USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, 'active', now(), now())
  ON CONFLICT (session_id, player_id) DO UPDATE
    SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color,
        status = 'active',
        joined_at = EXCLUDED.joined_at, last_seen_at = EXCLUDED.last_seen_at,
        tenant_id = EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- 4. JOINABLE-LIST guard — the learner's list surfaces only same-tenant waiting non-demo sessions
--    whose quiz is active. A read-only list needs no lock (a session briefly listed during an
--    archive race is harmless — the authoritative join in §3 is lock-guarded and will reject).
--    Faithful superset of the deployed rpc_learner_joinable_sessions.
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
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb;
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

-- 5. SOURCE-OF-TRUTH TRIGGERS — the single authoritative enforcement of the lifecycle invariant,
--    for BOTH ways a quiz can stop being playable:
--      (a) status leaves 'active' (archive, or any non-active status) — AFTER UPDATE OF status;
--      (b) the quiz row is hard-deleted (delete_quiz for a quiz with no assignments/attempts, or
--          service_role/offboarding) — BEFORE DELETE, so waiting sessions are canceled before the
--          quiz row (and any lookup of it) disappears. There is NO FK from game_sessions.quiz_id,
--          so a delete would otherwise silently orphan a waiting session.
--    Both cancel every same-tenant, non-demo 'waiting' session for the quiz, in the same
--    transaction as the change. SECURITY DEFINER (owner postgres) so the game_sessions write
--    succeeds regardless of which role changed the quiz. Started/completed/terminal sessions are
--    untouched (only status='waiting' matches). Restore (→ 'active') never matches the UPDATE WHEN.
--    The two trigger functions are self-contained (no parameterized shared canceller is exposed as
--    a callable object) and have EXECUTE revoked from PUBLIC — triggers fire regardless of grants.
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
  RETURN NULL;  -- AFTER trigger: return value ignored
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.ralli_cancel_waiting_sessions_for_quiz() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
  UPDATE public.game_sessions
     SET status = 'canceled', ended_at = now(), live_question = NULL
   WHERE quiz_id = OLD.id::text
     AND tenant_id = OLD.tenant_id::text
     AND demo_mode = false
     AND status = 'waiting';
  RETURN OLD;   -- BEFORE DELETE: return OLD to allow the delete to proceed
END;
$function$;
REVOKE EXECUTE ON FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_ralli_cancel_waiting_sessions_on_quiz_deactivate ON public.tenant_quizzes;
CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_deactivate
  AFTER UPDATE OF status ON public.tenant_quizzes
  FOR EACH ROW
  WHEN (OLD.status = 'active' AND NEW.status IS DISTINCT FROM 'active')
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_for_quiz();

DROP TRIGGER IF EXISTS trg_ralli_cancel_waiting_sessions_on_quiz_delete ON public.tenant_quizzes;
CREATE TRIGGER trg_ralli_cancel_waiting_sessions_on_quiz_delete
  BEFORE DELETE ON public.tenant_quizzes
  FOR EACH ROW
  EXECUTE FUNCTION public.ralli_cancel_waiting_sessions_before_quiz_delete();

-- 6. ONE-TIME DATA CORRECTION — cancel pre-existing real waiting sessions orphaned by an
--    already-archived / deleted / missing / cross-tenant / non-active quiz (the triggers only fire
--    on FUTURE changes). Bounded + idempotent: after it runs those rows are 'canceled' and no
--    longer match status='waiting'. Never touches active-quiz waiting, started, completed, or demo
--    sessions. (Verified read-only pre-apply: exactly 2 production rows match today.)
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

-- CREATE OR REPLACE preserves owner (postgres) and existing EXECUTE grants for the four RPCs
-- (create_game_session_atomic: PUBLIC/anon/authenticated/service_role; rpc_start_session,
-- rpc_participant_join, rpc_learner_joinable_sessions: authenticated/service_role). The two
-- trigger functions are owned by postgres, invoked only by their triggers, and have EXECUTE
-- revoked from PUBLIC. No other GRANT/REVOKE issued; no client privilege expanded.
