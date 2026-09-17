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

-- (d) restore the EXACT pre-092 ensure_self_profile body (the 091/live version, with the xmax-based
--     `created`). This is a faithful inverse; the xmax `created` is cosmetic (the frontend ignores it) and
--     re-applying 092 restores the reliable ON CONFLICT … RETURNING version.
CREATE OR REPLACE FUNCTION public.ensure_self_profile(
  p_name           text DEFAULT NULL,
  p_nickname       text DEFAULT NULL,
  p_avatar_emoji   text DEFAULT NULL,
  p_profile_pic_url text DEFAULT NULL,
  p_notif_prefs    jsonb DEFAULT NULL
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_email text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'ensure_self_profile: must be authenticated'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  INSERT INTO public.profiles (id, email, name, nickname, avatar_emoji, profile_pic_url,
                               notif_prefs, role, status, created_at, updated_at)
  VALUES (v_uid, v_email,
          COALESCE(NULLIF(TRIM(p_name),''), split_part(COALESCE(v_email,''),'@',1)),
          p_nickname, p_avatar_emoji, p_profile_pic_url,
          COALESCE(p_notif_prefs, '{}'::jsonb),
          'user', 'active', now(), now())
  ON CONFLICT (id) DO NOTHING;   -- never overwrites role/status/tenant/team of an existing row
  RETURN jsonb_build_object('userId', v_uid,
    'created', (SELECT xmax = 0 FROM public.profiles WHERE id = v_uid));
END $function$;
REVOKE ALL ON FUNCTION public.ensure_self_profile(text,text,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_self_profile(text,text,text,text,jsonb) TO authenticated, service_role;

COMMIT;
-- ─────────────────────────────────────────────────────────────────────────────
