-- ─────────────────────────────────────────────────────────────────────────────
-- SELF-CONTAINED ROLLBACK for migration 091 (readiness learner lifecycle, RPC-first).
-- NOT a migration (lives outside supabase/migrations/ so it is never auto-applied).
--
-- TWO MODES — this rollback is NOT "exact / all-or-nothing" once lifecycle data has diverged:
--   * Section 1 (ALWAYS valid): drop all 091 objects and restore the EXACT pre-091 bodies + grants of the
--     four functions 091 replaced (readiness_is_scorable_rep, enqueue_readiness_recalc, accept_invitation,
--     delete_tenant). This alone returns all *behaviour* to pre-091.
--   * Section 2 (FK restore) is valid ONLY BEFORE lifecycle divergence. After any tenant transfer/removal,
--     a user's history may sit under tenant A while the profile moved to B, so re-adding the composite
--     (user_id,tenant_id) history FK would fail validation. Section 2 PROBES for that and FAILS CLOSED with
--     a clear message rather than partially restoring — never deleting or rewriting immutable history.
--     When it fails closed, the forward-correction outcome is: keep the identity FKs (they are required by
--     the preserved divergent history); behaviour is already restored by Section 1.
--
-- Preserves migrations 087–090 and the three existing crons. Idempotent-ish (IF EXISTS / OR REPLACE).
-- 091 is additive to profiles permissions: it does NOT revoke grants, change the profiles_update_own policy,
-- or add the guard trigger (that lockdown is migration 092). So this rollback leaves grants/policy untouched;
-- if 092 is applied, revert it with rollback_092_profile_write_lockdown.sql (and note that reverting 092
-- re-opens the direct self-escalation surface).
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══ SECTION 1 — drop 091 objects; restore exact pre-091 function bodies + grants (ALWAYS valid) ═══

-- 1a. remove the 091 cron (only ours)
DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_reconcile_cleanup'; END $r$;

-- 1b. drop 091 triggers + functions. (The profiles lifecycle guard + grant lockdown are NOT part of 091 —
--     they live in migration 092; roll those back with rollback_092 if 092 has been applied.)
DROP TRIGGER IF EXISTS trg_readiness_scores_current_write_guard ON public.readiness_scores_current;
DROP FUNCTION IF EXISTS public.readiness_scores_current_write_guard();
DROP FUNCTION IF EXISTS public.readiness_reconcile_cleanup(integer);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_remove_member(uuid);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_reactivate_member(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_change_role(uuid,text);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_transfer_member(uuid,uuid,text);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_apply(uuid,text,text,uuid,text,text,uuid,boolean,text[]);
DROP FUNCTION IF EXISTS public.readiness_lifecycle_authz(uuid);
DROP FUNCTION IF EXISTS public.readiness_begin_lifecycle_write(uuid,uuid[]);
DROP FUNCTION IF EXISTS public.ensure_self_profile(text,text,text,text,jsonb);
DROP FUNCTION IF EXISTS public.readiness_lock_key(uuid,uuid);

-- 1c. restore EXACT pre-091 readiness_is_scorable_rep (087)
CREATE OR REPLACE FUNCTION public.readiness_is_scorable_rep(p_tenant uuid, p_user uuid)
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role = 'user'
  );
