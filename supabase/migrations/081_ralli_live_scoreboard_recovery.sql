-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 081: Ralli Live durable scoreboard recovery.
--
-- ADDITIVE / forward-only. Broadcast stays the fast path; the DATABASE becomes the recovery
-- source so a learner who misses the transient SCOREBOARD broadcast (refresh / reconnect /
-- background) can durably reconstruct the exact scoreboard the host published — instead of the
-- "No scores yet" empty state (the scoreboard was previously fire-and-forget: only `phase` was
-- persisted, never the score payload).
--
-- Independent of migrations 082 and 083 (numerically-clean chain: a fresh DB can apply 081 then
-- 083 in order). Touches only `game_sessions` (three additive columns) and recreates six existing
-- SECURITY DEFINER RPCs as faithful supersets. No new client table grant, no RLS change, no
-- change to scoring, answers, snapshots, final results, or analytics. Scoring stays the single
-- source of truth in the client; this migration only DURABLY PUBLISHES its already-computed result
-- and clears it on the next lifecycle transition. Demo sessions are isolated (publish rejects demo).
--
-- Durable payload (public.game_sessions.live_scoreboard, set only while phase='scoreboard'):
--   { session_id, q_idx, version, published_at, entries:[{ id, name, emoji, score, delta, rank }] }
-- Identity (id/name/emoji) is resolved SERVER-SIDE from game_session_participants; the client can
-- never inject names/avatars/ranks. No answers/solutions/quiz content are stored in the scoreboard.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Additive columns (backward compatible; existing rows read live_scoreboard=NULL, version=0).
ALTER TABLE public.game_sessions
  ADD COLUMN IF NOT EXISTS live_scoreboard         jsonb,
  ADD COLUMN IF NOT EXISTS scoreboard_version      bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS scoreboard_published_at timestamptz;

