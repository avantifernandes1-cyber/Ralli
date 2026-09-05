-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 091 — Readiness V2: LEARNER LIFECYCLE (RPC-first advisory ordering) — ADDITIVE + FK REMODEL
--
-- Makes readiness reflect who is CURRENTLY an eligible learner (role='user' AND status='active'
-- AND a non-null tenant), while preserving immutable history under its ORIGINAL tenant across
-- deactivation, role change, tenant transfer and removal — with a provably deadlock-free design
-- that includes the profiles-row / FK KEY SHARE lock, not just the queue and advisory locks.
--
-- WHY RPC-FIRST (the deadlock this fixes):
--   The worker's INSERT readiness_scores_current takes a FOR KEY SHARE lock on the parent profiles
--   row (FK rsc_user_same_tenant). A lifecycle `UPDATE profiles SET tenant_id` changes a referenced
--   key column and takes FOR UPDATE on that row — which conflicts with FOR KEY SHARE. A BEFORE trigger
--   runs AFTER its UPDATE already holds the profile-row lock, so it could only take the advisory after
--   the profile lock: lifecycle = profile-lock → advisory while worker = advisory → profile-KEY-SHARE.
--   That inversion deadlocks. A trigger can NEVER take the advisory before the profile-row lock, so all
--   status/role/tenant mutations must go through advisory-FIRST RPCs.
--
-- ONE GLOBAL LOCK ORDER (every agent acquires a subsequence; no inversion):
--   (1) queue row lock  ≺  (2) readiness advisory  ≺  (3) scores_current row lock  ≺  (4) profiles row / FK KEY SHARE
--   * Worker:        (1) claim queue row → (2) advisory in the scores_current write-guard → (3)+(4) insert.
--   * Lifecycle RPC: (2) advisory (readiness_begin_lifecycle_write) → (3) delete old-tenant current → (4) UPDATE profiles.
--                    NEVER touches (1); NEVER enqueues.
--   * Cleanup sweep: (2) advisory → (3) delete stale current.        NEVER enqueues, NEVER (4).
--   * Enqueue (089 recovery / 088 attempt / 090 propagation): (1) queue only. NEVER takes the advisory.
--   No agent that holds the advisory ever ACQUIRES a queue-row lock it does not already hold, so no cycle
--   can form (the worker claims its queue rows via FOR UPDATE SKIP LOCKED BEFORE any advisory).
--
-- CANONICAL ELIGIBILITY (fail-closed): enforced at the two chokepoints every path funnels through —
--   readiness_is_scorable_rep (score-write gate; used by compute_v2 AND the new write-guard) and
--   enqueue_readiness_recalc (enqueue gate; every enqueue path PERFORMs it). Making these two active-only
--   makes the whole pipeline canonical end-to-end; the inline `<>'inactive'` pre-filters in 087/089/090
--   remain only as non-authoritative optimisations (they can over-select; the chokepoints drop the rest).
--
-- FK REMODEL — so tenant transfer/removal never BLOCKS, and the HISTORY-RETENTION CONTRACT is exact:
--   HISTORY CONTRACT (product-approved):
--     • A learner removed / deactivated / transferred → their history is PRESERVED under its ORIGINAL tenant
--       (the identity user FK below tracks the person, not the membership, so detach/move never touches it).
--     • Permanently deleting the ENTIRE organisation → its tenant-scoped history is DELETED intentionally
--       (readiness_score_history.tenant_id -> tenants ON DELETE CASCADE, and the (formula_version_id,tenant_id)
--       -> readiness_formula_versions CASCADE — BOTH pre-existing from 087 and left UNCHANGED here). So
--       delete_tenant, which hard-deletes the tenant row, cascades away that org's readiness history by design.
--       History does NOT survive tenant deletion — only learner-lifecycle changes.
--   * readiness_score_history user FK: composite (user_id,tenant_id)->profiles(id,tenant_id) becomes identity
--     (user_id)->profiles(id) ON DELETE RESTRICT. tenant_id stays an immutable stored column (RLS-scoped).
--     RESTRICT ⇒ deleting a single PROFILE/auth user cannot silently erase that learner's history (a future
--     explicit privacy/GDPR anonymisation workflow is REQUIRED before permanent ACCOUNT deletion — post-beta).
--     This is orthogonal to the tenant-CASCADE above: account deletion is gated; org deletion cascades.
--   * readiness_recalc_queue: composite becomes identity (user_id)->profiles(id) ON DELETE CASCADE, so
--     old-tenant terminal (completed/failed/dead_letter) rows survive a transfer with their original
--     tenant_id (operational history, RLS keeps them tenant-A scoped) and are not deleted casually.
--   * readiness_scores_current: KEEPS the composite FK (a CURRENT score must equal the current tenant);
--     the lifecycle RPC deletes the old-tenant current row before the tenant change, so it never blocks.
--
-- SECURITY: all new/replaced functions owner postgres, SET search_path='', REVOKE from anon/authenticated,
--   grants only as required. ensure_self_profile (server-authoritative creation) is added here.
--   ZERO-DOWNTIME STAGING: the profiles direct-write LOCKDOWN — revoking the broad legacy grants, re-granting
--   only safe presentation columns, adding the own-row WITH CHECK, and the fail-closed guard trigger that
--   forbids any status/role/tenant change outside a lifecycle RPC — is DEFERRED to migration 092, because it
--   is incompatible with the currently-deployed frontend. 091 leaves those legacy grants intact (no worse than
--   today) so the deployed createMissingProfile fallback keeps working; 092 closes the bypass AFTER the
--   ffc0e2b frontend is deployed and the legacy write path is proven unused. The lifecycle RPCs already stamp
--   the per-user marker, so no rework is needed when 092's guard lands.
--
-- NOT TOUCHED: migrations 087–090 objects except the two eligibility chokepoints; the three existing crons
--   (readiness_recalc_consumer, readiness_recovery_sweep, readiness_propagation_worker); the V2 formula/math;
--   readiness_score_history rows (immutable); the 088 worker/trigger. XP is NOT addressed here — the
--   user_point_events self-award vulnerability is recorded as the immediate next high-priority task.
-- ─────────────────────────────────────────────────────────────────────────────

