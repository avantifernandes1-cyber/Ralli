-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 086: LOCK the leaderboard full-coverage marker (game_sessions.exposure_fully_tracked)
-- to server-authoritative execution only. Forward-only, additive, narrowly scoped.
-- Does NOT modify migrations 084 or 085 (both byte-identical). No data backfill; no formula,
-- worker/cron/Vault, or UI change.
--
-- Why: migration 085 added game_sessions.exposure_fully_tracked (the leaderboard ADMISSION gate:
-- true only when exposure tracking began at question 1 under the 085 phase RPC). But game_sessions
-- carries a PRE-EXISTING permissive same-tenant authenticated UPDATE policy (auth_update_game_sessions,
-- USING tenant_id = get_my_tenant_id()), so a same-tenant authenticated client could set the marker
-- directly and admit a partial/legacy session to rankings. (Proven: a direct authenticated UPDATE flips
-- false→true.) The marker must be writable ONLY by trusted server-authoritative execution.
--
-- Mechanism (smallest safe guard proven by the audit): a BEFORE INSERT OR UPDATE row trigger that
-- rejects any attempt to CHANGE the marker (UPDATE) or INSERT it as true unless the executing DB role
-- is trusted. Trust is decided by current_user — the ACTUAL Postgres role, NOT spoofable client JWT
-- metadata: every Ralli Live write RPC is SECURITY DEFINER owned by `postgres`, so the authoritative
-- question-1 marker set inside rpc_set_session_phase runs as current_user='postgres' and is allowed;
-- direct PostgREST client writes run as 'authenticated'/'anon' and are rejected. service_role and
-- postgres retain controlled maintenance. The guard fires ONLY when the marker actually changes, so
-- every other legitimate game_sessions update (phase/status/pause/heartbeat/scoreboard/etc., whether via
-- the DEFINER RPCs or a direct same-tenant client update that leaves the marker unchanged) is untouched.
-- ─────────────────────────────────────────────────────────────────────────────

-- Trusted server-authoritative roles allowed to write the marker. Kept as an IMMUTABLE helper so the
-- policy is defined once and is easy to audit. current_user is the real role: 'postgres' for every
-- SECURITY DEFINER Ralli Live RPC (all owned by postgres) and for migrations; 'service_role' for
-- controlled maintenance. Direct clients are 'authenticated' / 'anon' and are never trusted here.
CREATE OR REPLACE FUNCTION public.ralli_marker_role_is_trusted()
RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT current_user IN ('postgres', 'service_role')
$$;

-- BEFORE INSERT OR UPDATE guard. SECURITY INVOKER (default) so current_user reflects the real executor
-- (a SECURITY DEFINER trigger would always report the trigger owner and defeat the check).
CREATE OR REPLACE FUNCTION public.game_sessions_guard_exposure_marker()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $function$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- Only intervene when the marker would actually change; unchanged-marker updates pass freely,
    -- including a change to the marker bundled with other fields (still a change → still rejected).
    IF NEW.exposure_fully_tracked IS DISTINCT FROM OLD.exposure_fully_tracked
       AND NOT public.ralli_marker_role_is_trusted() THEN
      RAISE EXCEPTION 'exposure_fully_tracked is server-authoritative and cannot be changed directly (role=%); it is set only by the authoritative question-1 transition in rpc_set_session_phase', current_user
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    -- A new session may only be created with the marker at its false default unless trusted; a client
    -- cannot pre-mark a fabricated session as fully tracked. (rpc_start_session runs as postgres and
    -- inserts the default false, so legitimate creation is unaffected.)
    IF NEW.exposure_fully_tracked IS TRUE
       AND NOT public.ralli_marker_role_is_trusted() THEN
      RAISE EXCEPTION 'exposure_fully_tracked cannot be set on insert by a direct client (role=%); it is server-authoritative', current_user
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END; $function$;

DROP TRIGGER IF EXISTS trg_guard_exposure_marker ON public.game_sessions;
CREATE TRIGGER trg_guard_exposure_marker
  BEFORE INSERT OR UPDATE ON public.game_sessions
  FOR EACH ROW EXECUTE FUNCTION public.game_sessions_guard_exposure_marker();

COMMENT ON FUNCTION public.game_sessions_guard_exposure_marker() IS
  'Server-authority guard (086): rejects any change to game_sessions.exposure_fully_tracked (UPDATE) or an INSERT of it as true unless current_user is trusted (postgres/service_role). The 085 question-1 marker set runs inside rpc_set_session_phase (SECURITY DEFINER, owner postgres) so it is allowed; direct authenticated/anon writes are denied. Fires only when the marker changes, leaving all other game_sessions updates untouched.';

-- No data change: all existing exposure_fully_tracked values remain false. No backfill, no policy
-- rewrite, no grant change beyond adding this column-scoped guard. Migrations 084/085 unchanged.