-- 2. PUBLICATION RPC — host-authorized, server-authoritative durable publication of the scoreboard
--    the client already computed. Does NOT recompute scores (scoring stays client-authoritative);
--    it validates state + identity, resolves names/avatars server-side, computes canonical rank/tie
--    ordering, monotonically bumps the version, and atomically persists phase + payload + metadata.
--    p_scores: jsonb array of minimal inputs [{ "id": <player_id>, "score": <num>, "delta": <num?> }].
CREATE OR REPLACE FUNCTION public.rpc_publish_scoreboard(p_session_id uuid, p_qidx integer, p_scores jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_s public.game_sessions;
  v_new_version bigint;
  v_now timestamptz := now();
  v_entries jsonb;
  v_unknown int;
  v_payload jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session id required' USING ERRCODE = 'no_data_found'; END IF;
  IF p_scores IS NULL OR jsonb_typeof(p_scores) <> 'array' THEN
    RAISE EXCEPTION 'scores array required' USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  -- Exact-host / authorized-manager under the existing Ralli Live authorization contract.
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Demo sessions are client-only — never server-persist a demo scoreboard.
  IF v_s.demo_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo session scoreboard is not server-persisted' USING ERRCODE = 'check_violation';
  END IF;
  -- Must be an in-progress game in a pre-scoreboard live phase.
  IF v_s.status <> 'started' THEN
    RAISE EXCEPTION 'session not in progress (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.phase IS DISTINCT FROM 'question' AND v_s.phase IS DISTINCT FROM 'reveal' AND v_s.phase IS DISTINCT FROM 'open-review' THEN
    RAISE EXCEPTION 'session not in a scoreboard-publishable phase (phase=%)', v_s.phase USING ERRCODE = 'check_violation';
  END IF;
  -- Supplied question index must match the session's current question.
  IF p_qidx IS DISTINCT FROM v_s.current_question_index THEN
    RAISE EXCEPTION 'question index mismatch (supplied=%, current=%)', p_qidx, v_s.current_question_index USING ERRCODE = 'check_violation';
  END IF;

  -- Reject any supplied id that is not a participant of THIS exact session (cross-session/unknown).
  SELECT count(*) INTO v_unknown
  FROM jsonb_array_elements(p_scores) e
  WHERE NOT EXISTS (
    SELECT 1 FROM public.game_session_participants gsp
    WHERE gsp.session_id = v_s.id AND gsp.player_id = (e->>'id')
  );
  IF v_unknown > 0 THEN
    RAISE EXCEPTION 'scoreboard contains % participant id(s) not in this session', v_unknown USING ERRCODE = 'check_violation';
  END IF;

  -- Canonical entries: names/avatars resolved server-side from the session participant record;
  -- competition rank/tie ordering (equal scores share a rank; next rank skips) by score desc, name asc.
  WITH input AS (
    SELECT (e->>'id') AS id,
           COALESCE((e->>'score')::numeric, 0) AS score,
           COALESCE((e->>'delta')::numeric, 0) AS delta
    FROM jsonb_array_elements(p_scores) e
  ),
  resolved AS (
    SELECT gsp.player_id AS id, gsp.name AS name, gsp.emoji AS emoji,
           i.score::bigint AS score, i.delta::bigint AS delta
    FROM input i
    JOIN public.game_session_participants gsp
      ON gsp.session_id = v_s.id AND gsp.player_id = i.id
  ),
  ranked AS (
    SELECT id, name, emoji, score, delta,
           rank() OVER (ORDER BY score DESC) AS rank,
           row_number() OVER (ORDER BY score DESC, lower(coalesce(name,'')) ASC, id ASC) AS ord
    FROM resolved
  )
  SELECT jsonb_agg(jsonb_build_object(
           'id', id, 'name', name, 'emoji', emoji, 'score', score, 'delta', delta, 'rank', rank)
         ORDER BY ord)
  INTO v_entries
  FROM ranked;
  v_entries := COALESCE(v_entries, '[]'::jsonb);

  v_new_version := v_s.scoreboard_version + 1;
  v_payload := jsonb_build_object(
    'session_id', v_s.id, 'q_idx', v_s.current_question_index,
    'version', v_new_version, 'published_at', v_now, 'entries', v_entries);

  UPDATE public.game_sessions
     SET phase = 'scoreboard',
         live_scoreboard = v_payload,
         scoreboard_version = v_new_version,
         scoreboard_published_at = v_now
   WHERE id = v_s.id;

  RETURN v_payload;
END;
$function$;

-- 3. PHASE RPC superset — faithful superset of the deployed rpc_set_session_phase (080). Adds ONLY:
--    when the host moves to any phase OTHER than 'scoreboard' (countdown / next question / reveal /
--    open-review / ended), clear live_scoreboard and bump the version, so a reconnect can never
--    restore a previous question's scoreboard. Phase + qIdx + version remain the final guards.
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb)
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
  IF v_s.status IN ('completed', 'canceled', 'ended') THEN
    RAISE EXCEPTION 'session not mutable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.game_sessions SET
    phase = p_phase,
    current_question_index = CASE WHEN p_set_cqi    THEN p_cqi           ELSE current_question_index END,
    paused                 = CASE WHEN p_set_paused THEN p_paused        ELSE paused END,
    live_question          = CASE WHEN p_set_live   THEN p_live_question ELSE live_question END,
    -- 081: invalidate a durable scoreboard whenever leaving the scoreboard phase.
    live_scoreboard        = CASE WHEN p_phase <> 'scoreboard' THEN NULL ELSE live_scoreboard END,
    scoreboard_version     = CASE WHEN p_phase <> 'scoreboard' AND live_scoreboard IS NOT NULL
                                  THEN scoreboard_version + 1 ELSE scoreboard_version END
  WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- 4. END RPC superset — faithful superset of rpc_end_session (080); additionally invalidates any
--    durable scoreboard (final results use the separate game_players path, unchanged).
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'matched', false); END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.status = 'completed' THEN
    RETURN jsonb_build_object('ok', true, 'matched', true, 'already', true, 'session_id', v_s.id);
  END IF;
  IF v_s.status <> 'started' THEN
    RAISE EXCEPTION 'session not endable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.game_sessions
     SET status = 'completed', ended_at = now(),
         live_scoreboard = NULL,
         scoreboard_version = scoreboard_version + CASE WHEN live_scoreboard IS NOT NULL THEN 1 ELSE 0 END
   WHERE id = v_s.id;
  UPDATE public.game_session_participants
     SET status = 'completed', last_seen_at = now()
   WHERE session_id = v_s.id AND status IN ('active', 'joined');
  RETURN jsonb_build_object('ok', true, 'matched', true, 'already', false, 'session_id', v_s.id);
END;
$function$;

-- 5. CANCEL RPC superset — faithful superset of rpc_cancel_session (080); additionally invalidates
--    any durable scoreboard.
CREATE OR REPLACE FUNCTION public.rpc_cancel_session(p_session_id uuid)
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
  IF v_s.status = 'canceled' THEN
    RETURN jsonb_build_object('ok', true, 'already', true, 'session_id', v_s.id);
  END IF;
  IF v_s.status <> 'waiting' THEN
    RAISE EXCEPTION 'session not cancellable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.game_sessions
     SET status = 'canceled', ended_at = now(),
         live_scoreboard = NULL,
         scoreboard_version = scoreboard_version + CASE WHEN live_scoreboard IS NOT NULL THEN 1 ELSE 0 END
   WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'already', false, 'session_id', v_s.id);
