-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 075: host/manager safe-read RPCs for Ralli Live
--
-- ADDITIVE ONLY. Creates server-authorized read RPCs so the app stops reading
-- game_sessions / game_answers / game_players / game_session_participants directly
-- for host recovery, Active Games, Past Sessions, exact-session analytics
-- (Overview / Player Breakdown / Questions), session player counts, and the lobby
-- roster. Authorization is derived SERVER-SIDE from auth.uid() + profiles — never
-- from client-supplied identity.
--
-- Does NOT: revoke any grant, drop/alter any RLS policy, rewrite data, change any
-- table grant, or touch migration 072 / any existing function. Table access is
-- intentionally NOT revoked here — that is a later, separate migration once every
-- read is proven cut over. (The direct-table RLS remains the backstop meanwhile.)
--
-- Grants: EXECUTE to authenticated + service_role. The Supabase schema-default anon
-- EXECUTE grant is intentionally left in place (this migration performs no REVOKE,
-- per its additive-only contract); every function still denies anon FUNCTIONALLY
-- (auth.uid() IS NULL → empty/​raise). A later hardening migration (the 074 pattern)
-- will REVOKE anon EXECUTE on these functions for grant-level parity.
-- ─────────────────────────────────────────────────────────────────────────────

-- Authorization predicate: may the CURRENT caller read MANAGER-scoped data for a
-- session hosted by p_host_id in tenant p_tenant? True iff the caller is the exact
-- host, a same-tenant orgAdmin, or a ralli_admin (platform operator). auth.uid()
-- resolves to the CALLER even inside SECURITY DEFINER; never true for anon.
-- NOTE: game_* tables store tenant_id as TEXT (uuid-format strings); profiles.tenant_id
-- is UUID. p_tenant is therefore text (the session's tenant_id) and is compared to
-- profiles.tenant_id::text.
CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT auth.uid() IS NOT NULL AND (
    p_host_id = auth.uid()::text
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
        AND ( (p.role = 'orgAdmin' AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant)
              OR p.role = 'ralli_admin' )
    )
  );
$$;
COMMENT ON FUNCTION public.ralli_can_manage_session(text, text) IS
  'Ralli Live: true if the current caller may read manager-scoped data for a session (exact host, same-tenant orgAdmin, or ralli_admin). Server-side authz for the 075 read RPCs.';

-- 1. HOST RECOVERY — full host game state + all answers (for score reconstruction)
--    + participant identity (emoji/color). Host/manager only.
CREATE OR REPLACE FUNCTION public.rpc_host_session_restore(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
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
      'tenant_id', v_s.tenant_id, 'live_question', v_s.live_question),
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
$$;

-- 2. ACTIVE GAMES — manager session list (NO question_snapshot). orgAdmin sees own
--    tenant (param ignored); ralli_admin sees p_tenant_id; ordinary user → [].
CREATE OR REPLACE FUNCTION public.rpc_manager_active_sessions(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT role, tenant_id INTO v_role, v_tenant FROM public.profiles WHERE id = auth.uid();
  IF    v_role = 'orgAdmin'   AND v_tenant IS NOT NULL THEN v_target := v_tenant::text;   -- own tenant
  ELSIF v_role = 'ralli_admin'                          THEN v_target := p_tenant_id::text; -- viewed tenant
  ELSE  RETURN '[]'::jsonb;   -- ordinary learner never gets the manager list
  END IF;
  IF v_target IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'pin', s.pin, 'name', s.name, 'quiz_id', s.quiz_id,
      'question_count', s.question_count, 'status', s.status,
      'player_count', s.player_count, 'demo_mode', s.demo_mode)
      ORDER BY s.created_at DESC)
    FROM public.game_sessions s
    WHERE s.tenant_id = v_target
      AND s.status IN ('waiting','started','live','active','paused')), '[]'::jsonb);
END;
$$;

