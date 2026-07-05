-- Migration 024: readiness_scores — unique constraint + upsert support
--
-- Problem: computeAndSaveReadinessScore used INSERT, producing one row per
-- scoring event. LeadershipDashboard then showed duplicate users and stale
-- scores. This migration adds UNIQUE(tenant_id, user_id) so the service layer
-- can upsert (INSERT … ON CONFLICT DO UPDATE) to maintain a single current
-- row per user.
--
-- Changes:
--   1. Remove any duplicate rows (keep highest score per user before constraining).
--   2. Add UNIQUE constraint on (tenant_id, user_id).
--   3. Add UPDATE RLS policy for own rows (required for ON CONFLICT DO UPDATE).

-- ── 1. Deduplicate — keep only the most recent row per (tenant_id, user_id) ──
DELETE FROM public.readiness_scores
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, user_id) id
  FROM public.readiness_scores
  ORDER BY tenant_id, user_id, computed_at DESC
);

-- ── 2. Unique constraint ───────────────────────────────────────────────────────
ALTER TABLE public.readiness_scores
  ADD CONSTRAINT readiness_scores_tenant_user_unique
  UNIQUE (tenant_id, user_id);

-- ── 3. UPDATE RLS policy ──────────────────────────────────────────────────────
-- Required for Supabase upsert (INSERT … ON CONFLICT DO UPDATE) to succeed
-- when the row already exists and belongs to the authenticated user.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'readiness_scores'
      AND policyname = 'readiness_scores_own_update'
  ) THEN
    CREATE POLICY "readiness_scores_own_update"
      ON public.readiness_scores FOR UPDATE TO authenticated
      USING    (user_id = auth.uid())
      WITH CHECK (user_id = auth.uid());
  END IF;
END $$;