$function$;
REVOKE ALL ON FUNCTION public.readiness_is_scorable_rep(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_is_scorable_rep(uuid,uuid) TO service_role;

-- 1d. restore EXACT pre-091 enqueue_readiness_recalc (053)
CREATE OR REPLACE FUNCTION public.enqueue_readiness_recalc(p_tenant uuid, p_user uuid, p_version uuid, p_reason text, p_source jsonb DEFAULT NULL::jsonb)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_target     text := COALESCE(p_version::text, 'ACTIVE');
  v_is_rep     boolean;
  v_constraint text;
  v_guard      int := 0;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN RETURN; END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role NOT IN ('orgAdmin','ralli_admin','superadmin')
  ) INTO v_is_rep;
  IF NOT v_is_rep THEN RETURN; END IF;

  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 5 THEN
      RAISE EXCEPTION 'enqueue_readiness_recalc: coalescing did not converge for %/%/%', p_tenant, p_user, v_target;
    END IF;

    UPDATE public.readiness_recalc_queue
       SET reason = p_reason,
           source_ref = COALESCE(p_source, source_ref),
           updated_at = now(),
           rerun_requested = rerun_requested OR (status = 'processing'),
           next_attempt_at = LEAST(next_attempt_at, now())
     WHERE tenant_id = p_tenant AND user_id = p_user AND target_key = v_target
       AND status IN ('pending','processing');
    IF FOUND THEN RETURN; END IF;

    BEGIN
      INSERT INTO public.readiness_recalc_queue (tenant_id, user_id, formula_version_id, reason, source_ref)
      VALUES (p_tenant, p_user, p_version, p_reason, p_source);
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint IS DISTINCT FROM 'uq_recalc_live_job' THEN
        RAISE;
      END IF;
    END;
  END LOOP;