-- 3. PAST SESSIONS — completed manager history with per-session player summary +
--    host display name (NO question_snapshot). Same tenant resolution as #2.
CREATE OR REPLACE FUNCTION public.rpc_manager_session_history(p_tenant_id uuid DEFAULT NULL, p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_role text; v_tenant uuid; v_target text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT role, tenant_id INTO v_role, v_tenant FROM public.profiles WHERE id = auth.uid();
  IF    v_role = 'orgAdmin'   AND v_tenant IS NOT NULL THEN v_target := v_tenant::text;
  ELSIF v_role = 'ralli_admin'                          THEN v_target := p_tenant_id::text;
  ELSE  RETURN '[]'::jsonb;
  END IF;
  IF v_target IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(t) ORDER BY t.ended_at DESC NULLS LAST)
    FROM (
      SELECT s.id, s.pin, s.name, s.quiz_id, s.question_count, s.status, s.demo_mode,
             s.ended_at, s.created_at, s.host_id,
             (SELECT p.name FROM public.profiles p WHERE p.id::text = s.host_id) AS host_name,
             (SELECT count(*) FROM public.game_players gp WHERE gp.session_id = s.id) AS player_count,
             (SELECT jsonb_build_object('name', tp.name, 'score', tp.final_score, 'emoji', tp.emoji)
                FROM public.game_players tp WHERE tp.session_id = s.id
                ORDER BY tp.final_rank ASC NULLS LAST LIMIT 1) AS top_player
      FROM public.game_sessions s
      WHERE s.tenant_id = v_target AND s.status = 'completed'
      ORDER BY s.ended_at DESC NULLS LAST
      LIMIT GREATEST(p_limit, 0)
    ) t), '[]'::jsonb);
END;
$$;

-- 4. EXACT-SESSION ANALYTICS — Overview / Player Breakdown / Questions for ONE
--    session. Host/manager only. Includes the question_snapshot (authorized viewer).
CREATE OR REPLACE FUNCTION public.rpc_manager_session_analytics(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
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
      'id', v_s.id, 'pin', v_s.pin, 'name', v_s.name, 'status', v_s.status,
      'question_count', v_s.question_count, 'ended_at', v_s.ended_at, 'quiz_id', v_s.quiz_id,
      'demo_mode', v_s.demo_mode, 'tenant_id', v_s.tenant_id),
    'players', COALESCE((
      SELECT jsonb_agg(to_jsonb(gp) ORDER BY gp.final_rank ASC NULLS LAST)
      FROM public.game_players gp WHERE gp.session_id = p_session_id), '[]'::jsonb),
    'answers', COALESCE((
      SELECT jsonb_agg(to_jsonb(ga) ORDER BY ga.question_idx ASC)
      FROM public.game_answers ga WHERE ga.session_id = p_session_id), '[]'::jsonb),
    'snapshot', v_s.question_snapshot
  );
END;
$$;

-- 5. SESSION PLAYER COUNTS — { session_id: count } for the requested sessions the
--    caller may see: a manager of it OR a participant of it (count only, no identities).
CREATE OR REPLACE FUNCTION public.rpc_session_player_counts(p_session_ids uuid[])
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_session_ids IS NULL THEN RETURN '{}'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_object_agg(x.id::text, x.cnt)
    FROM (
      SELECT gs.id,
             (SELECT count(*) FROM public.game_players gp WHERE gp.session_id = gs.id) AS cnt
      FROM public.game_sessions gs
      WHERE gs.id = ANY(p_session_ids)
        AND ( public.ralli_can_manage_session(gs.host_id, gs.tenant_id)
              OR EXISTS (SELECT 1 FROM public.game_session_participants pp
                         WHERE pp.session_id = gs.id AND pp.player_id = auth.uid()::text) )
    ) x), '{}'::jsonb);
END;
$$;

-- 6. LOBBY PARTICIPANTS — presence-only roster (id/name/emoji/color/status/heartbeat;
--    NEVER answers or scores). Host/manager OR a participant of the session.
CREATE OR REPLACE FUNCTION public.rpc_lobby_participants(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT ( public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id)
           OR EXISTS (SELECT 1 FROM public.game_session_participants pp
                      WHERE pp.session_id = p_session_id AND pp.player_id = auth.uid()::text) ) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'player_id', gp.player_id, 'name', gp.name, 'emoji', gp.emoji, 'color', gp.color,
      'status', gp.status, 'joined_at', gp.joined_at, 'last_seen_at', gp.last_seen_at)
      ORDER BY gp.joined_at)
    FROM public.game_session_participants gp WHERE gp.session_id = p_session_id), '[]'::jsonb);
END;
$$;

-- Grants (additive; no REVOKE). authenticated + service_role EXECUTE. anon is left
-- with the schema-default grant but is denied functionally by every body; a later
-- migration will REVOKE anon for grant-level parity (074 pattern).
GRANT EXECUTE ON FUNCTION public.ralli_can_manage_session(text, text)          TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_host_session_restore(uuid)                TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_manager_active_sessions(uuid)             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_manager_session_history(uuid, integer)    TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_manager_session_analytics(uuid)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_session_player_counts(uuid[])             TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_lobby_participants(uuid)                  TO authenticated, service_role;
