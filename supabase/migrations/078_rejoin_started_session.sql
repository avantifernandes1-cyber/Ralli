-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 078: safe rejoin to a started/paused Ralli Live session
--
-- ADDITIVE ONLY. A started game stays CLOSED to brand-new players (handleEnterPin +
-- find_joinable_session already reject non-'waiting' joins). But a PRIOR participant
-- who explicitly left (participant row status='left') and re-enters the PIN must be
-- able to rejoin the same active game. This one ATOMIC server-authorized op verifies
-- eligibility AND reactivates the existing participant row — no client read followed
-- by a separate untrusted write, and no duplicate participant.
--
-- Eligibility (all required): caller authenticated; PIN resolves to the caller's
-- SAME-TENANT real session; session.status = 'started' (running OR paused; never
-- completed/canceled/ended/waiting); the caller ALREADY has a participant row for
-- that exact session whose player_id = auth.uid() (so cross-user, cross-tenant,
-- guest, and never-participated callers are rejected). Reactivation only flips the
-- caller's own row status→'active' + refreshes last_seen_at; it NEVER touches
-- game_answers / game_players / final_score, so points, answers, name, avatar, and
-- color are preserved. It does NOT change session.paused — the host stays paused and
-- must press Resume manually.
--
-- Does NOT weaken the normal waiting-game join path, and changes no other function,
-- table grant, RLS policy, or data.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_rejoin_session(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_s public.game_sessions; v_part public.game_session_participants;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = v_uid;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'no tenant for caller' USING ERRCODE = 'insufficient_privilege'; END IF;

  -- Resolve the session by (pin, caller's tenant): a real same-tenant session only.
  -- Cross-tenant and unknown pins fall through the same "not found" path (no leak).
  SELECT * INTO v_s FROM public.game_sessions
   WHERE pin = p_pin AND tenant_id = v_tenant::text
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;

  -- Must be an ACTIVE started game (running or paused) — never terminal or waiting.
  IF v_s.status <> 'started' THEN
    RAISE EXCEPTION 'session not rejoinable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;

  -- Caller must ALREADY be a participant of THIS exact session, by their own auth.uid().
  -- Rejects brand-new users, cross-user, and guests.
  SELECT * INTO v_part FROM public.game_session_participants
   WHERE session_id = v_s.id AND player_id = v_uid::text;
  IF v_part.session_id IS NULL THEN
    RAISE EXCEPTION 'not a participant of this session' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Reactivate the EXISTING row (idempotent, no duplicate). Preserves name/emoji/color.
  UPDATE public.game_session_participants
     SET status = 'active', last_seen_at = now()
   WHERE session_id = v_s.id AND player_id = v_uid::text;

  RETURN jsonb_build_object(
    'ok', true,
    'session', jsonb_build_object(
      'id', v_s.id, 'pin', v_s.pin, 'name', v_s.name, 'status', v_s.status,
      'phase', v_s.phase, 'paused', v_s.paused, 'quiz_id', v_s.quiz_id,
      'question_count', v_s.question_count, 'demo_mode', v_s.demo_mode),
    'participant', jsonb_build_object(
      'player_id', v_part.player_id, 'name', v_part.name, 'emoji', v_part.emoji, 'color', v_part.color));
END;
$$;
COMMENT ON FUNCTION public.rpc_rejoin_session(text) IS
  'Ralli Live: atomic safe rejoin — a prior same-tenant participant (auth.uid()) may re-enter a started/paused session by PIN; verifies eligibility and reactivates their existing participant row. Never creates a duplicate, resumes the game, or admits a non-participant.';

-- Grant hardening (074/075/077 pattern): no PUBLIC/anon EXECUTE; authenticated + service_role only.
REVOKE ALL   ON FUNCTION public.rpc_rejoin_session(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_rejoin_session(text) TO authenticated, service_role;
