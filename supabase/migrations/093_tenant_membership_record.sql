-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 093 — DURABLE TENANT-MEMBERSHIP RECORD (Deactivated Users) — ADDITIVE.
--
-- PURPOSE: give tenant orgAdmins a "Deactivated Users" list scoped to THEIR org — the people
-- previously REMOVED from that org — with previous role + removal date + a Reinvite action, WITHOUT
-- exposing the global detached-user list and WITHOUT inferring former membership from readiness history.
--
-- WHY A NEW RECORD IS REQUIRED: removal (readiness_lifecycle_remove_member) sets the profile to
-- status='inactive', role='user', tenant_id=NULL — so AFTER a removal the profile row no longer records
-- either the former tenant OR the former role. The only place a removed member's former tenant otherwise
-- survives is readiness_score_history.tenant_id, which is explicitly OFF-LIMITS as a membership source.
-- Therefore the former association MUST be captured durably at mutation time.
--
-- MODEL (approved): a per-(user,tenant) MEMBERSHIP STATE ROW — NOT an append-only event log. One row per
-- user per tenant tracks that membership's current lifecycle state ('active' | 'ended') and, when ended,
-- WHY ('removed' vs 'transferred'). The Deactivated Users list = ended + reason='removed' for that tenant.
-- A TRANSFER (Ralli-admin-only) ends the old membership as 'transferred', which is EXCLUDED from the list
-- (a transfer is not an org removal). Organisation deletion CASCADES these rows away (tenant FK CASCADE).
--
-- ATOMICITY / LOCKING (approved): every membership-record write happens INSIDE the same lifecycle RPC
-- transaction, AFTER readiness_lifecycle_apply has already acquired the per-user readiness advisory lock
-- (readiness_begin_lifecycle_write) and performed the guarded profiles UPDATE. The advisory lock is
-- txn-scoped and still held, so the record write is serialized under the SAME lock and commits/rolls back
-- ATOMICALLY with the profile change — a failed lifecycle operation (e.g. a 40001 stale-state abort) leaves
-- NO membership-record change. The engine (readiness_lifecycle_apply) signature is UNCHANGED; the record
-- writes live in the reason-aware wrappers, where the semantic operation is known.
--
-- SECURITY BOUNDARIES (unchanged / not broadened):
--   * Reads: orgAdmins reach deactivated users ONLY through the authorized, tenant-scoped SECDEF reader
--     readiness_list_deactivated_members (which calls readiness_lifecycle_authz) — NEVER the global
--     detached-user query. Table RLS additionally scopes any direct SELECT to the caller's own tenant
--     (mirrors readiness_score_history's rsh_select). Ralli admins keep their existing global controls.
--   * Writes: only the SECDEF lifecycle wrappers write the record; clients get no table DML grant.
--   * accept_invitation HARDENING: an EXISTING active member of org A can no longer be moved to org B by
--     accepting a B invitation — acceptance may only ATTACH a detached profile or update within the SAME
--     org. Cross-org movement stays an authorized transfer (Ralli-admin-only). This CLOSES a latent
--     cross-tenant path; it does not open one. (See test §9.)
--   * No RPC signature or authorization boundary is broadened. Transfer remains Ralli-admin-only.
--
-- BACKFILL (approved): ACTIVE members only, from the authoritative profile (tenant_id + role). Already-
-- removed/detached users are NOT backfilled — their former tenant exists only in readiness history, which
-- is off-limits — so the single pre-existing removed prod user stays reachable ONLY via the Ralli-admin
-- global detached view, never a tenant's Deactivated list. No fabricated tenant links.
--
-- ROLLOUT: 093 is additive + frontend-compatible and is applied BEFORE the frontend that reads it. It is
-- INDEPENDENT of (and disjoint from) migration 092; 092 (profile-write lockdown) stays LAST and gated.
-- NOT TOUCHED: 087–092 objects other than the four wrappers below; all crons; the V2 math; history rows;
-- readiness_lifecycle_apply / change_role / delete_tenant (delete_tenant relies on the tenant FK CASCADE).
-- Rollback: docs/engineering/rollback_093_tenant_membership_record.sql (restores the exact 091 wrapper
-- bodies and drops the table/helpers/reader).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- A. THE DURABLE RECORD — per-(user,tenant) membership state row (strengthened constraints)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.tenant_memberships (
  tenant_id           uuid        NOT NULL REFERENCES public.tenants(id)  ON DELETE CASCADE,
  user_id             uuid        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  state               text        NOT NULL DEFAULT 'active',
  end_reason          text,                         -- NULL while active; set when ended
  role_at_membership  text        NOT NULL,         -- role held; frozen to the actual role at removal time
  joined_at           timestamptz NOT NULL DEFAULT now(),
  removed_at          timestamptz,                  -- set ONLY for end_reason='removed'
  removed_by          uuid        REFERENCES public.profiles(id) ON DELETE SET NULL,  -- audit actor
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  CONSTRAINT tm_state_valid        CHECK (state IN ('active','ended')),
  CONSTRAINT tm_reason_valid       CHECK (end_reason IS NULL OR end_reason IN ('removed','transferred')),
  -- (#3) active rows must have end_reason, removed_at, removed_by all CLEARED
  CONSTRAINT tm_active_clear       CHECK (state <> 'active' OR (end_reason IS NULL AND removed_at IS NULL AND removed_by IS NULL)),
  -- ended rows must carry a reason
  CONSTRAINT tm_ended_has_reason   CHECK (state <> 'ended' OR end_reason IS NOT NULL),
  -- (#3) removed rows must have removed_at
  CONSTRAINT tm_removed_at         CHECK (end_reason IS DISTINCT FROM 'removed' OR removed_at IS NOT NULL),
  -- transferred rows are not removals: no removal timestamp/actor
  CONSTRAINT tm_transferred_clear  CHECK (end_reason IS DISTINCT FROM 'transferred' OR (removed_at IS NULL AND removed_by IS NULL))
);
COMMENT ON TABLE public.tenant_memberships IS
  'Durable per-(user,tenant) membership state. Written only by the SECDEF lifecycle RPCs, atomically inside the lifecycle txn under the readiness advisory lock. Source of the tenant-scoped Deactivated Users list (state=ended, end_reason=removed). Cascades on tenant deletion.';

-- Fast Deactivated-Users lookup for a tenant.
CREATE INDEX IF NOT EXISTS idx_tm_removed
  ON public.tenant_memberships (tenant_id, removed_at DESC)
  WHERE state = 'ended' AND end_reason = 'removed';

-- RLS: Ralli admin global; orgAdmin ONLY their own tenant's rows (mirrors readiness_score_history.rsh_select).
ALTER TABLE public.tenant_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tm_select ON public.tenant_memberships;
CREATE POLICY tm_select ON public.tenant_memberships
  FOR SELECT TO authenticated
  USING ( public.is_ralli_admin()
          OR (tenant_id = public.readiness_caller_tenant() AND public.readiness_caller_is_manager()) );

-- No INSERT/UPDATE/DELETE policy → clients can never write; only SECDEF paths (run as postgres) write.
REVOKE ALL ON public.tenant_memberships FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.tenant_memberships TO authenticated;   -- RLS-gated
GRANT ALL    ON public.tenant_memberships TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- B. INTERNAL RECORD HELPERS (SECDEF, postgres-owner; called only from the SECDEF lifecycle RPCs,
--    which already hold the advisory lock → these run in the same txn under the same lock)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Mark (or create) an ACTIVE membership for (tenant,user) at role p_role. Used by join / reactivate /
-- transfer-in / invitation acceptance. Clears every removal field (constraint tm_active_clear).
CREATE OR REPLACE FUNCTION public.readiness_membership_activate(p_tenant uuid, p_user uuid, p_role text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'readiness_membership_activate: tenant and user required';
  END IF;
  INSERT INTO public.tenant_memberships
    (tenant_id, user_id, state, end_reason, role_at_membership, joined_at, removed_at, removed_by, created_at, updated_at)
  VALUES (p_tenant, p_user, 'active', NULL, p_role, now(), NULL, NULL, now(), now())
  ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET state              = 'active',
        end_reason         = NULL,
        role_at_membership = EXCLUDED.role_at_membership,
        joined_at          = now(),
        removed_at         = NULL,
        removed_by         = NULL,
        updated_at         = now();
END $function$;
REVOKE ALL ON FUNCTION public.readiness_membership_activate(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_membership_activate(uuid,uuid,text) TO service_role;

-- End a membership for (tenant,user). p_reason ∈ {removed, transferred}. For 'removed' the role held
-- IMMEDIATELY BEFORE removal is frozen as role_at_membership and removed_at/removed_by are set; for
-- 'transferred' no removal timestamp/actor is recorded (constraint tm_transferred_clear). Upserts so a
-- member with no prior row (edge) still gets an honest ended row. joined_at is preserved on update.
CREATE OR REPLACE FUNCTION public.readiness_membership_end(p_tenant uuid, p_user uuid, p_role text, p_reason text, p_actor uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN
    RAISE EXCEPTION 'readiness_membership_end: tenant and user required';
  END IF;
  IF p_reason NOT IN ('removed','transferred') THEN
    RAISE EXCEPTION 'readiness_membership_end: illegal reason %', p_reason;
  END IF;
  INSERT INTO public.tenant_memberships
    (tenant_id, user_id, state, end_reason, role_at_membership, joined_at, removed_at, removed_by, created_at, updated_at)
  VALUES (p_tenant, p_user, 'ended', p_reason, p_role, now(),
          CASE WHEN p_reason = 'removed' THEN now()    ELSE NULL END,
          CASE WHEN p_reason = 'removed' THEN p_actor  ELSE NULL END,
          now(), now())
  ON CONFLICT (tenant_id, user_id) DO UPDATE
    SET state              = 'ended',
        end_reason         = EXCLUDED.end_reason,
        role_at_membership = EXCLUDED.role_at_membership,
        removed_at         = EXCLUDED.removed_at,
        removed_by         = EXCLUDED.removed_by,
        updated_at         = now();
        -- joined_at intentionally NOT overwritten (preserve when they originally joined)
END $function$;
REVOKE ALL ON FUNCTION public.readiness_membership_end(uuid,uuid,text,text,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_membership_end(uuid,uuid,text,text,uuid) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- C. WRAPPER AUGMENTATION — record writes AFTER apply, inside the same txn/lock (atomic)
--    Bodies are the exact 091 wrappers + a single record call before RETURN. authz/self/40001 unchanged.
-- ═══════════════════════════════════════════════════════════════════════════════

-- C1. Remove from org: freeze the role held immediately before removal, end membership as 'removed'.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_remove_member(p_user uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_status text; v_role text; v_tenant uuid; v_res jsonb;
BEGIN
  SELECT status, role, tenant_id INTO v_status, v_role, v_tenant FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'remove_member: profile not found'; END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'remove_member: member is already detached'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_tenant);
  IF p_user = auth.uid() THEN RAISE EXCEPTION 'remove_member: cannot remove self'; END IF;
  -- Membership mutation (advisory acquired inside apply; aborts 40001 if the member moved meanwhile).
  v_res := public.readiness_lifecycle_apply(p_user, 'inactive', 'user', NULL,
                                            v_status, v_role, v_tenant, true);
  -- (#4) v_role was read BEFORE apply reset the profile role to 'user' → it is the true previous role.
  PERFORM public.readiness_membership_end(v_tenant, p_user, v_role, 'removed', auth.uid());
  RETURN v_res;
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_remove_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_remove_member(uuid) TO authenticated, service_role;

-- C2. Reactivate a DETACHED member into a tenant → active membership record.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_reactivate_member(p_user uuid, p_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_res jsonb;
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'reactivate_member: tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'reactivate_member: illegal role %', p_role; END IF;
  PERFORM public.readiness_lifecycle_authz(p_tenant);
  v_res := public.readiness_lifecycle_apply(p_user, 'active', p_role, p_tenant,
                                            NULL, NULL, NULL, true, ARRAY['inactive','invited']);
  PERFORM public.readiness_membership_activate(p_tenant, p_user, p_role);
  RETURN v_res;
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) TO authenticated, service_role;

-- C3. Transfer (Ralli-admin only, unchanged authz): end OLD as 'transferred' (NOT a removal → excluded from
--     the Deactivated list), open NEW active membership.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_transfer_member(p_user uuid, p_new_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_old_tenant uuid; v_old_role text; v_res jsonb;
BEGIN
  IF p_new_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: new tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'transfer_member: illegal role %', p_role; END IF;
  SELECT tenant_id, role INTO v_old_tenant, v_old_role FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_member: profile not found'; END IF;
  IF v_old_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: member is detached; use reactivate_member'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_old_tenant);
  PERFORM public.readiness_lifecycle_authz(p_new_tenant);
  v_res := public.readiness_lifecycle_apply(p_user, 'active', p_role, p_new_tenant,
                                            NULL, NULL, v_old_tenant, true);
  PERFORM public.readiness_membership_end(v_old_tenant, p_user, v_old_role, 'transferred', NULL);
  PERFORM public.readiness_membership_activate(p_new_tenant, p_user, p_role);
  RETURN v_res;
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) TO authenticated, service_role;

-- C4. accept_invitation: HARDENED against cross-tenant movement (#8/#9) + records the membership.
--     091 behaviour otherwise preserved. Existing profile may accept ONLY when detached (tenant NULL) or
--     already in the invitation's tenant; an active member of a DIFFERENT org is rejected (transfer is the
--     authorized path). Brand-new profile inserts as before. Membership recorded as active on success.
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
    -- (#8/#9) SECURE CONTRACT: acceptance may NOT move an active member across organisations. If the
    -- profile is already attached to a DIFFERENT tenant, reject — cross-org movement requires an
    -- authorized transfer (Ralli-admin-only). Acceptance may only attach a detached profile (tenant NULL)
    -- or re-affirm/adjust within the SAME tenant.
    IF v_ot IS NOT NULL AND v_ot IS DISTINCT FROM v_inv.tenant_id THEN
      RAISE EXCEPTION 'accept_invitation: account already belongs to another organization; invitation acceptance cannot transfer across organizations (an authorized transfer is required)';
    END IF;
    -- Route the membership transition through the validated engine (read→advisory→locked re-read→abort-if-
    -- stale). Expected = (status,role,tenant) just read; a concurrent change aborts 40001. Name/team applied
    -- only AFTER the membership transition validates.
    PERFORM public.readiness_lifecycle_apply(v_uid, 'active', v_inv.role, v_inv.tenant_id,
                                             v_os, v_or, v_ot, true);
    UPDATE public.profiles SET
      team_id    = COALESCE(v_inv.team_id, team_id),
      name       = CASE WHEN NULLIF(TRIM(p_name),'') IS NOT NULL THEN TRIM(p_name) ELSE name END,
      updated_at = now()
    WHERE id = v_uid;
  ELSE
    -- Brand-new profile: no existing scores; plain insert (guard trigger only fires on UPDATE).
    INSERT INTO public.profiles (id, email, name, role, tenant_id, team_id, status, created_at, updated_at)
    VALUES (
      v_uid,
      COALESCE(v_email, v_inv.admin_email),
      COALESCE(NULLIF(TRIM(p_name), ''), split_part(COALESCE(v_email, v_inv.admin_email), '@', 1)),
      v_inv.role, v_inv.tenant_id, v_inv.team_id, 'active', now(), now()
    );
  END IF;

  -- Record the (re)join: active membership for the invited tenant, at the invited role. Same txn/advisory.
  PERFORM public.readiness_membership_activate(v_inv.tenant_id, v_uid, v_inv.role);

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

-- ═══════════════════════════════════════════════════════════════════════════════
-- D. TENANT-SCOPED READER — the ONLY path an orgAdmin reaches deactivated users
-- ═══════════════════════════════════════════════════════════════════════════════
-- Authorizes the caller against the target tenant (readiness_lifecycle_authz: orgAdmin ⇒ own tenant only;
-- ralli ⇒ any). Joins profiles for identity (needed because a removed member's profile.tenant_id is NULL,
-- so the tenant-scoped profiles RLS would otherwise hide their name/email). Returns ONLY 'removed' rows —
-- 'transferred' rows are never surfaced. No sensitive auth data (no auth.users internals / tokens).
CREATE OR REPLACE FUNCTION public.readiness_list_deactivated_members(p_tenant uuid DEFAULT NULL)
 RETURNS TABLE(user_id uuid, name text, email text, previous_role text, removed_at timestamptz, removed_by uuid)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_tenant uuid;
BEGIN
  v_tenant := COALESCE(p_tenant, public.readiness_caller_tenant());
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'list_deactivated_members: tenant required'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_tenant);   -- orgAdmin ⇒ own tenant only; ralli ⇒ any; else raises
  RETURN QUERY
    SELECT tm.user_id, p.name, p.email, tm.role_at_membership, tm.removed_at, tm.removed_by
      FROM public.tenant_memberships tm
      JOIN public.profiles p ON p.id = tm.user_id
     WHERE tm.tenant_id = v_tenant
       AND tm.state = 'ended'
       AND tm.end_reason = 'removed'
     ORDER BY tm.removed_at DESC;
END $function$;
REVOKE ALL ON FUNCTION public.readiness_list_deactivated_members(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_list_deactivated_members(uuid) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- E. BACKFILL — ACTIVE members only, from the authoritative profile. NEVER detached/removed users.
-- ═══════════════════════════════════════════════════════════════════════════════
-- The profile IS ground truth for a CURRENT membership (tenant_id + role), so this fabricates nothing.
-- Already-removed/detached users (tenant_id NULL) are intentionally excluded — their former tenant lives
-- only in readiness history, which is off-limits — so they never appear in a tenant's Deactivated list.
INSERT INTO public.tenant_memberships
  (tenant_id, user_id, state, end_reason, role_at_membership, joined_at, removed_at, removed_by, created_at, updated_at)
SELECT p.tenant_id, p.id, 'active', NULL, p.role, p.created_at, NULL, NULL, now(), now()
  FROM public.profiles p
 WHERE p.tenant_id IS NOT NULL
   AND p.role IN ('user','manager','orgAdmin')
ON CONFLICT (tenant_id, user_id) DO NOTHING;

COMMIT;

-- ── AUDIT ───────────────────────────────────────────────────────────────────────
--   SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.tenant_memberships'::regclass;
--   SELECT polname,pg_get_expr(polqual,polrelid) FROM pg_policy WHERE polrelid='public.tenant_memberships'::regclass;
--   SELECT tenant_id,state,end_reason,count(*) FROM public.tenant_memberships GROUP BY 1,2,3 ORDER BY 1;
-- ── ROLLBACK: docs/engineering/rollback_093_tenant_membership_record.sql (restores 091 wrappers). ──
-- ─────────────────────────────────────────────────────────────────────────────
