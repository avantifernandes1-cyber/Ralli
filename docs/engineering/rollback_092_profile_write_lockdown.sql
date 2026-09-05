-- ─────────────────────────────────────────────────────────────────────────────
-- SELF-CONTAINED ROLLBACK for migration 092 (profile-write lockdown).
-- NOT a migration (lives outside supabase/migrations/ so it is never auto-applied).
--
-- Reverts ONLY 092: drops the profiles lifecycle guard trigger + function, restores the exact pre-092 broad
-- profiles grants, and restores the pre-092 own-row policy (USING only, no WITH CHECK). Leaves 091 and all
-- earlier migrations fully intact (the lifecycle RPCs, write-guard, FK model, ensure_self_profile, etc.).
--
-- WARNING: rolling back 092 RE-OPENS the direct profiles self-escalation surface (authenticated can again
-- write role/status/tenant_id/team_id directly, subject only to the own-row RLS). Only do this to unblock a
-- frontend regression during the staged rollout, and re-apply 092 once the frontend no longer needs the
-- legacy write path. The system remains correct without the guard (the lifecycle RPCs still enforce
-- advisory-first ordering internally; the guard is the enforcement that ALL paths use them).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- (a) drop the guard
DROP TRIGGER IF EXISTS trg_readiness_profiles_lifecycle_guard ON public.profiles;
DROP FUNCTION IF EXISTS public.readiness_profiles_lifecycle_guard();

-- (b) restore the pre-092 own-row policy (USING only, no WITH CHECK)
DROP POLICY IF EXISTS profiles_update_own ON public.profiles;
CREATE POLICY profiles_update_own ON public.profiles
  FOR UPDATE TO authenticated USING (id = auth.uid());

-- (c) restore the pre-092 broad profiles grants (byte-identical to the pre-lockdown state)
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.profiles TO anon, authenticated;
GRANT SELECT ON public.profiles TO anon, authenticated;

COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────
