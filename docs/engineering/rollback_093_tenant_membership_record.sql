-- ─────────────────────────────────────────────────────────────────────────────
-- ROLLBACK for migration 093 — DURABLE TENANT-MEMBERSHIP RECORD.
--
-- Faithful inverse: restores the EXACT migration-091 bodies of the four wrappers that 093 augmented, drops
-- the tenant-scoped reader + the two record helpers, and drops the tenant_memberships table (and its index,
-- policy, constraints, which go with it). readiness_lifecycle_apply / change_role / delete_tenant were never
-- touched by 093, so they need no restoration.
--
-- ⚠ SECURITY NOTE: restoring the 091 accept_invitation body REOPENS the pre-093 behaviour in which an
-- existing active member could be moved across organisations by accepting another org's invitation. Only
-- roll back to unblock a regression, and re-apply 093 (which closes that path) once resolved.
--
-- Safe to run whether or not 092 has been applied (093 and 092 are disjoint). Single transaction.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- 1) Restore accept_invitation to the EXACT 091 body (no membership record; no cross-tenant hardening).
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text, p_name text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_inv    public.tenant_invitations%ROWTYPE;
  v_uid    uuid := auth.uid();
  v_email  text;
  v_exists boolean;
  v_ot     uuid; v_os text; v_or text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'accept_invitation: must be authenticated'; END IF;

  SELECT * INTO v_inv FROM public.tenant_invitations WHERE token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'accept_invitation: invitation not found'; END IF;
  IF v_inv.expires_at < now() THEN RAISE EXCEPTION 'accept_invitation: invitation has expired'; END IF;
  IF v_inv.status = 'accepted' THEN RAISE EXCEPTION 'accept_invitation: invitation already accepted'; END IF;

  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;

  SELECT true, tenant_id, status, role INTO v_exists, v_ot, v_os, v_or FROM public.profiles WHERE id = v_uid;

  IF v_exists IS TRUE THEN
    PERFORM public.readiness_lifecycle_apply(v_uid, 'active', v_inv.role, v_inv.tenant_id,
                                             v_os, v_or, v_ot, true);
    UPDATE public.profiles SET
      team_id    = COALESCE(v_inv.team_id, team_id),
      name       = CASE WHEN NULLIF(TRIM(p_name),'') IS NOT NULL THEN TRIM(p_name) ELSE name END,
      updated_at = now()
    WHERE id = v_uid;
  ELSE
    INSERT INTO public.profiles (id, email, name, role, tenant_id, team_id, status, created_at, updated_at)
    VALUES (
      v_uid,
      COALESCE(v_email, v_inv.admin_email),
      COALESCE(NULLIF(TRIM(p_name), ''), split_part(COALESCE(v_email, v_inv.admin_email), '@', 1)),
      v_inv.role, v_inv.tenant_id, v_inv.team_id, 'active', now(), now()
    );
  END IF;

  UPDATE public.tenant_invitations SET
    status      = 'accepted',
    accepted_at = now(),
    onboarding_state = onboarding_state || jsonb_build_object(
      'currentStep',    'account_created',
      'stepsCompleted', (onboarding_state->'stepsCompleted') || '["invited"]'::jsonb,
      'acceptedAt',     now()
    )
  WHERE id = v_inv.id;

  UPDATE public.tenants SET status = 'onboarding', updated_at = now()
   WHERE id = v_inv.tenant_id AND status = 'invited';

  RETURN jsonb_build_object(
    'userId', v_uid, 'tenantId', v_inv.tenant_id, 'role', v_inv.role, 'teamId', v_inv.team_id,
    'name', COALESCE(NULLIF(TRIM(p_name), ''), split_part(COALESCE(v_email, v_inv.admin_email), '@', 1)),
    'email', COALESCE(v_email, v_inv.admin_email)
  );
END $function$;
REVOKE ALL ON FUNCTION public.accept_invitation(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text,text) TO authenticated, service_role;

-- 2) Restore remove_member to the EXACT 091 body (no membership record).
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_remove_member(p_user uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_status text; v_role text; v_tenant uuid;
BEGIN
  SELECT status, role, tenant_id INTO v_status, v_role, v_tenant FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'remove_member: profile not found'; END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'remove_member: member is already detached'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_tenant);
  IF p_user = auth.uid() THEN RAISE EXCEPTION 'remove_member: cannot remove self'; END IF;
  RETURN public.readiness_lifecycle_apply(p_user, 'inactive', 'user', NULL,
                                          v_status, v_role, v_tenant, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_remove_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_remove_member(uuid) TO authenticated, service_role;

-- 3) Restore reactivate_member to the EXACT 091 body.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_reactivate_member(p_user uuid, p_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'reactivate_member: tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'reactivate_member: illegal role %', p_role; END IF;
  PERFORM public.readiness_lifecycle_authz(p_tenant);
  RETURN public.readiness_lifecycle_apply(p_user, 'active', p_role, p_tenant,
                                          NULL, NULL, NULL, true, ARRAY['inactive','invited']);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) TO authenticated, service_role;

-- 4) Restore transfer_member to the EXACT 091 body.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_transfer_member(p_user uuid, p_new_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_old_tenant uuid;
BEGIN
  IF p_new_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: new tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'transfer_member: illegal role %', p_role; END IF;
  SELECT tenant_id INTO v_old_tenant FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_member: profile not found'; END IF;
  IF v_old_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: member is detached; use reactivate_member'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_old_tenant);
  PERFORM public.readiness_lifecycle_authz(p_new_tenant);
  RETURN public.readiness_lifecycle_apply(p_user, 'active', p_role, p_new_tenant,
                                          NULL, NULL, v_old_tenant, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) TO authenticated, service_role;

-- 5) Drop the 093-only objects.
DROP FUNCTION IF EXISTS public.readiness_list_deactivated_members(uuid);
DROP FUNCTION IF EXISTS public.readiness_membership_activate(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.readiness_membership_end(uuid,uuid,text,text,uuid);
DROP TABLE IF EXISTS public.tenant_memberships;   -- drops index, policy, constraints with it

COMMIT;
