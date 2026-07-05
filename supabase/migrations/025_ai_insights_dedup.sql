-- Migration 025: ai_insights — unique constraint + upsert support
--
-- Problem: saveInsightCache used INSERT with no unique constraint.
-- Every InsightsScreen load (when AI is available) appended a new row.
-- getCachedInsight reads with maxAgeHours + limit(1) so no visible wrong
-- data, but the table grows unbounded with duplicate summaries.
--
-- Changes:
--   1. Deduplicate — keep only the most recent row per (tenant_id, scope, scope_id).
--   2. Add UNIQUE(tenant_id, scope, scope_id) constraint.
--   3. Add UPDATE RLS policy for tenant members (required for ON CONFLICT DO UPDATE).

-- ── 1. Deduplicate ────────────────────────────────────────────────────────────
DELETE FROM public.ai_insights
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, scope, scope_id) id
  FROM public.ai_insights
  ORDER BY tenant_id, scope, scope_id, generated_at DESC
);

-- ── 2. Unique constraint ──────────────────────────────────────────────────────
ALTER TABLE public.ai_insights
  ADD CONSTRAINT ai_insights_tenant_scope_unique
  UNIQUE (tenant_id, scope, scope_id);

-- ── 3. UPDATE RLS policy ──────────────────────────────────────────────────────
-- Upsert (INSERT … ON CONFLICT DO UPDATE) requires UPDATE permission on the
-- row being replaced. Restricts to members of the same tenant.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'ai_insights'
      AND policyname = 'ai_insights_tenant_update'
  ) THEN
    CREATE POLICY "ai_insights_tenant_update"
      ON public.ai_insights FOR UPDATE TO authenticated
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
        )
      );
  END IF;
END $$;
