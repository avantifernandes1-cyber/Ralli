-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 079: cut over the two residual host-side reads of game_sessions /
-- game_session_participants so a later `REVOKE SELECT … FROM authenticated` on the
-- Ralli Live tables won't break gameplay.
--
-- ADDITIVE ONLY (no revoke of any table grant / RLS policy / data change). Two new
-- server-authorized RPCs; both authorize via the existing ralli_can_manage_session
-- helper (exact host / same-tenant orgAdmin|manager / ralli_admin) — NO duplicated
-- authorization or scoring logic.
--
--   1. rpc_host_publish_reveal — moves the reveal durable-state write + 0-row
--      classification read (gameService.publishRevealDurable) server-side. The EXACT
--      same conditional first-publication is performed atomically; on 0 rows it returns
--      the current row's classification fields so the caller classifies with the
--      unchanged shared JS (classifyRevealPublish). Reveal gameplay behavior is
--      identical — only the read/write PATH moves off the table.
--   2. rpc_host_award_context — the points-award session/participant lookup
--      (scoringService.awardGamePointsForSession): resolve the caller's same-tenant
--      session by PIN and return its id + {player_id,name} for each participant. The
--      scoring math stays entirely in scoringService; only its two direct reads move here.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Reveal durable-state publication + classification (host/manager only).
CREATE OR REPLACE FUNCTION public.rpc_host_publish_reveal(p_session_id uuid, p_expected_qidx integer, p_live_question jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_s public.game_sessions; v_updated int; v_phase text; v_cqi int; v_lq jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Exact first-publication guard from gameService.publishRevealDurable (unchanged):
  UPDATE public.game_sessions
     SET phase = 'reveal', live_question = p_live_question
   WHERE id = p_session_id
     AND current_question_index = p_expected_qidx
     AND phase IN ('question','open-review')
     AND status IN ('started')
     AND paused = false;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 1 THEN
    RETURN jsonb_build_object('outcome', 'applied');
  END IF;
  -- 0 rows → return the current row's classification fields; the caller classifies with
  -- the existing shared JS (classifyRevealPublish) so no classify logic is duplicated here.
  SELECT phase, current_question_index, live_question INTO v_phase, v_cqi, v_lq
    FROM public.game_sessions WHERE id = p_session_id;
  RETURN jsonb_build_object('outcome', 'zero',
    'current', jsonb_build_object('phase', v_phase, 'current_question_index', v_cqi, 'live_question', v_lq));
END;
$$;

-- 2. Points-award context: session id + participant (player_id,name) map, host/manager only.
CREATE OR REPLACE FUNCTION public.rpc_host_award_context(p_pin text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_tenant uuid; v_s public.game_sessions;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  SELECT * INTO v_s FROM public.game_sessions
   WHERE pin = p_pin AND (v_tenant IS NOT NULL AND tenant_id = v_tenant::text)
   ORDER BY created_at DESC LIMIT 1;
  IF v_s.id IS NULL THEN RETURN jsonb_build_object('session_id', NULL, 'participants', '[]'::jsonb); END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object(
    'session_id', v_s.id,
    'participants', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('player_id', gp.player_id, 'name', gp.name) ORDER BY gp.joined_at)
      FROM public.game_session_participants gp WHERE gp.session_id = v_s.id), '[]'::jsonb));
END;
$$;

-- Grant hardening (074/075/077/078 pattern): no PUBLIC/anon EXECUTE; authenticated + service_role only.
REVOKE ALL   ON FUNCTION public.rpc_host_publish_reveal(uuid, integer, jsonb) FROM PUBLIC, anon;
REVOKE ALL   ON FUNCTION public.rpc_host_award_context(text)                  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_host_publish_reveal(uuid, integer, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rpc_host_award_context(text)                  TO authenticated, service_role;
