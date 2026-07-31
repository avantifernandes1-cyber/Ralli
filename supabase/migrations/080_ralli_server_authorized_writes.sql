-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 080: server-authorized Ralli Live lifecycle WRITES (Stage C).
--
-- ADDITIVE ONLY (no revoke of any table grant / RLS policy / data change). Stage B
-- proved that a later `REVOKE SELECT … FROM authenticated` breaks 9 of 11 client writes
-- (every UPDATE's WHERE clause + the join UPSERT's ON CONFLICT path need SELECT). This
-- migration moves those 9 filtered writes behind SECURITY DEFINER RPCs so the writes run
-- as the function owner (which retains SELECT) — making the SELECT revocation (migration
-- 081, later) safe. The two pure INSERT paths (game_players final scores, game_answers)
-- are UNCHANGED here; their write-trust hardening is the separate migration 072 workstream.
--
-- Authorization model (no duplication):
--   • Host writes authorize via the existing owner-only helper
--     ralli_can_manage_session(host_id, tenant_id) — exact host / same-tenant orgAdmin|
--     manager / ralli_admin. Tenant + session are resolved server-side; the caller never
--     passes a tenant it can forge.
--   • Learner self-writes derive player_id = auth.uid()::text (the exact convention from
--     rpc_rejoin_session, 078) so a learner can only ever write THEIR OWN participant row.
--     Cross-tenant joins are rejected by matching the session's tenant to the caller's.
--   • These run SECURITY DEFINER (owner), which bypasses RLS, so every function enforces
--     tenant/authorization EXPLICITLY (never relies on RLS). search_path='' on all.
--   • Reveal (rpc_host_publish_reveal, 079) and rejoin (rpc_rejoin_session, 078) already
--     exist and are REUSED — not duplicated here.
--   • No scoring / reveal / question / answer logic is embedded; these persist exactly the
--     same fields the client wrote before, with the same status/phase transition behavior.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── HOST-AUTHORIZED SESSION LIFECYCLE ────────────────────────────────────────

-- 1. Start: mark the caller's same-tenant session (by pin) 'started'.
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant for caller' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions
   WHERE pin = p_pin AND tenant_id = v_tenant::text ORDER BY created_at DESC LIMIT 1;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.game_sessions SET status = 'started', started_at = now() WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$$;

-- 2. End: atomically mark the session 'completed' AND complete its active participants.
--    Accepts the authoritative session id (preferred) or falls back to pin (legacy path
--    that marked only the session). Never touches game_players / game_answers / scores.
CREATE OR REPLACE FUNCTION public.rpc_end_session(p_session_id uuid, p_pin text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant for caller' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NOT NULL THEN
    SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  ELSE
    SELECT * INTO v_s FROM public.game_sessions
     WHERE pin = p_pin AND tenant_id = v_tenant::text ORDER BY created_at DESC LIMIT 1;
  END IF;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Atomic (single function body = single transaction): session + participants together.
  UPDATE public.game_sessions SET status = 'completed', ended_at = now() WHERE id = v_s.id;
  UPDATE public.game_session_participants
     SET status = 'completed', last_seen_at = now()
   WHERE session_id = v_s.id AND status IN ('active', 'joined');
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$$;

-- 3. Cancel: terminal, non-joinable status (rollback of a snapshot-less session).
CREATE OR REPLACE FUNCTION public.rpc_cancel_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE public.game_sessions SET status = 'canceled', ended_at = now() WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id);
END;
$$;

-- 4. Phase/current-question/pause/live-question persistence (durable recovery source).
--    Tri-state per optional field via p_set_* flags: only flagged fields are written, so
--    live_question can be SET to a value, CLEARED to null, or LEFT untouched — exactly the
--    prior client semantics (object=store / null=clear / undefined=leave). Never touches
--    scoring/answers; never embeds reveal logic (reveal is rpc_host_publish_reveal, 079).
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
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
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

-- 5. Immutable question snapshot: written ONCE at creation. Write-once guard preserves the
--    immutable historical-question contract; accepts DEFINITIONS only (never answers/scores).
CREATE OR REPLACE FUNCTION public.rpc_save_question_snapshot(p_session_id uuid, p_questions jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_written int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Write-once: only set when still null, so an existing snapshot is immutable.
  UPDATE public.game_sessions SET question_snapshot = p_questions
   WHERE id = v_s.id AND question_snapshot IS NULL;
  GET DIAGNOSTICS v_written = ROW_COUNT;
  RETURN jsonb_build_object('ok', true, 'written', v_written = 1);
END;
$$;

-- ── LEARNER SELF-AUTHORIZED PARTICIPANT WRITES (player_id = auth.uid()) ───────

-- 6. Join: idempotent self upsert into a same-tenant session. player_id is ALWAYS the
--    caller's auth.uid() (a learner can never write another player's row). Null avatar
--    stays null. No duplicate (ON CONFLICT session_id,player_id).
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
  IF v_s.id IS NULL OR v_s.tenant_id <> v_tenant::text THEN
    RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found';  -- cross-tenant/unknown → same path (no leak)
  END IF;
  INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, emoji, color, joined_at)
  VALUES (v_s.id, v_uid::text, v_tenant::text, p_name, p_emoji, p_color, now())
  ON CONFLICT (session_id, player_id) DO UPDATE
    SET name = EXCLUDED.name, emoji = EXCLUDED.emoji, color = EXCLUDED.color,
        joined_at = EXCLUDED.joined_at, tenant_id = EXCLUDED.tenant_id;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 7. Leave: flip ONLY the caller's own participant row to 'left'.
CREATE OR REPLACE FUNCTION public.rpc_participant_leave(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.game_session_participants
     SET status = 'left', last_seen_at = now()
   WHERE session_id = p_session_id AND player_id = v_uid::text;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- 8. Heartbeat: refresh ONLY the caller's own last_seen_at.
CREATE OR REPLACE FUNCTION public.rpc_participant_heartbeat(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  UPDATE public.game_session_participants
     SET last_seen_at = now()
   WHERE session_id = p_session_id AND player_id = v_uid::text;
  RETURN jsonb_build_object('ok', true);
END;
$$;

-- ── Grant hardening (074/075/077/078/079 pattern): no PUBLIC/anon EXECUTE ─────
REVOKE ALL ON FUNCTION public.rpc_start_session(text)                                                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_end_session(uuid, text)                                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_session(uuid)                                                  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_save_question_snapshot(uuid, jsonb)                                   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_join(uuid, text, text, text)                              FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_leave(uuid)                                               FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_participant_heartbeat(uuid)                                           FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_start_session(text)                                                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_end_session(uuid, text)                                               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_session(uuid)                                                  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_save_question_snapshot(uuid, jsonb)                                   TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_join(uuid, text, text, text)                              TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_leave(uuid)                                               TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_participant_heartbeat(uuid)                                           TO authenticated, service_role;
