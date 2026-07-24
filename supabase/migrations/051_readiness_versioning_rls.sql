-- ─────────────────────────────────────────────────────────────────────────────
-- Readiness versioning — Phase 1 (corrected): RLS.
--
-- Clients are READ-ONLY on every readiness table (all writes are server-side:
-- SECURITY DEFINER RPCs + the service-role worker). Visibility:
--   reps            → their tenant's ACTIVE formula metadata + their OWN scores
--   managers        → their tenant's active/draft/retired formulas + all scores
--   platform admins → cross-tenant, per the EXISTING is_ralli_admin() model
--                     (ralli_admin/superadmin have NULL tenant_id, so tenant-match
--                      alone would exclude them — is_ralli_admin() is required).
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION readiness_caller_tenant()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT p.tenant_id FROM public.profiles p WHERE p.id = auth.uid();
$$;
CREATE OR REPLACE FUNCTION readiness_caller_is_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role = 'orgAdmin'         -- tenant manager; platform admins use is_ralli_admin()
  );
$$;
-- Reuses the canonical public.is_ralli_admin() (ralli_admin/superadmin) for
-- platform-admin cross-tenant access — not re-implemented here.

ALTER TABLE readiness_formula_versions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE readiness_calculation_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE readiness_scores_current             ENABLE ROW LEVEL SECURITY;
ALTER TABLE readiness_score_history              ENABLE ROW LEVEL SECURITY;
ALTER TABLE readiness_formula_lifecycle_events   ENABLE ROW LEVEL SECURITY;
ALTER TABLE readiness_recalc_queue               ENABLE ROW LEVEL SECURITY;

-- Formula versions: reps see ACTIVE only; managers see all statuses (own tenant);
-- platform admins cross-tenant. Drafts are NEVER exposed to reps.
CREATE POLICY rfv_select ON readiness_formula_versions
  FOR SELECT TO authenticated
  USING (
    public.is_ralli_admin()
    OR (tenant_id = readiness_caller_tenant()
        AND (readiness_caller_is_manager() OR status = 'active'))
  );

-- Current scores / history: rep OWN row; manager tenant; platform admin cross-tenant.
CREATE POLICY rsc_select ON readiness_scores_current
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = readiness_caller_tenant()
             AND (user_id = auth.uid() OR readiness_caller_is_manager())));

CREATE POLICY rsh_select ON readiness_score_history
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = readiness_caller_tenant()
             AND (user_id = auth.uid() OR readiness_caller_is_manager())));

-- Runs / lifecycle / queue: MANAGER (own tenant) + platform admin only.
CREATE POLICY rcr_select ON readiness_calculation_runs
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin() OR (tenant_id = readiness_caller_tenant() AND readiness_caller_is_manager()));
CREATE POLICY rfle_select ON readiness_formula_lifecycle_events
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin() OR (tenant_id = readiness_caller_tenant() AND readiness_caller_is_manager()));
CREATE POLICY rrq_select ON readiness_recalc_queue
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin() OR (tenant_id = readiness_caller_tenant() AND readiness_caller_is_manager()));

-- No authenticated INSERT/UPDATE/DELETE policies anywhere — writes are server-only.

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- DROP POLICY IF EXISTS rrq_select ON readiness_recalc_queue;
-- DROP POLICY IF EXISTS rfle_select ON readiness_formula_lifecycle_events;
-- DROP POLICY IF EXISTS rcr_select ON readiness_calculation_runs;
-- DROP POLICY IF EXISTS rsh_select ON readiness_score_history;
-- DROP POLICY IF EXISTS rsc_select ON readiness_scores_current;
-- DROP POLICY IF EXISTS rfv_select ON readiness_formula_versions;
-- DROP FUNCTION IF EXISTS readiness_caller_is_manager(), readiness_caller_tenant();
