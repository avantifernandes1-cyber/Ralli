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
--   * FORWARD-ONLY CORRECTION of ensure_self_profile.created: 091 (live, unchanged) derived `created` from
--     `xmax = 0`, which cannot distinguish a fresh insert from an existing untouched row. This migration
--     CREATE OR REPLACEs it to use INSERT … ON CONFLICT DO NOTHING RETURNING id, so first creation returns
--     created:true, an existing profile returns created:false with its protected fields untouched, and
--     concurrent duplicate calls create exactly one profile with an honest result and no error. Creation
--     stays role='user'/status='active'/tenant_id NULL — it never invents an org.
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

-- ── (4) FORWARD-ONLY CORRECTION of ensure_self_profile.created (091 is live and unchanged) ────────────────
-- 091 shipped ensure_self_profile with a `created` derived from `(SELECT xmax = 0 FROM profiles …)`, which is
-- UNRELIABLE: a pre-existing, never-updated row also has xmax = 0, so it would falsely report created:true.
-- The reliable signal is INSERT … ON CONFLICT DO NOTHING RETURNING: a row is returned ONLY when the insert
-- actually happened, so RETURNING id distinguishes a first creation (created:true) from an existing row
-- (created:false). ON CONFLICT DO NOTHING leaves any existing row's tenant/role/status/team/other protected
-- fields UNCHANGED, and under concurrent duplicate calls exactly one insert wins (the other observes the
-- conflict and returns created:false) with no error. Creation remains role='user', status='active',
-- tenant_id NULL, team_id NULL — it NEVER guesses or invents an organisation (an accepted invitation is what
-- attaches the profile to the intended tenant).
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
DECLARE v_uid uuid := auth.uid(); v_email text; v_inserted uuid;
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
  ON CONFLICT (id) DO NOTHING          -- never overwrites role/status/tenant/team of an existing row
  RETURNING id INTO v_inserted;        -- id is returned ONLY when a row was actually inserted
  RETURN jsonb_build_object('userId', v_uid, 'created', v_inserted IS NOT NULL);
END $function$;
REVOKE ALL ON FUNCTION public.ensure_self_profile(text,text,text,text,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ensure_self_profile(text,text,text,text,jsonb) TO authenticated, service_role;

COMMIT;

-- ── AUDIT ───────────────────────────────────────────────────────────────────────
--   SELECT string_agg(privilege_type,',') FROM information_schema.role_table_grants
--     WHERE table_name='profiles' AND grantee='authenticated';  -- expect SELECT + column UPDATEs only
--   SELECT tgname FROM pg_trigger WHERE tgname='trg_readiness_profiles_lifecycle_guard';
-- ─────────────────────────────────────────────────────────────────────────────
