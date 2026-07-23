-- ─────────────────────────────────────────────────────────────────────────────
-- Readiness versioning — Phase 1 (corrected): seed active v1 + copy legacy +
-- parity, with HARDENED threshold validation and ONE canonical config-hash
-- construction that future server code reproduces byte-for-byte.
-- ─────────────────────────────────────────────────────────────────────────────

-- Canonical v1 config-hash. The canonical STRING is fixed and explicit (not
-- jsonb serialization, whose key order isn't portable across SQL/JS):
--   v1_legacy|threshold=<t>|weights=game:0.25,learning:0.35,quiz:0.40
-- Server code MUST build this exact string and sha256-hex it (see the hash
-- parity test). IMMUTABLE so it can be used anywhere deterministically.
CREATE OR REPLACE FUNCTION readiness_v1_config_hash(p_threshold integer)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT encode(
    extensions.digest(
      'v1_legacy|threshold=' || p_threshold::text || '|weights=game:0.25,learning:0.35,quiz:0.40',
      'sha256'), 'hex');
$$;

-- Validated threshold: numeric integer in [0,100], else default 80. A malformed
-- stored value can never abort the migration.
CREATE OR REPLACE FUNCTION readiness_valid_threshold(p_raw text)
RETURNS integer LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT CASE
    WHEN p_raw ~ '^-?\d+$' AND p_raw::int BETWEEN 0 AND 100 THEN p_raw::int
    ELSE 80
  END;
$$;

-- 1. Seed one ACTIVE v1 formula version per tenant (idempotent).
INSERT INTO readiness_formula_versions
  (tenant_id, version, status, configuration, readiness_threshold, config_hash, source, created_at, activated_at)
SELECT
  t.id, 1, 'active',
  '{"model":"v1_legacy","weights":{"game":0.25,"learning":0.35,"quiz":0.40}}'::jsonb,
  readiness_valid_threshold(ts.learning_settings->>'readinessThreshold'),
  readiness_v1_config_hash(readiness_valid_threshold(ts.learning_settings->>'readinessThreshold')),
  'ralli_default', now(), now()
FROM tenants t
LEFT JOIN tenant_settings ts ON ts.tenant_id = t.id
WHERE NOT EXISTS (SELECT 1 FROM readiness_formula_versions v WHERE v.tenant_id = t.id AND v.version = 1);

-- 2. Lifecycle: created + activated per seeded v1.
INSERT INTO readiness_formula_lifecycle_events (tenant_id, formula_version_id, event_type, actor_role, config_hash, to_version_id, metadata)
SELECT v.tenant_id, v.id, e.evt, 'system', v.config_hash, v.id, jsonb_build_object('seed','phase1')
FROM readiness_formula_versions v
CROSS JOIN (VALUES ('created'::text), ('activated'::text)) AS e(evt)
WHERE v.version = 1 AND v.source = 'ralli_default';

-- 3. Copy legacy readiness_scores → readiness_scores_current under v1 (UNCHANGED).
INSERT INTO readiness_scores_current
  (tenant_id, user_id, formula_version_id, overall_score, component_scores, effective_weights,
   confidence, success_status, evidence_hash, calculated_config_hash, calculated_at,
   last_attempt_status, last_attempt_at)
SELECT
  rs.tenant_id, rs.user_id, v.id, rs.score,
  jsonb_build_object('learning', rs.learning_score, 'quiz', rs.quiz_score, 'game', rs.game_score),
  '{"game":0.25,"learning":0.35,"quiz":0.40}'::jsonb,
  NULL, 'ok', NULL, v.config_hash, rs.computed_at,
  'ok', rs.computed_at
FROM readiness_scores rs
JOIN readiness_formula_versions v ON v.tenant_id = rs.tenant_id AND v.version = 1
WHERE NOT EXISTS (
  SELECT 1 FROM readiness_scores_current c
  WHERE c.tenant_id = rs.tenant_id AND c.user_id = rs.user_id AND c.formula_version_id = v.id);

-- 4. Seed baseline history per copied score.
INSERT INTO readiness_score_history
  (tenant_id, user_id, formula_version_id, overall_score, component_scores, confidence,
   success_status, evidence_hash, material_state_hash, calculated_config_hash, idempotency_key, calculated_at)
SELECT
  c.tenant_id, c.user_id, c.formula_version_id, c.overall_score, c.component_scores, c.confidence,
  c.success_status, c.evidence_hash,
  encode(extensions.digest(COALESCE(c.overall_score::text,'null') || '|' || COALESCE(c.component_scores::text,''), 'sha256'),'hex'),
  c.calculated_config_hash, gen_random_uuid()::text, c.calculated_at
FROM readiness_scores_current c
WHERE NOT EXISTS (SELECT 1 FROM readiness_score_history h
  WHERE h.tenant_id=c.tenant_id AND h.user_id=c.user_id AND h.formula_version_id=c.formula_version_id);

-- 5. PARITY ASSERTION — fail the migration on any divergence.
DO $$
DECLARE mism int; legacy int; copied int;
BEGIN
  SELECT count(*) INTO mism
  FROM readiness_scores rs
  JOIN readiness_formula_versions v ON v.tenant_id=rs.tenant_id AND v.version=1
  JOIN readiness_scores_current c ON c.tenant_id=rs.tenant_id AND c.user_id=rs.user_id AND c.formula_version_id=v.id
  WHERE c.overall_score IS DISTINCT FROM rs.score;
  SELECT count(*) INTO legacy FROM readiness_scores;
  SELECT count(*) INTO copied FROM readiness_scores_current c JOIN readiness_formula_versions v ON v.id=c.formula_version_id AND v.version=1;
  IF mism > 0 THEN RAISE EXCEPTION 'readiness parity FAILED: % mismatched scores', mism; END IF;
  IF copied <> legacy THEN RAISE EXCEPTION 'readiness parity FAILED: copied % vs legacy %', copied, legacy; END IF;
  RAISE NOTICE 'readiness parity OK: % rows copied, 0 mismatches', copied;
END $$;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- DELETE FROM readiness_score_history WHERE formula_version_id IN (SELECT id FROM readiness_formula_versions WHERE version=1 AND source='ralli_default');
-- DELETE FROM readiness_scores_current WHERE formula_version_id IN (SELECT id FROM readiness_formula_versions WHERE version=1 AND source='ralli_default');
-- DELETE FROM readiness_formula_lifecycle_events WHERE metadata->>'seed'='phase1';
-- DELETE FROM readiness_formula_versions WHERE version=1 AND source='ralli_default';
-- DROP FUNCTION IF EXISTS readiness_valid_threshold(text), readiness_v1_config_hash(integer);