END;
$function$;

-- 6. LEARNER RESTORE superset — faithful superset of rpc_player_session_restore (073). Adds the
--    durable scoreboard to the returned session object ONLY while phase='scoreboard' (else null),
--    plus the current scoreboard_version so the client can guard against stale/older payloads. No
--    answers/solutions/quiz content added; participant + tenant authorization unchanged.
CREATE OR REPLACE FUNCTION public.rpc_player_session_restore(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_session public.game_sessions%ROWTYPE;
  v_uid text := auth.uid()::text;
  v_my_tenant text := (public.get_my_tenant_id())::text;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'rpc_player_session_restore: session id required'; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO v_session FROM public.game_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session not found'; END IF;
  IF NOT (
    (v_session.tenant_id IS NULL OR (v_my_tenant IS NOT NULL AND v_session.tenant_id = v_my_tenant))
    AND (
      EXISTS (SELECT 1 FROM public.game_session_participants gsp WHERE gsp.session_id = p_session_id AND gsp.player_id = v_uid)
      OR EXISTS (SELECT 1 FROM public.game_answers ga WHERE ga.session_id = p_session_id AND ga.player_id = v_uid)
    )
  ) THEN
    RAISE EXCEPTION 'not a participant of this session';
  END IF;

  RETURN jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id, 'phase', v_session.phase, 'current_question_index', v_session.current_question_index,
      'paused', v_session.paused, 'status', v_session.status, 'pin', v_session.pin, 'name', v_session.name,
      'quiz_id', v_session.quiz_id, 'question_count', v_session.question_count, 'player_count', v_session.player_count,
      'tenant_id', v_session.tenant_id, 'live_question', v_session.live_question,
      -- 081: durable scoreboard, only while it is the current phase; stale phases return null.
      'live_scoreboard', CASE WHEN v_session.phase = 'scoreboard' THEN v_session.live_scoreboard ELSE NULL END,
      'scoreboard_version', v_session.scoreboard_version),
    'my_answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('question_idx', ga.question_idx, 'points', ga.points, 'is_correct', ga.is_correct) ORDER BY ga.question_idx)
      FROM public.game_answers ga
      WHERE ga.session_id = p_session_id AND v_uid IS NOT NULL AND ga.player_id = v_uid
    ), '[]'::jsonb)
  );
END;
$function$;

-- 7. HOST RESTORE superset — faithful superset of rpc_host_session_restore (075). Same durable
--    scoreboard addition (only while phase='scoreboard') + version; answers/participants unchanged.
CREATE OR REPLACE FUNCTION public.rpc_host_session_restore(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_s.id, 'phase', v_s.phase, 'current_question_index', v_s.current_question_index,
      'paused', v_s.paused, 'status', v_s.status, 'pin', v_s.pin, 'name', v_s.name,
      'quiz_id', v_s.quiz_id, 'question_count', v_s.question_count, 'player_count', v_s.player_count,
      'tenant_id', v_s.tenant_id, 'live_question', v_s.live_question,
      'live_scoreboard', CASE WHEN v_s.phase = 'scoreboard' THEN v_s.live_scoreboard ELSE NULL END,
      'scoreboard_version', v_s.scoreboard_version),
    'answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'player_id', ga.player_id, 'player_name', ga.player_name, 'question_idx', ga.question_idx,
        'points', ga.points, 'is_correct', ga.is_correct, 'answer_text', ga.answer_text)
        ORDER BY ga.question_idx)
      FROM public.game_answers ga WHERE ga.session_id = p_session_id), '[]'::jsonb),
    'participants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'player_id', gp.player_id, 'name', gp.name, 'emoji', gp.emoji, 'color', gp.color)
        ORDER BY gp.joined_at)
      FROM public.game_session_participants gp WHERE gp.session_id = p_session_id), '[]'::jsonb)
  );
END;
$function$;

-- Grants: CREATE OR REPLACE preserves existing EXECUTE grants on the six superseded RPCs
-- (authenticated/service_role). The new rpc_publish_scoreboard is host/manager-authorized inside
-- the body; grant EXECUTE to authenticated (anon has no host role); Supabase default privileges also
-- apply. No table grant, RLS policy, or client privilege beyond this is added.
REVOKE EXECUTE ON FUNCTION public.rpc_publish_scoreboard(uuid, integer, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_publish_scoreboard(uuid, integer, jsonb) TO authenticated, service_role;

-- No DML: existing sessions keep live_scoreboard=NULL, scoreboard_version=0 and degrade honestly
-- (the client shows the neutral empty state only when neither a durable nor a realtime scoreboard
-- exists). No scoreboard is backfilled/guessed for historical sessions.
