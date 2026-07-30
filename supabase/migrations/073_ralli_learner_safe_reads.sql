-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 073: Ralli Live LEARNER-SAFE read RPCs (additive; no revocation)
--
-- ADDITIVE ONLY. Creates SECURITY DEFINER read RPCs that give learners exactly
-- what they need WITHOUT exposing correct answers (question_snapshot) or another
-- player's answers. NOTHING is revoked here: existing SELECT grants/policies and
-- all write permissions are untouched (a later, separately-approved migration
-- will revoke the unsafe direct reads once this cutover is proven in preview).
--
-- Companion to the client change that sanitizes the SHOW_QUESTION broadcast +
-- persisted game_sessions.live_question (correct answers are sent to players only
-- at reveal). These RPCs are the safe read paths for learner-reachable data:
--   1. rpc_player_session_restore   — active player reconnect (own answers + safe
--      live_question only; never snapshot, never other players' answers)
--   2. rpc_my_completed_session_review — a participant's own review of a durably
--      COMPLETED session (snapshot correct answers allowed post-completion, to a
--      participant only; never another player's raw answer)
--   3. rpc_list_my_game_history     — the caller's own game history
--
-- Host/manager analytics + session-list reads remain on their existing direct
-- paths this turn (authorized, tenant-scoped, not learner-reachable); their safe
-- RPCs are the next additive step before revocation.
--
-- Tenant is always derived server-side from the session; no cross-session/tenant
-- mixing; explicit errors (never fabricated/empty data); no mutable-quiz fallback.
-- Demo/anon stays limited to tenant_id IS NULL sessions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Active player session restore ────────────────────────────────────────────
-- Returns only what an authenticated player (or an anon demo player) needs to
-- reconnect and render the CURRENT state: durable phase/index/paused/status, the
-- already-sanitized live_question (safe question pre-reveal; correct-answer info
-- only inside its post-reveal `reveal` block), and the caller's OWN per-question
-- points/correctness. NEVER question_snapshot, NEVER another player's answer.
CREATE OR REPLACE FUNCTION public.rpc_player_session_restore(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.game_sessions%ROWTYPE;
  v_uid text := auth.uid()::text;      -- null for anon
  v_my_tenant text := (public.get_my_tenant_id())::text;  -- null for anon
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'rpc_player_session_restore: session id required'; END IF;
  SELECT * INTO v_session FROM public.game_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session not found'; END IF;

  -- Same access scope as today's RLS (no widening): authenticated same-tenant, or
  -- anon for a demo (tenant_id IS NULL) session. Tenant derived server-side.
  IF NOT (
    (v_session.tenant_id IS NULL)
    OR (v_uid IS NOT NULL AND v_my_tenant IS NOT NULL AND v_session.tenant_id = v_my_tenant)
  ) THEN
    RAISE EXCEPTION 'not authorized for this session';
  END IF;

  RETURN jsonb_build_object(
    'session', jsonb_build_object(
      'id', v_session.id, 'phase', v_session.phase, 'current_question_index', v_session.current_question_index,
      'paused', v_session.paused, 'status', v_session.status, 'pin', v_session.pin, 'name', v_session.name,
      'quiz_id', v_session.quiz_id, 'question_count', v_session.question_count, 'player_count', v_session.player_count,
      'tenant_id', v_session.tenant_id, 'live_question', v_session.live_question),  -- live_question is stored SAFE
    -- OWN answers only (the caller's player_id). Guests/anon (null uid) get [].
    'my_answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('question_idx', ga.question_idx, 'points', ga.points, 'is_correct', ga.is_correct) ORDER BY ga.question_idx)
      FROM public.game_answers ga
      WHERE ga.session_id = p_session_id AND v_uid IS NOT NULL AND ga.player_id = v_uid
    ), '[]'::jsonb)
  );
END;
$$;
COMMENT ON FUNCTION public.rpc_player_session_restore(uuid) IS
  'Learner-safe active-player reconnect (073): durable phase/state + safe live_question + the caller''s OWN per-question points/correctness. Never question_snapshot; never another player''s answer. Same-tenant or anon-demo only.';
REVOKE ALL ON FUNCTION public.rpc_player_session_restore(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_player_session_restore(uuid) TO anon, authenticated, service_role;

-- ── 2. Completed learner review (participant-only, post-completion) ──────────────
-- Ralli Live intentionally reveals correct answers AFTER a game for review. That
-- is allowed ONLY when the session is durably completed AND the caller actually
-- participated. Returns the immutable snapshot (correct answers), the caller's OWN
-- answers, and the player count. NEVER another player's raw answer.
CREATE OR REPLACE FUNCTION public.rpc_my_completed_session_review(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session public.game_sessions%ROWTYPE;
  v_uid text := auth.uid()::text;
  v_participated boolean;
BEGIN
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'rpc_my_completed_session_review: session id required'; END IF;
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  SELECT * INTO v_session FROM public.game_sessions WHERE id = p_session_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'session not found'; END IF;
  IF v_session.status <> 'completed' THEN RAISE EXCEPTION 'session is not completed'; END IF;

  -- Must have participated (own answer row or own game_players row in this session).
  SELECT EXISTS (SELECT 1 FROM public.game_answers ga WHERE ga.session_id = p_session_id AND ga.player_id = v_uid)
      OR EXISTS (SELECT 1 FROM public.game_players gp WHERE gp.session_id = p_session_id AND gp.player_id = v_uid)
    INTO v_participated;
  IF NOT v_participated THEN RAISE EXCEPTION 'not a participant of this session'; END IF;

  RETURN jsonb_build_object(
    'snapshot', v_session.question_snapshot,   -- correct answers allowed: completed + participant
    'player_count', (SELECT count(*) FROM public.game_players gp WHERE gp.session_id = p_session_id),
    'my_answers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'question_idx', ga.question_idx, 'option_idx', ga.option_idx, 'answer_text', ga.answer_text,
        'numeric_value', ga.numeric_value, 'answer_json', ga.answer_json, 'is_correct', ga.is_correct,
        'points', ga.points, 'time_ms', ga.time_ms, 'was_skipped', ga.was_skipped, 'answered_at', ga.answered_at, 'id', ga.id
      ) ORDER BY ga.question_idx)
      FROM public.game_answers ga WHERE ga.session_id = p_session_id AND ga.player_id = v_uid
    ), '[]'::jsonb)
  );
