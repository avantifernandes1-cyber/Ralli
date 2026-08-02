-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 080: server-authorized Ralli Live lifecycle WRITES (Stage C, corrected).
--
-- ADDITIVE ONLY (no revoke of any table grant / RLS policy / data change). Stage B proved
-- that a later `REVOKE SELECT … FROM authenticated` breaks 9 of 11 client writes (every
-- UPDATE's WHERE + the join UPSERT's ON CONFLICT need SELECT). This migration moves those 9
-- filtered writes behind SECURITY DEFINER RPCs so they run as the function owner (which
-- retains SELECT) — making the SELECT revocation (migration 081, later) safe. The two pure
-- INSERT paths (game_players final scores, game_answers) are UNCHANGED (migration 072 scope).
--
-- IDENTITY + STATE INTEGRITY (correction over the first draft):
--   • EXACT session identity: start/end operate on the exact game_sessions.id the client
--     already holds (activeGameSessionDbId) — never a latest-by-PIN lookup that could hit a
--     reused/stale session. End has NO pin fallback; a missing id is an honest no-op, so a
--     demo game (null id) can never be silently completed as a persisted one.
--   • Smallest truthful state-transition guards on every host RPC (below). Terminal sessions
--     cannot be mutated; already-terminal calls are explicit idempotent no-ops, not silent
--     re-mutations.
--   • Normal Join is canonical-joinability only: same tenant + real (non-demo) + status
--     'waiting' (aligned with the handleEnterPin/find_joinable_session flow). A started/paused
--     prior participant must use rpc_rejoin_session (078), NOT this. The join upsert restores
--     the caller's lobby state (a returning 'left' row → 'active') with no duplicate.
--   • Learner self-writes derive player_id = auth.uid()::text (the rpc_rejoin_session, 078,
--     convention) so a learner can only ever write THEIR OWN row; leave/heartbeat report an
--     honest matched/not-matched result instead of unconditional success.
--   • All SECURITY DEFINER (bypass RLS) → each enforces tenant/authorization EXPLICITLY.
--     search_path='' on all. Host authz via the owner-only ralli_can_manage_session helper.
--   • Reused, not duplicated: rpc_rejoin_session (078), rpc_host_publish_reveal (079).
--   • No scoring/reveal/question/answer logic embedded; persists the same fields as before.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── HOST-AUTHORIZED SESSION LIFECYCLE (exact session_id) ─────────────────────

-- 1. Start: a real, waiting session that HAS its immutable question snapshot → 'started'.
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  UPDATE public.game_sessions SET status = 'started', started_at = now() WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$$;

-- 2. End: EXACT id only (no pin fallback). Atomically completes the session AND its active
--    participants. Already-completed is an explicit idempotent no-op. A null id (e.g. a demo
--    game) is a matched=false no-op — never resolves or completes another session.
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  -- Atomic (single function body = single transaction): session + participants together.
  UPDATE public.game_sessions SET status = 'completed', ended_at = now() WHERE id = v_s.id;
  UPDATE public.game_session_participants
     SET status = 'completed', last_seen_at = now()
   WHERE session_id = v_s.id AND status IN ('active', 'joined');
  RETURN jsonb_build_object('ok', true, 'matched', true, 'already', false, 'session_id', v_s.id);
END;
$$;

-- 3. Cancel: only a pre-game 'waiting' session (creation rollback / lobby end-before-start).
--    Already-canceled is an idempotent no-op; a started/completed game is never cancelled.
CREATE OR REPLACE FUNCTION public.rpc_cancel_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  UPDATE public.game_sessions SET status = 'canceled', ended_at = now() WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'already', false, 'session_id', v_s.id);
END;
$$;

-- 4. Phase/current-question/pause/live persistence — never mutates a terminal session.
--    Tri-state per optional field (p_set_*): only flagged fields written (object=store /
--    null=clear / undefined=leave). No reveal logic here (reveal is rpc_host_publish_reveal).
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(
  p_session_id uuid, p_phase text,
  p_set_cqi boolean, p_cqi integer,
  p_set_paused boolean, p_paused boolean,
  p_set_live boolean, p_live_question jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
    live_question          = CASE WHEN p_set_live   THEN p_live_question ELSE live_question END
  WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 5. Immutable question snapshot: written ONCE, only while the session is still 'waiting'
--    (before it is started). Write-once (question_snapshot IS NULL) preserves immutability;
--    accepts DEFINITIONS only (never answers/scores).
CREATE OR REPLACE FUNCTION public.rpc_save_question_snapshot(p_session_id uuid, p_questions jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_written int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session id required' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Write-once, pre-start only: sets the snapshot solely when the session is still waiting
  -- AND has none yet, so an existing snapshot is immutable and a live/terminal game is never
  -- re-snapshotted.
  UPDATE public.game_sessions SET question_snapshot = p_questions
   WHERE id = v_s.id AND status = 'waiting' AND question_snapshot IS NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'written', v_written = 1);
END;
$$;

-- ── LEARNER SELF-AUTHORIZED PARTICIPANT WRITES (player_id = auth.uid()) ───────

-- 6. Join: canonical joinability ONLY — same tenant + real (non-demo) + status 'waiting'.
--    Idempotent self upsert; a returning 'left' row is restored to 'active' (default lobby
--    state); no duplicate; null avatar preserved. A started/paused prior participant must use
--    rpc_rejoin_session (078), not this.
CREATE OR REPLACE FUNCTION public.rpc_participant_join(p_session_id uuid, p_name text, p_emoji text, p_color text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
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
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, status, joined_at, last_seen_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, 'active', now(), now())
  ON CONFLICT (session_id, player_id) DO UPDATE
    SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color,
        status = 'active',                 -- restore lobby state (a prior 'left' row rejoins)
        joined_at = EXCLUDED.joined_at, last_seen_at = EXCLUDED.last_seen_at,
        tenant_id = EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 7. Leave: flip ONLY the caller's own row to 'left'; report honest matched/not-matched.
CREATE OR REPLACE FUNCTION public.rpc_participant_leave(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.game_session_participants
     SET status = 'left', last_seen_at = now()
   WHERE session_id = p_session_id AND player_id = v_uid::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'matched', v_n = 1);
END;
$$;

-- 8. Heartbeat: refresh ONLY the caller's own last_seen_at; report honest matched/not-matched.
CREATE OR REPLACE FUNCTION public.rpc_participant_heartbeat(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_n int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.game_session_participants
     SET last_seen_at = now()
   WHERE session_id = p_session_id AND player_id = v_uid::text;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'matched', v_n = 1);
END;
$$;

-- ── Grant hardening (074/075/077/078/079 pattern): no PUBLIC/anon EXECUTE ─────
REVOKE ALL ON FUNCTION public.rpc_start_session(uuid)                                                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_end_session(uuid)                                                     FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_session(uuid)                                                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_save_question_snapshot(uuid, jsonb)                                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_join(uuid, text, text, text)                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_leave(uuid)                                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_heartbeat(uuid)                                           FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_start_session(uuid)                                                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_end_session(uuid)                                                     TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_session(uuid)                                                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_save_question_snapshot(uuid, jsonb)                                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_join(uuid, text, text, text)                              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_leave(uuid)                                               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_heartbeat(uuid)                                           TO authenticated, service_role;
