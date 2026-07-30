-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 077: learner-safe joinable-session list for Ralli Live
--
-- ADDITIVE ONLY. Migration 075 routed the app's session list through
-- rpc_manager_active_sessions, which is manager/orgAdmin/ralli_admin-only and
-- returns [] to ordinary learners — so learners lost their joinable-games list AND
-- (because the lobby derived its sessionDbId from that list) their lobby membership.
-- This adds a SEPARATE learner contract: the minimal set of same-tenant JOINABLE
-- sessions any authenticated tenant member may see, so learners can find/select a
-- game to join. rpc_manager_active_sessions is NOT weakened and learners get no
-- manager access.
--
-- Returns ONLY safe display/selection fields for a joinable session. NEVER returns
-- question_snapshot, live_question, correct answers, player answers, manager
-- analytics, or hidden/started/paused/completed/canceled sessions. Tenant is derived
-- SERVER-SIDE from the caller's profile. Demo (single-client) sessions are excluded.
--
-- Does NOT change any table grant, RLS policy, data, or existing function.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.rpc_learner_joinable_sessions()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb;  -- no tenant → nothing joinable
  END IF;
  -- JOINABLE = same tenant, status 'waiting', not a demo session. Safe fields only:
  -- the exact metadata the join panel needs to display/select a game. No snapshot,
  -- no live_question, no answers, no analytics.
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'pin', s.pin, 'name', s.name, 'quiz_id', s.quiz_id,
      'question_count', s.question_count, 'status', s.status,
      'player_count', s.player_count, 'demo_mode', s.demo_mode)
      ORDER BY s.created_at DESC)
    FROM public.game_sessions s
    WHERE s.tenant_id = v_tenant::text
      AND s.status = 'waiting'
      AND COALESCE(s.demo_mode, false) = false), '[]'::jsonb);
END;
$$;
COMMENT ON FUNCTION public.rpc_learner_joinable_sessions() IS
  'Ralli Live: same-tenant JOINABLE (waiting, non-demo) sessions for any authenticated tenant member — safe display/selection fields only (no snapshot/live_question/answers/analytics). Tenant derived server-side.';

-- Grant hardening (074/075 pattern): strip default PUBLIC/anon EXECUTE, grant only
-- authenticated + service_role. anon denied (Ralli demo is in-memory; no anon path).
REVOKE ALL   ON FUNCTION public.rpc_learner_joinable_sessions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_learner_joinable_sessions() TO authenticated, service_role;