END;
$$;
COMMENT ON FUNCTION public.rpc_my_completed_session_review(uuid) IS
  'Learner-safe completed-session review (073): snapshot + OWN answers + player count, ONLY for a durably completed session the caller participated in. Never another player''s raw answer.';
REVOKE ALL ON FUNCTION public.rpc_my_completed_session_review(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_my_completed_session_review(uuid) TO authenticated, service_role;

-- ── 3. Learner own game history ─────────────────────────────────────────────────
-- The caller's OWN game_players rows + the joined session's display metadata. No
-- other player's rows; no question_snapshot.
CREATE OR REPLACE FUNCTION public.rpc_list_my_game_history(p_limit int DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid text := auth.uid()::text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required'; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(to_jsonb(h) ORDER BY h.joined_at DESC) FROM (
      SELECT gp.id, gp.session_id, gp.player_id, gp.name, gp.emoji, gp.color, gp.final_score, gp.final_rank,
             gp.accuracy, gp.joined_at, gp.team_id, gp.team_name,
             jsonb_build_object('name', gs.name, 'question_count', gs.question_count, 'ended_at', gs.ended_at,
                                'pin', gs.pin, 'status', gs.status) AS game_sessions
      FROM public.game_players gp
      JOIN public.game_sessions gs ON gs.id = gp.session_id
      WHERE gp.player_id = v_uid
      ORDER BY gp.joined_at DESC
      LIMIT GREATEST(1, COALESCE(p_limit, 20))
    ) h
  ), '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION public.rpc_list_my_game_history(int) IS
  'Learner-safe own game history (073): the caller''s own game_players rows + joined session display metadata. Never another player''s rows; never question_snapshot.';
REVOKE ALL ON FUNCTION public.rpc_list_my_game_history(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_list_my_game_history(int) TO authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Additive only. No REVOKE of existing SELECT; no policy dropped; no write change.
-- Host/manager analytics + session-list safe RPCs are the next additive step.
-- ─────────────────────────────────────────────────────────────────────────────
