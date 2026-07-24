-- ─────────────────────────────────────────────────────────────────────────────
-- Readiness versioning — Phase 1 (corrected): additive tables with DB-enforced
-- cross-tenant integrity (composite FKs) and valid-state CHECK constraints.
--
-- No app code writes these tables yet; no triggers; readiness_scores untouched.
-- Additive + reversible (see rollback blocks). Cross-tenant references are made
-- IMPOSSIBLE by composite (id, tenant_id) foreign keys — even privileged/
-- service-role writes cannot store a Tenant-A row pointing at a Tenant-B parent.
-- ─────────────────────────────────────────────────────────────────────────────

-- Composite-FK target on the EXISTING profiles table (additive; id is already
-- unique so this constraint is trivially satisfied by current data).
ALTER TABLE profiles ADD CONSTRAINT profiles_id_tenant_uq UNIQUE (id, tenant_id);

-- 1. Formula versions
CREATE TABLE IF NOT EXISTS readiness_formula_versions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version              integer NOT NULL,
  status               text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired','superseded')),
  configuration        jsonb NOT NULL,
  readiness_threshold  integer NOT NULL CHECK (readiness_threshold BETWEEN 0 AND 100),
  config_hash          text NOT NULL,
  source               text NOT NULL DEFAULT 'ralli_default' CHECK (source IN ('ralli_default','tenant_customized')),
  supersedes_version_id uuid,
  created_by           uuid REFERENCES profiles(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  activated_at         timestamptz,
  UNIQUE (tenant_id, version),
  UNIQUE (id, tenant_id),                                   -- composite-FK target
  -- self-reference stays within the same tenant:
  CONSTRAINT rfv_supersedes_same_tenant
    FOREIGN KEY (supersedes_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE NO ACTION
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rfv_one_active_per_tenant
  ON readiness_formula_versions (tenant_id) WHERE status = 'active';

-- 2. Calculation runs
CREATE TABLE IF NOT EXISTS readiness_calculation_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  formula_version_id  uuid NOT NULL,
  config_hash         text NOT NULL,
  mode                text NOT NULL CHECK (mode IN ('event','preview','reconciliation','backfill')),
  status              text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','partial_failure','failed')),
  expected_count      integer NOT NULL DEFAULT 0 CHECK (expected_count     >= 0),
  processed_count     integer NOT NULL DEFAULT 0 CHECK (processed_count    >= 0),
  success_count       integer NOT NULL DEFAULT 0 CHECK (success_count      >= 0),
  insufficient_count  integer NOT NULL DEFAULT 0 CHECK (insufficient_count >= 0),
  failure_count       integer NOT NULL DEFAULT 0 CHECK (failure_count      >= 0),
  population_snapshot  jsonb,
  started_by          uuid REFERENCES profiles(id) ON DELETE SET NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  error_summary       text,
  UNIQUE (id, tenant_id),                                   -- composite-FK target
  CONSTRAINT rcr_formula_same_tenant
    FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  -- counters cannot exceed processed, processed cannot exceed expected:
  CONSTRAINT rcr_counter_sum   CHECK (success_count + insufficient_count + failure_count = processed_count),
  CONSTRAINT rcr_processed_cap CHECK (processed_count <= expected_count)
);
CREATE INDEX IF NOT EXISTS idx_rcr_tenant_version ON readiness_calculation_runs (tenant_id, formula_version_id, started_at DESC);

-- 3. Current scores
CREATE TABLE IF NOT EXISTS readiness_scores_current (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id               uuid NOT NULL,
  formula_version_id    uuid NOT NULL,
  overall_score         integer CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
  component_scores      jsonb,
  effective_weights     jsonb,
  confidence            text CHECK (confidence IS NULL OR confidence IN ('insufficient','limited','moderate','high')),
  evidence_summary      jsonb,
  flags                 jsonb,
  success_status        text CHECK (success_status IS NULL OR success_status IN ('ok','insufficient_evidence')),
  evidence_hash         text,
  calculated_config_hash text,
  calculated_at         timestamptz,
  success_run_id        uuid REFERENCES readiness_calculation_runs(id) ON DELETE SET NULL,
  last_attempt_status   text CHECK (last_attempt_status IS NULL OR last_attempt_status IN ('ok','insufficient_evidence','error')),
  last_attempt_at       timestamptz,
  last_attempt_run_id   uuid REFERENCES readiness_calculation_runs(id) ON DELETE SET NULL,
  UNIQUE (tenant_id, user_id, formula_version_id),
  CONSTRAINT rsc_formula_same_tenant FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rsc_user_same_tenant FOREIGN KEY (user_id, tenant_id)
    REFERENCES profiles (id, tenant_id) ON DELETE CASCADE,
  -- valid success-state combinations:
  CONSTRAINT rsc_success_state CHECK (
    success_status IS NULL
    OR (success_status = 'ok' AND overall_score IS NOT NULL)
    OR (success_status = 'insufficient_evidence' AND overall_score IS NULL)),
  -- a successful row must carry its calculation identity:
  CONSTRAINT rsc_success_meta CHECK (
    success_status IS NULL OR (calculated_at IS NOT NULL AND calculated_config_hash IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_rsc_tenant_version ON readiness_scores_current (tenant_id, formula_version_id);

-- 4. Score history (append-only)
CREATE TABLE IF NOT EXISTS readiness_score_history (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id              uuid NOT NULL,
  formula_version_id   uuid NOT NULL,
  overall_score        integer CHECK (overall_score IS NULL OR overall_score BETWEEN 0 AND 100),
  component_scores     jsonb,
  confidence           text,
  evidence_summary     jsonb,
  flags                jsonb,
  success_status       text NOT NULL CHECK (success_status IN ('ok','insufficient_evidence')),
  evidence_hash        text,
  material_state_hash  text NOT NULL,
  calculated_config_hash text NOT NULL,
  calculation_run_id   uuid REFERENCES readiness_calculation_runs(id) ON DELETE SET NULL,
  idempotency_key      text NOT NULL,
  calculated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT rsh_formula_same_tenant FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rsh_user_same_tenant FOREIGN KEY (user_id, tenant_id)
    REFERENCES profiles (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rsh_state CHECK (
    (success_status = 'ok' AND overall_score IS NOT NULL)
    OR (success_status = 'insufficient_evidence' AND overall_score IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_rsh_tenant_user_version ON readiness_score_history (tenant_id, user_id, formula_version_id, calculated_at DESC);

-- 5. Lifecycle events (immutable audit)
CREATE TABLE IF NOT EXISTS readiness_formula_lifecycle_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  formula_version_id  uuid,
  event_type          text NOT NULL CHECK (event_type IN ('created','previewed','superseded','activated','retired','rolled_back')),
  actor_id            uuid REFERENCES profiles(id) ON DELETE SET NULL,
  actor_role          text,
  config_hash         text,
  from_version_id     uuid,
  to_version_id       uuid,
  metadata            jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rfle_version_same_tenant FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rfle_from_same_tenant FOREIGN KEY (from_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE NO ACTION,
  CONSTRAINT rfle_to_same_tenant FOREIGN KEY (to_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS idx_rfle_tenant ON readiness_formula_lifecycle_events (tenant_id, created_at DESC);

-- 6. Durable recalc queue / outbox (schema only in Phase 1)
CREATE TABLE IF NOT EXISTS readiness_recalc_queue (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id             uuid NOT NULL,
  formula_version_id  uuid,                                  -- NULL = active-at-processing
  target_key          text GENERATED ALWAYS AS (COALESCE(formula_version_id::text, 'ACTIVE')) STORED,
  reason              text NOT NULL CHECK (reason IN (
                        'quiz_attempt','lesson_completion','course_state','live_answer','live_session',
                        'assignment_state','assignment_target','content_archived','catalog_change',
                        'profile_status','profile_role','team_membership','formula_activation','backfill','manual')),
  source_ref          jsonb,
  idempotency_key     text NOT NULL DEFAULT gen_random_uuid()::text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed','dead_letter','superseded')),
  rerun_requested     boolean NOT NULL DEFAULT false,
  attempt_count       integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  last_error          text,
  locked_by           text,
  locked_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  processed_at        timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT rrq_formula_same_tenant FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rrq_user_same_tenant FOREIGN KEY (user_id, tenant_id)
    REFERENCES profiles (id, tenant_id) ON DELETE CASCADE
);
-- Named partial unique CONSTRAINT-equivalent index for coalescing; the enqueue
-- function keys its retry decision on THIS index name (see 053).
CREATE UNIQUE INDEX IF NOT EXISTS uq_recalc_live_job
  ON readiness_recalc_queue (tenant_id, user_id, target_key)
  WHERE status IN ('pending','processing');
CREATE INDEX IF NOT EXISTS idx_recalc_claim
  ON readiness_recalc_queue (next_attempt_at) WHERE status = 'pending';

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- DROP TABLE IF EXISTS readiness_recalc_queue, readiness_formula_lifecycle_events,
--   readiness_score_history, readiness_scores_current, readiness_calculation_runs,
--   readiness_formula_versions CASCADE;
-- ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_tenant_uq;
