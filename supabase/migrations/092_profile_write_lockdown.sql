-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 092 — PROFILE-WRITE LOCKDOWN (closes the direct self-escalation bypass) — forward-only.
--
-- STAGE 3 of the zero-downtime rollout that began with 091. 091 added the lifecycle machinery +
-- ensure_self_profile while LEAVING the legacy broad profiles write grants intact (so the previously
-- deployed frontend's createMissingProfile fallback kept working). This migration performs the final,
-- previously-incompatible step now that the ffc0e2b frontend is live and no longer uses the legacy path:
--   * REVOKE the broad table + column write grants on public.profiles from anon/authenticated.
--   * Re-grant only SELECT (RLS-gated) and UPDATE on the safe presentation columns.
--     role/status/tenant_id/team_id/xp/streak/email/id/timestamps become writable ONLY via SECDEF paths
--     (the lifecycle RPCs, ensure_self_profile, the guarded admin RPCs, and the handle_new_user trigger).
--   * NO direct client INSERT: creation is only through ensure_self_profile (SECDEF, added in 091) and the
--     handle_new_user signup trigger — both run as postgres and need no client INSERT grant.
--   * Add the own-row WITH CHECK to profiles_update_own (defence in depth against row re-parenting).
--   * Add the fail-closed profiles lifecycle guard trigger: any status/role/tenant change must go through a
--     lifecycle RPC (which stamps this row's user id as a transaction-local marker after acquiring the
--     advisory). The documented ops break-glass requires BOTH the explicit setting AND a trusted executor
--     (current_user IN ('postgres','service_role')) — ordinary authenticated/anonymous callers can be
--     neither, so they can never bypass.
--
-- ── PRECONDITION (must be verified BEFORE applying 092; NOT enforceable in SQL) ──
--   The currently-deployed production frontend must be ffc0e2b (or later) and MUST NOT use the legacy direct
--   profile-write path (createMissingProfile's role/status upsert). Prove via: (a) static caller scan showing
--   no client `.from('profiles').insert|upsert|update({… role|status|tenant_id|team_id …})`, and (b) live QA
--   that signup, existing-account login, invitation acceptance, and missing-profile recovery all succeed via
--   ensure_self_profile / the lifecycle RPCs. See docs/engineering/091_092_ROLLOUT_PLAN.md.
--
-- Idempotent-ish (REVOKE/GRANT/CREATE OR REPLACE/DROP…IF EXISTS). 087–091 objects and all crons untouched.
-- Rollback: docs/engineering/rollback_092_profile_write_lockdown.sql (drops guard, restores broad grants +
-- the pre-092 own-row policy). NOTE: rolling back 092 REOPENS the direct self-escalation surface — only do so
-- to unblock a frontend regression, and re-apply 092 once the frontend is fixed.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ── (1) Grant hardening ──────────────────────────────────────────────────────
REVOKE ALL ON public.profiles FROM anon;
REVOKE ALL ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;
GRANT UPDATE (name, nickname, avatar_emoji, profile_pic_url, notif_prefs) ON public.profiles TO authenticated;

-- ── (2) Own-row WITH CHECK (cannot re-parent the row id; column grants are the primary gate) ─────────────
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ── (3) Fail-closed profiles lifecycle guard ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.readiness_profiles_lifecycle_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER          -- INVOKER so current_user reflects the true executor for the break-glass check
 SET search_path TO ''
AS $function$
BEGIN
  -- Only guard genuine changes to the three eligibility fields; no-op edits (name/avatar/etc.) pass through.
  IF (OLD.status, OLD.role, OLD.tenant_id) IS NOT DISTINCT FROM (NEW.status, NEW.role, NEW.tenant_id) THEN
    RETURN NEW;
  END IF;
  -- Normal path: a lifecycle RPC acquired the advisory FIRST and stamped THIS row's user id as the marker.
  IF current_setting('readiness.lifecycle_write', true) = NEW.id::text THEN
    RETURN NEW;
  END IF;
  -- Documented ops break-glass: requires BOTH the explicit setting AND a trusted executor. Ordinary
  -- authenticated/anonymous callers can be neither, so they can never bypass.
  IF current_setting('readiness.allow_unguarded', true) = '1'
     AND current_user IN ('postgres','service_role') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'readiness: direct change of profiles.(status/role/tenant_id) is not allowed; use a lifecycle RPC (readiness_lifecycle_*)';
END $function$;
REVOKE ALL ON FUNCTION public.readiness_profiles_lifecycle_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_readiness_profiles_lifecycle_guard ON public.profiles;
CREATE TRIGGER trg_readiness_profiles_lifecycle_guard
  BEFORE UPDATE OF status, role, tenant_id ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.readiness_profiles_lifecycle_guard();

COMMIT;

-- ── AUDIT ───────────────────────────────────────────────────────────────────────
--   SELECT string_agg(privilege_type,',') FROM information_schema.role_table_grants
--     WHERE table_name='profiles' AND grantee='authenticated';  -- expect SELECT + column UPDATEs only
--   SELECT tgname FROM pg_trigger WHERE tgname='trg_readiness_profiles_lifecycle_guard';
-- ─────────────────────────────────────────────────────────────────────────────