BEGIN;

-- ═══════════════════════════════════════════════════════════════════════════════
-- A. CANONICAL ELIGIBILITY — the two chokepoints (active-only, role='user', fail-closed)
-- ═══════════════════════════════════════════════════════════════════════════════

-- A1. Score-write gate. Only change: COALESCE(status,'active')<>'inactive'  →  status='active'.
CREATE OR REPLACE FUNCTION public.readiness_is_scorable_rep(p_tenant uuid, p_user uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND p.status = 'active'
      AND p.role = 'user'
  );
$function$;
REVOKE ALL ON FUNCTION public.readiness_is_scorable_rep(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_is_scorable_rep(uuid,uuid) TO service_role;

-- A2. Enqueue gate. Only change: population guard → status='active' AND role='user'
--     (was COALESCE(status,'active')<>'inactive' AND role NOT IN ('orgAdmin','ralli_admin','superadmin')).
--     Everything else (coalescing loop) is byte-for-byte the deployed body.
CREATE OR REPLACE FUNCTION public.enqueue_readiness_recalc(p_tenant uuid, p_user uuid, p_version uuid, p_reason text, p_source jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_target     text := COALESCE(p_version::text, 'ACTIVE');
  v_is_rep     boolean;
  v_constraint text;
  v_guard      int := 0;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN RETURN; END IF;

  -- Population guard: CANONICAL active scorable rep of this exact tenant only.
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND p.status = 'active'
      AND p.role = 'user'
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

-- ═══════════════════════════════════════════════════════════════════════════════
-- B. FK REMODEL — history/queue to identity; current keeps composite
-- ═══════════════════════════════════════════════════════════════════════════════
-- history: ONLY the user FK changes — composite (user_id,tenant_id) → identity (user_id)->profiles(id)
-- RESTRICT, so a learner detach/transfer/removal preserves their history under its original tenant and a
-- single account cannot be hard-deleted out from under its history. The OTHER two history FKs are LEFT
-- UNCHANGED from 087 and remain ON DELETE CASCADE: tenant_id->tenants(id) and
-- (formula_version_id,tenant_id)->readiness_formula_versions(id,tenant_id). Therefore permanently deleting
-- the ENTIRE tenant (delete_tenant) intentionally cascades away that org's readiness history — history is
-- preserved across LEARNER-lifecycle changes but NOT across ORGANISATION deletion.
ALTER TABLE public.readiness_score_history  DROP CONSTRAINT rsh_user_same_tenant;
ALTER TABLE public.readiness_score_history  ADD  CONSTRAINT rsh_user_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE RESTRICT;
-- queue: identity FK, CASCADE (terminal rows survive transfer under original tenant; cascade on profile delete)
ALTER TABLE public.readiness_recalc_queue   DROP CONSTRAINT rrq_user_same_tenant;
ALTER TABLE public.readiness_recalc_queue   ADD  CONSTRAINT rrq_user_fk
  FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
-- current: rsc_user_same_tenant is intentionally UNCHANGED (composite; enforces current==current tenant).

-- ═══════════════════════════════════════════════════════════════════════════════
-- C. LOCK KEY + ADVISORY-FIRST LIFECYCLE ENTRY POINT
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_lock_key(p_tenant uuid, p_user uuid)
 RETURNS bigint
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT pg_catalog.hashtextextended(
    'readiness:' || COALESCE(p_tenant::text,'-') || ':' || COALESCE(p_user::text,'-'), 0)
$function$;
REVOKE ALL ON FUNCTION public.readiness_lock_key(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lock_key(uuid,uuid) TO service_role;

-- Advisory-FIRST primitive: acquire the readiness advisory lock for every DISTINCT non-null tenant
-- for p_user, in ASCENDING lock-key order (deterministic ⇒ no lifecycle-vs-lifecycle deadlock), and set
-- a transaction-local marker (keyed to txid) that the profiles guard trigger requires. MUST be called
-- BEFORE any profiles write and BEFORE taking the profile row lock (that is the whole point).
CREATE OR REPLACE FUNCTION public.readiness_begin_lifecycle_write(p_user uuid, p_tenants uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_key bigint;
BEGIN
  IF p_user IS NULL THEN RAISE EXCEPTION 'readiness_begin_lifecycle_write: p_user required'; END IF;
  FOR v_key IN
    SELECT DISTINCT public.readiness_lock_key(t, p_user) AS k
      FROM unnest(p_tenants) AS t
     WHERE t IS NOT NULL
     ORDER BY k
  LOOP
    PERFORM pg_advisory_xact_lock(v_key);
  END LOOP;
  -- Marker is the SPECIFIC user id: it authorizes a guarded write ONLY to this profile row, not any row.
  -- set_config(is_local=true) is transaction-scoped and resets at txn end (cannot leak across the pooled
  -- connection's next request). In production each lifecycle RPC is its own transaction.
  PERFORM set_config('readiness.lifecycle_write', p_user::text, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_begin_lifecycle_write(uuid,uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_begin_lifecycle_write(uuid,uuid[]) TO service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- D. SCORES_CURRENT WRITE-GUARD (final eligibility check under the shared advisory)
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_scores_current_write_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
BEGIN
  -- Acquire the SAME advisory the lifecycle path uses, BEFORE the row insert takes the FK KEY SHARE on
  -- profiles. Order stays (2) advisory ≺ (3)/(4). Then the FINAL eligibility check: if the learner is no
  -- longer a scorable rep of this tenant, skip the write (RETURN NULL) so no stale current row can survive.
  PERFORM pg_advisory_xact_lock(public.readiness_lock_key(NEW.tenant_id, NEW.user_id));
  IF NOT public.readiness_is_scorable_rep(NEW.tenant_id, NEW.user_id) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $function$;
REVOKE ALL ON FUNCTION public.readiness_scores_current_write_guard() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_readiness_scores_current_write_guard ON public.readiness_scores_current;
CREATE TRIGGER trg_readiness_scores_current_write_guard
  BEFORE INSERT OR UPDATE ON public.readiness_scores_current
  FOR EACH ROW EXECUTE FUNCTION public.readiness_scores_current_write_guard();

-- ═══════════════════════════════════════════════════════════════════════════════
-- E. PROFILES LIFECYCLE GUARD — DEFERRED TO MIGRATION 092 (zero-downtime staged rollout).
-- ═══════════════════════════════════════════════════════════════════════════════
-- The fail-closed guard trigger that forbids any status/role/tenant change outside a lifecycle RPC, and the
-- profiles GRANT revocation + own-row WITH CHECK, are the "close the bypass" step. They are INCOMPATIBLE with
-- the CURRENTLY-DEPLOYED frontend (its createMissingProfile still upserts role/status directly), so they are
-- NOT in this migration. 091 is ADDITIVE/BACKWARD-COMPATIBLE: it leaves the existing profiles grants intact
-- so the deployed fallback keeps working, while adding all the lifecycle machinery + ensure_self_profile.
-- After the ffc0e2b frontend is deployed and verified to use ensure_self_profile / lifecycle RPCs, migration
-- 092 adds the guard trigger, revokes the legacy profile-write grants, and adds the own-row WITH CHECK.
-- (The lifecycle RPCs already stamp the per-user marker via readiness_begin_lifecycle_write; it is a harmless
--  no-op until 092's guard reads it, so no change is needed to those functions when 092 lands.)

-- ═══════════════════════════════════════════════════════════════════════════════
-- F. LIFECYCLE CORE (safeguard #1: read → advisory → re-read+lock → recompute → abort-if-stale → apply)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Internal engine. Absolute target state (p_new_*). Expected-precondition (p_expect_*, NULL = don't care)
-- is verified against the FRESH locked state so a race between the initial read and advisory acquisition
-- aborts instead of applying a stale transition. NEVER enqueues (089 handles the score direction async).
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_apply(
  p_user          uuid,
  p_new_status    text,
  p_new_role      text,
  p_new_tenant    uuid,
  p_expect_status text DEFAULT NULL,
  p_expect_role   text DEFAULT NULL,
  p_expect_tenant uuid DEFAULT NULL,
  p_expect_tenant_set boolean DEFAULT false,  -- when true, p_expect_tenant (incl NULL) is asserted
  p_expect_status_in text[] DEFAULT NULL      -- when set, the locked status must be a member of this set
)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_os text; v_or text; v_ot uuid;      -- apparent (unlocked) read
  v_ls text; v_lr text; v_lt uuid;      -- fresh locked read
BEGIN
  IF p_new_status NOT IN ('active','inactive','suspended','invited') THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: illegal status %', p_new_status;
  END IF;
  IF p_new_role NOT IN ('user','manager','orgAdmin','ralli_admin') THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: illegal role %', p_new_role;
  END IF;

  -- (1) apparent read (no lock)
  SELECT status, role, tenant_id INTO v_os, v_or, v_ot FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'readiness_lifecycle_apply: profile % not found', p_user; END IF;

  -- (2) advisory FIRST for old+new tenant (sorted, deterministic) + marker
  PERFORM public.readiness_begin_lifecycle_write(p_user, ARRAY[v_ot, p_new_tenant]);

  -- (3) re-read WITH the profile row lock (taken AFTER the advisory — correct order)
  SELECT status, role, tenant_id INTO v_ls, v_lr, v_lt FROM public.profiles WHERE id = p_user FOR UPDATE;

  -- (4) recompute from the FRESH LOCKED state; every unmet precondition aborts with 40001 so a caller whose
  -- authorization/read went stale during the advisory wait retries against fresh state (never applies stale).
  IF (v_ls, v_lr, v_lt) IS DISTINCT FROM (v_os, v_or, v_ot) THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: profile % changed concurrently; retry', p_user
      USING ERRCODE = '40001';   -- serialization_failure ⇒ caller may safely retry
  END IF;
  -- (#7 fix) validate STATUS against v_ls (was erroneously gating on v_lr / role).
  IF p_expect_status IS NOT NULL AND v_ls IS DISTINCT FROM p_expect_status THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: expected status % but locked %; retry', p_expect_status, v_ls
      USING ERRCODE = '40001';
  END IF;
  IF p_expect_status_in IS NOT NULL AND NOT (v_ls = ANY(p_expect_status_in)) THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: locked status % is not in the allowed set % for this transition', v_ls, p_expect_status_in
      USING ERRCODE = '40001';
  END IF;
  IF p_expect_role IS NOT NULL AND v_lr IS DISTINCT FROM p_expect_role THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: expected role % but locked %; retry', p_expect_role, v_lr
      USING ERRCODE = '40001';
  END IF;
  IF p_expect_tenant_set AND v_lt IS DISTINCT FROM p_expect_tenant THEN
    RAISE EXCEPTION 'readiness_lifecycle_apply: expected tenant % but locked % (authorization stale); retry', p_expect_tenant, v_lt
      USING ERRCODE = '40001';
  END IF;

  -- No material change? Do nothing (no delete, no update, no history churn).
  IF (v_ls, v_lr, v_lt) IS NOT DISTINCT FROM (p_new_status, p_new_role, p_new_tenant) THEN
    RETURN jsonb_build_object('userId', p_user, 'changed', false,
                              'status', v_ls, 'role', v_lr, 'tenantId', v_lt);
  END IF;

  -- (5) de-score cleanup: if the learner will NOT be a scorable rep of the OLD tenant, remove that
  -- tenant's current row now (unblocks the composite FK for a tenant change; immediate de-score otherwise).
  IF v_lt IS NOT NULL
     AND NOT (p_new_tenant IS NOT DISTINCT FROM v_lt AND p_new_status = 'active' AND p_new_role = 'user') THEN
    DELETE FROM public.readiness_scores_current WHERE user_id = p_user AND tenant_id = v_lt;
  END IF;

  -- (6) apply the membership change (advisory already held ⇒ correct lock order vs the worker's FK lock)
  UPDATE public.profiles
     SET status = p_new_status, role = p_new_role, tenant_id = p_new_tenant, updated_at = now()
   WHERE id = p_user;

  -- (7) NO enqueue here. Becoming-scorable recomputes asynchronously via the 089 recovery sweep.
  RETURN jsonb_build_object('userId', p_user, 'changed', true,
                            'status', p_new_status, 'role', p_new_role, 'tenantId', p_new_tenant);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_apply(uuid,text,text,uuid,text,text,uuid,boolean,text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_apply(uuid,text,text,uuid,text,text,uuid,boolean,text[]) TO service_role;

-- Authorization helper: caller must be ralli_admin/superadmin, or an orgAdmin of the target's tenant.
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_authz(p_target_tenant uuid)
 RETURNS void
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_role text; v_tenant uuid;
BEGIN
  SELECT role, tenant_id INTO v_role, v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_role IN ('ralli_admin','superadmin') THEN RETURN; END IF;
  IF v_role = 'orgAdmin' AND v_tenant IS NOT NULL AND v_tenant = p_target_tenant THEN RETURN; END IF;
  RAISE EXCEPTION 'readiness_lifecycle: not authorized';
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_authz(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_authz(uuid) TO service_role;

-- ── F1. Remove a member (reversible; identity + history preserved; current removed immediately) ──
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_remove_member(p_user uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_status text; v_role text; v_tenant uuid;
BEGIN
  SELECT status, role, tenant_id INTO v_status, v_role, v_tenant FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'remove_member: profile not found'; END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'remove_member: member is already detached'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_tenant);         -- authorized against v_tenant …
  IF p_user = auth.uid() THEN RAISE EXCEPTION 'remove_member: cannot remove self'; END IF;
  -- (#1 fix) … which is asserted (mandatory) against the FRESH LOCKED tenant. If the member transferred
  -- between authorization and the lock, apply aborts 40001 — an old-tenant admin can never remove them from
  -- their new tenant. inactive + detached; role reset to user; history stays under its original tenant.
  RETURN public.readiness_lifecycle_apply(p_user, 'inactive', 'user', NULL,
                                          v_status, v_role, v_tenant, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_remove_member(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_remove_member(uuid) TO authenticated, service_role;

-- ── F2. Reactivate / reinvite an existing member into a tenant (async recompute via 089) ──
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_reactivate_member(p_user uuid, p_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
BEGIN
  IF p_tenant IS NULL THEN RAISE EXCEPTION 'reactivate_member: tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'reactivate_member: illegal role %', p_role; END IF;
  PERFORM public.readiness_lifecycle_authz(p_tenant);
  -- (#2 fix) Reactivation may ONLY claim a DETACHED profile (locked tenant IS NULL) that is inactive/invited.
  -- If the profile is currently attached to another org, apply aborts (40001) — a destination admin can
  -- never pull an attached member out of their org this way; moving an attached member must use
  -- transfer_member (which requires authorization over BOTH origin and destination).
  RETURN public.readiness_lifecycle_apply(p_user, 'active', p_role, p_tenant,
                                          NULL, NULL, NULL, true, ARRAY['inactive','invited']);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_reactivate_member(uuid,uuid,text) TO authenticated, service_role;

-- ── F3. Change a member's role within their tenant ──
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_change_role(p_user uuid, p_role text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_tenant uuid; v_status text; v_role text;
BEGIN
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'change_role: illegal role %', p_role; END IF;
  SELECT tenant_id, status, role INTO v_tenant, v_status, v_role FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'change_role: profile not found'; END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'change_role: member has no tenant'; END IF;
  PERFORM public.readiness_lifecycle_authz(v_tenant);
  -- Assert the authorized tenant AND the read status/role survive to the locked read: a concurrent
  -- transfer or deactivation aborts 40001 rather than clobbering status or writing to the wrong tenant.
  RETURN public.readiness_lifecycle_apply(p_user, v_status, p_role, v_tenant,
                                          v_status, v_role, v_tenant, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_change_role(uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_change_role(uuid,text) TO authenticated, service_role;

-- ── F4. Transfer/reassociate a member to another tenant ──
CREATE OR REPLACE FUNCTION public.readiness_lifecycle_transfer_member(p_user uuid, p_new_tenant uuid, p_role text DEFAULT 'user')
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO '' AS $function$
DECLARE v_old_tenant uuid;
BEGIN
  IF p_new_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: new tenant required'; END IF;
  IF p_role NOT IN ('user','manager','orgAdmin') THEN RAISE EXCEPTION 'transfer_member: illegal role %', p_role; END IF;
  SELECT tenant_id INTO v_old_tenant FROM public.profiles WHERE id = p_user;
  IF NOT FOUND THEN RAISE EXCEPTION 'transfer_member: profile not found'; END IF;
  IF v_old_tenant IS NULL THEN RAISE EXCEPTION 'transfer_member: member is detached; use reactivate_member'; END IF;
  -- caller must be authorized over BOTH the origin and destination tenants
  PERFORM public.readiness_lifecycle_authz(v_old_tenant);
  PERFORM public.readiness_lifecycle_authz(p_new_tenant);
  -- (#3 fix) the authorized ORIGIN is asserted against the FRESH LOCKED tenant: if a concurrent move made
  -- the origin authorization stale, apply aborts 40001 and the caller must re-authorize + retry.
  RETURN public.readiness_lifecycle_apply(p_user, 'active', p_role, p_new_tenant,
                                          NULL, NULL, v_old_tenant, true);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_lifecycle_transfer_member(uuid,uuid,text) TO authenticated, service_role;

-- ═══════════════════════════════════════════════════════════════════════════════
-- G. RECONCILE CLEANUP (advisory + delete only; NEVER enqueues). Enqueue is the 089 sweep (no advisory).
-- ═══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_reconcile_cleanup(p_limit integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_row record; v_lim int := GREATEST(COALESCE(p_limit,500),1); v_deleted int := 0;
BEGIN
  FOR v_row IN
    SELECT sc.user_id, sc.tenant_id
      FROM public.readiness_scores_current sc
     WHERE NOT public.readiness_is_scorable_rep(sc.tenant_id, sc.user_id)
     ORDER BY sc.tenant_id, sc.user_id
     LIMIT v_lim
  LOOP
    -- advisory FIRST (serialize with the worker's write-guard), then delete. NO queue write.
    PERFORM pg_advisory_xact_lock(public.readiness_lock_key(v_row.tenant_id, v_row.user_id));
    DELETE FROM public.readiness_scores_current
     WHERE user_id = v_row.user_id AND tenant_id = v_row.tenant_id
       AND NOT public.readiness_is_scorable_rep(v_row.tenant_id, v_row.user_id);
    v_deleted := v_deleted + (CASE WHEN FOUND THEN 1 ELSE 0 END);
  END LOOP;
  RETURN jsonb_build_object('deleted', v_deleted, 'limit', v_lim);
END $function$;
REVOKE ALL ON FUNCTION public.readiness_reconcile_cleanup(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_reconcile_cleanup(integer) TO service_role;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $cron$
DECLARE c_job text := 'readiness_reconcile_cleanup'; c_sched text := '* * * * *';
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = c_job;
  PERFORM cron.schedule(c_job, c_sched, 'SELECT public.readiness_reconcile_cleanup();');
  RAISE NOTICE '091: scheduled % (%)', c_job, c_sched;
END $cron$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- H. PROFILE CREATION RPC + GRANT HARDENING (close direct self-escalation)
-- ═══════════════════════════════════════════════════════════════════════════════
-- Narrow creation: identity from auth.uid(); role/status hardcoded; accepts only safe presentation fields.
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

-- PROFILES GRANT HARDENING + own-row WITH CHECK are DEFERRED TO MIGRATION 092 (zero-downtime staged rollout).
-- 091 is additive: ensure_self_profile is now AVAILABLE (the ffc0e2b frontend will use it), but the broad
-- legacy profiles write grants are intentionally LEFT INTACT so the currently-deployed frontend's
-- createMissingProfile fallback (a direct upsert of role/status on the caller's own row) keeps working during
-- the rollout. Only after that frontend is deployed and the legacy write path is proven unused does 092
-- REVOKE the broad grants, re-grant just the safe presentation columns, and add the WITH CHECK.

-- ═══════════════════════════════════════════════════════════════════════════════
-- I. HARDEN + RPC-ROUTE THE TWO DEPLOYED SCORABILITY WRITERS (accept_invitation, delete_tenant)
--    search_path='' + fully-qualified; every status/role/tenant change routes through the lifecycle path.
-- ═══════════════════════════════════════════════════════════════════════════════

-- accept_invitation: brand-new profile → plain insert (no advisory needed). Existing profile whose
-- tenant/role/status changes → advisory-first via begin_lifecycle_write + delete old-tenant current.
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
    -- (#4 fix) Existing profile → route the membership transition through the validated lifecycle engine,
    -- which performs the FULL read → advisory → fresh LOCKED re-read → validation contract: expected =
    -- (status,role,tenant) we just read; a concurrent change aborts 40001 (no stale move / wrong-tenant
    -- cleanup). Name/team (non-guarded columns) are applied ONLY AFTER the membership transition validates.
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
-- accept_invitation requires auth.uid(); anonymous execution is never useful → not granted to anon.
REVOKE ALL ON FUNCTION public.accept_invitation(text,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_invitation(text,text) TO authenticated, service_role;

-- delete_tenant: detach every member through the advisory-first lifecycle (per-member advisory + current
-- delete) BEFORE the membership change, so the composite current FK never blocks the tenant nulling.
-- HISTORY CONTRACT: this PERMANENTLY deletes the org, so its tenant-scoped readiness history is cascaded
-- away by design (readiness_score_history.tenant_id -> tenants ON DELETE CASCADE). That is intentional and
-- distinct from learner removal/transfer, which PRESERVE history. Only the target tenant's history is
-- affected — other tenants' history is untouched and no orphaned history remains.
CREATE OR REPLACE FUNCTION public.delete_tenant(p_tenant_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_role text; v_name text; v_m uuid; v_locked_tenant uuid;
BEGIN
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('ralli_admin','superadmin') THEN
    RAISE EXCEPTION 'delete_tenant: requires ralli_admin role';
  END IF;

  SELECT name INTO v_name FROM public.tenants WHERE id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'delete_tenant: tenant not found'; END IF;

  -- Detach each member via the lifecycle path (advisory FIRST, delete current), deterministic order.
  FOR v_m IN SELECT id FROM public.profiles WHERE tenant_id = p_tenant_id ORDER BY id LOOP
    PERFORM public.readiness_begin_lifecycle_write(v_m, ARRAY[p_tenant_id]);
    -- (#5 fix) re-read UNDER LOCK and confirm the member still belongs to this tenant. If they transferred
    -- out between enumeration and the lock, SKIP them — never detach a member from a DIFFERENT tenant.
    SELECT tenant_id INTO v_locked_tenant FROM public.profiles WHERE id = v_m FOR UPDATE;
    IF v_locked_tenant IS DISTINCT FROM p_tenant_id THEN
      CONTINUE;
    END IF;
    DELETE FROM public.readiness_scores_current WHERE user_id = v_m AND tenant_id = p_tenant_id;
    UPDATE public.profiles SET tenant_id = NULL, role = 'user', updated_at = now() WHERE id = v_m;
  END LOOP;

  DELETE FROM public.tenant_invitations WHERE tenant_id = p_tenant_id;
  DELETE FROM public.tenant_settings    WHERE tenant_id = p_tenant_id;
  DELETE FROM public.tenants WHERE id = p_tenant_id;

  RETURN jsonb_build_object('tenantId', p_tenant_id, 'name', v_name, 'deleted', true);
END $function$;
-- delete_tenant authorizes ralli_admin internally; anonymous callers can never satisfy it → not granted to anon.
REVOKE ALL ON FUNCTION public.delete_tenant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_tenant(uuid) TO authenticated, service_role;

COMMIT;

-- ── AUDIT ───────────────────────────────────────────────────────────────────────
--   SELECT jobname,schedule FROM cron.job WHERE jobname='readiness_reconcile_cleanup';  -- new; others untouched
--   SELECT conname,pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('rsh_user_fk','rrq_user_fk','rsc_user_same_tenant');
-- ── ROLLBACK: see docs/engineering/rollback_091_readiness_learner_lifecycle.sql (two-mode; fail-closed). ──
-- ─────────────────────────────────────────────────────────────────────────────