END $function$;
REVOKE ALL ON FUNCTION public.enqueue_readiness_recalc(uuid,uuid,uuid,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_readiness_recalc(uuid,uuid,uuid,text,jsonb) TO service_role;

-- 1e. restore EXACT pre-091 accept_invitation (search_path=public; anon+authenticated grants)
CREATE OR REPLACE FUNCTION public.accept_invitation(p_token text, p_name text DEFAULT NULL::text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_inv    tenant_invitations%ROWTYPE;
  v_uid    UUID := auth.uid();
  v_email  TEXT;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'accept_invitation: must be authenticated'; END IF;
  SELECT * INTO v_inv FROM tenant_invitations WHERE token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'accept_invitation: invitation not found'; END IF;
  IF v_inv.expires_at < NOW() THEN RAISE EXCEPTION 'accept_invitation: invitation has expired'; END IF;
  IF v_inv.status = 'accepted' THEN RAISE EXCEPTION 'accept_invitation: invitation already accepted'; END IF;
  SELECT email INTO v_email FROM auth.users WHERE id = v_uid;
  INSERT INTO profiles (id, email, name, role, tenant_id, team_id, status, created_at, updated_at)
  VALUES (
    v_uid, COALESCE(v_email, v_inv.admin_email),
    COALESCE(NULLIF(TRIM(p_name), ''), split_part(COALESCE(v_email, v_inv.admin_email), '@', 1)),
    v_inv.role, v_inv.tenant_id, v_inv.team_id, 'active', NOW(), NOW()
  )
  ON CONFLICT (id) DO UPDATE SET
    tenant_id  = EXCLUDED.tenant_id,
    role       = EXCLUDED.role,
    team_id    = COALESCE(v_inv.team_id, profiles.team_id),
    name       = CASE WHEN NULLIF(TRIM(p_name), '') IS NOT NULL THEN TRIM(p_name) ELSE profiles.name END,
    status     = 'active',
    updated_at = NOW();
  UPDATE tenant_invitations SET
    status      = 'accepted',
    accepted_at = NOW(),
    onboarding_state = onboarding_state || jsonb_build_object(
      'currentStep',    'account_created',
      'stepsCompleted', (onboarding_state->'stepsCompleted') || '["invited"]'::jsonb,
      'acceptedAt',     NOW())
  WHERE id = v_inv.id;
  UPDATE tenants SET status = 'onboarding', updated_at = NOW()
  WHERE id = v_inv.tenant_id AND status = 'invited';
  RETURN jsonb_build_object(
    'userId', v_uid, 'tenantId', v_inv.tenant_id, 'role', v_inv.role, 'teamId', v_inv.team_id,
    'name', COALESCE(NULLIF(TRIM(p_name), ''), split_part(COALESCE(v_email, v_inv.admin_email), '@', 1)),
    'email', COALESCE(v_email, v_inv.admin_email));
END;
$function$;
REVOKE ALL ON FUNCTION public.accept_invitation(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text,text) TO anon, authenticated, service_role;

-- 1f. restore EXACT pre-091 delete_tenant (search_path=public; anon+authenticated grants)
CREATE OR REPLACE FUNCTION public.delete_tenant(p_tenant_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_uid       UUID := auth.uid();
  v_role      TEXT;
  v_name      TEXT;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_uid;
  IF v_role NOT IN ('ralli_admin', 'superadmin') THEN
    RAISE EXCEPTION 'delete_tenant: requires ralli_admin role';
  END IF;
  SELECT name INTO v_name FROM tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'delete_tenant: tenant not found'; END IF;
  UPDATE profiles SET tenant_id = NULL, role = 'user', updated_at = NOW() WHERE tenant_id = p_tenant_id;
  DELETE FROM tenant_invitations WHERE tenant_id = p_tenant_id;
  DELETE FROM tenant_settings    WHERE tenant_id = p_tenant_id;
  DELETE FROM tenants WHERE id = p_tenant_id;
  RETURN jsonb_build_object('tenantId', p_tenant_id, 'name', v_name, 'deleted', true);
END;
$function$;
REVOKE ALL ON FUNCTION public.delete_tenant(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.delete_tenant(uuid) TO anon, authenticated, service_role;

-- (1g removed: 091 no longer changes profiles grants or the profiles_update_own policy — those are in 092.
--  Use rollback_092 to revert the profile-write lockdown if 092 has been applied.)

-- ═══ SECTION 2 — FK restore: PRE-DIVERGENCE ONLY. Fails closed after any transfer/removal. ═══
DO $fk$
DECLARE v_diverged boolean;
BEGIN
  SELECT EXISTS (
      SELECT 1 FROM public.readiness_score_history h
       WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = h.user_id AND p.tenant_id = h.tenant_id)
    ) OR EXISTS (
      SELECT 1 FROM public.readiness_recalc_queue q
       WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = q.user_id AND p.tenant_id = q.tenant_id)
    )
  INTO v_diverged;

  IF v_diverged THEN
    RAISE EXCEPTION USING
      MESSAGE = 'rollback_091 Section 2 refused: lifecycle data has DIVERGED (history/queue rows exist under '
              || 'a tenant the profile no longer belongs to). Re-adding the composite (user_id,tenant_id) FK '
              || 'would fail validation, and immutable history must NEVER be deleted to force it. Section 1 has '
              || 'already restored all pre-091 behaviour; INTENTIONALLY KEEP the identity FKs (rsh_user_fk / '
              || 'rrq_user_fk) — they are required by the preserved divergent history. This is the documented '
              || 'forward-correction outcome, not a failure.',
      ERRCODE = 'raise_exception';
  END IF;

  -- No divergence → safe to restore the exact pre-091 composite FKs.
  ALTER TABLE public.readiness_score_history DROP CONSTRAINT IF EXISTS rsh_user_fk;
  ALTER TABLE public.readiness_score_history ADD  CONSTRAINT rsh_user_same_tenant
    FOREIGN KEY (user_id, tenant_id) REFERENCES public.profiles(id, tenant_id) ON DELETE CASCADE;
  ALTER TABLE public.readiness_recalc_queue  DROP CONSTRAINT IF EXISTS rrq_user_fk;
  ALTER TABLE public.readiness_recalc_queue  ADD  CONSTRAINT rrq_user_same_tenant
    FOREIGN KEY (user_id, tenant_id) REFERENCES public.profiles(id, tenant_id) ON DELETE CASCADE;
  RAISE NOTICE 'rollback_091 Section 2: no divergence → composite FKs restored.';
END $fk$;

COMMIT;

-- NOTE: 091 does NOT change profiles grants or the profiles_update_own policy (that lockdown is migration
-- 092). This rollback therefore leaves grants/policy exactly as they were — no grant restore is needed here.
-- If 092 has been applied, revert the lockdown with docs/engineering/rollback_092_profile_write_lockdown.sql.
-- ─────────────────────────────────────────────────────────────────────────────
