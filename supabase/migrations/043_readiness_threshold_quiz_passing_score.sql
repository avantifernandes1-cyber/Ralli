-- Migration 043: Configurable readiness threshold + per-quiz passing score
-- ============================================================
-- Feature: Leadership Dashboard — Configurable Performance Thresholds
--
-- 1. Readiness threshold
--    Stored in the existing tenant_settings.learning_settings JSONB column
--    (no new column needed — JSONB already flexible per its original design
--    comment in 004_tenant_provisioning.sql: "All settings stored as JSONB
--    columns for flexibility"). Key: learning_settings.readinessThreshold.
--
--    Deliberately NOT reusing the existing learning_settings.passingScore
--    key (also defaulted to 80 in provision_tenant(), but currently dead —
--    no application code reads it). That key's name collides conceptually
--    with per-quiz passing scores (item 2 below) and was never wired to
--    anything, so reusing it would be confusing for future readers. This
--    migration adds a CHECK constraint enforcing the valid range (0-100)
--    for the new key only; the app clamps too, but DB-level enforcement is
--    the source of truth per project security principles ("RLS/backend
--    validation must remain the enforcement layer").
--
--    Existing tenants have no learning_settings.readinessThreshold key yet;
--    the app treats a missing/invalid value as 80 (see
--    insightsService.getReadinessThreshold()). This migration does not
--    backfill the key on existing rows — the JSONB key is simply absent,
--    which the CHECK constraint already permits (IS NULL branch), and the
--    app-level default (80) transparently covers it. This matches the
--    requirement "do not change stored readiness scores themselves" and
--    avoids a bulk UPDATE across all tenant_settings rows for a purely
--    additive, backward-compatible default.
--
-- 2. Quiz passing score
--    tenant_quizzes has no passing_score column today (confirmed: no prior
--    migration adds one). The quiz-taking code already reads
--    `quiz.passingScore ?? 90` (rankd-app.jsx) in anticipation of this field
--    existing, so this is additive, not a behavior change for existing
--    quizzes. Added as NULLABLE with NO default — existing quizzes get NULL
--    and keep falling back to the existing 90 default at grading time
--    (unchanged behavior, per requirement "do not rewrite existing
--    quizzes" / "existing quizzes retain their current passing scores").
--    New quizzes created via the Quiz Builder UI after this migration will
--    have the app explicitly set passing_score = 100 (the new default for
--    NEW quizzes only), per requirement.
-- ============================================================

-- ── 1a. Readiness threshold range CHECK on tenant_settings ──────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tenant_settings'::regclass
      AND conname  = 'tenant_settings_readiness_threshold_range'
  ) THEN
    ALTER TABLE public.tenant_settings
      ADD CONSTRAINT tenant_settings_readiness_threshold_range
      CHECK (
        (learning_settings ? 'readinessThreshold') IS NOT TRUE
        OR (
          jsonb_typeof(learning_settings->'readinessThreshold') = 'number'
          AND (learning_settings->>'readinessThreshold')::numeric BETWEEN 0 AND 100
        )
      );
  END IF;
END $$;

-- ── 1b. Comment for discoverability ──────────────────────────────────────────
COMMENT ON COLUMN public.tenant_settings.learning_settings IS
  '1:1 with tenants — flexible JSONB learning config. Known keys: enforceOrder, allowRetakes, passingScore (legacy/unused — do not repurpose), xpPerLesson, xpPerQuiz, xpPerGame, streakBonusXp, readinessThreshold (0-100, default 80 when absent — see insightsService.getReadinessThreshold()).';

-- ── 2a. Per-quiz passing score column ────────────────────────────────────────
ALTER TABLE public.tenant_quizzes
  ADD COLUMN IF NOT EXISTS passing_score INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.tenant_quizzes'::regclass
      AND conname  = 'tenant_quizzes_passing_score_range'
  ) THEN
    ALTER TABLE public.tenant_quizzes
      ADD CONSTRAINT tenant_quizzes_passing_score_range
      CHECK (passing_score IS NULL OR passing_score BETWEEN 0 AND 100);
  END IF;
END $$;

COMMENT ON COLUMN public.tenant_quizzes.passing_score IS
  'Per-quiz passing score (0-100). NULL for quizzes created before this column existed — grading code falls back to a global default (see scoringService.js SCORING.quiz.passingScore). New quizzes created via the builder set this explicitly (default 100).';

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.tenant_settings'::regclass;
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.tenant_quizzes'::regclass;
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'tenant_quizzes' AND column_name = 'passing_score';
