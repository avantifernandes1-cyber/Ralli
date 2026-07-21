-- Migration 042: Fix readiness_scores upsert support
--
-- Migration 024 (readiness_upsert.sql) was written and committed to this
-- repo, but was never actually applied to the live database — it's absent
-- from the project's applied-migrations history, and pg_constraint on the
-- live readiness_scores table had no UNIQUE(tenant_id, user_id) constraint.
--
-- Effect: every call to computeAndSaveReadinessScore()'s
-- `.upsert(..., { onConflict: "tenant_id,user_id" })` (src/lib/insightsService.js)
-- failed with Postgres 42P10 ("no unique or exclusion constraint matching
-- the ON CONFLICT specification"), on every single call, for every tenant,
-- since the table was created. Because that function resolves { data, error }
-- instead of throwing, and the only caller-side handling was a bare
-- `.catch()`, the failure was completely silent — readiness_scores stayed
-- empty despite real quiz/lesson/course activity.
--
-- This migration reproduces migration 024's intended changes, which were
-- already applied directly to project jdwqaypjxnnvxbqnxpet on 2026-07-21
-- (tracked there ad hoc as "readiness_scores_upsert_constraint", version
-- 20260721040333 — applied before this file existed, hence the name/number
-- mismatch with the live migration history). This file exists purely to
-- bring the repo's migration history back in sync with what's already live;
-- it does not introduce a different design from what's already running.
--
-- Every statement below is written to be a safe no-op if already applied,
-- so this migration can be re-run against the live database (which already
-- has these changes) without erroring or altering anything further.

-- ── 1. Deduplicate — keep only the most recent row per (tenant_id, user_id) ──
-- No-op if no duplicates exist (true today — the live table has a single
-- row and no duplicate (tenant_id, user_id) pairs).
DELETE FROM public.readiness_scores
WHERE id NOT IN (
  SELECT DISTINCT ON (tenant_id, user_id) id
  FROM public.readiness_scores
  ORDER BY tenant_id, user_id, computed_at DESC
);

-- ── 2. Unique constraint — required for ON CONFLICT (tenant_id, user_id) upserts ──
-- Guarded (unlike migration 024's original unconditional ADD CONSTRAINT) so
-- this is safe to re-run now that the constraint already exists live.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.readiness_scores'::regclass
      AND conname  = 'readiness_scores_tenant_user_unique'
  ) THEN
    ALTER TABLE public.readiness_scores
      ADD CONSTRAINT readiness_scores_tenant_user_unique
      UNIQUE (tenant_id, user_id);
  END IF;
END $$;

-- ── 3. UPDATE RLS policy ─────────────────────────────────────────────────────
-- Required for Supabase upsert (INSERT … ON CONFLICT DO UPDATE) to succeed
-- when the row already exists and belongs to the authenticated user. Same
-- guarded pattern migration 024 already used for its own policies.
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

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'public.readiness_scores'::regclass;
-- SELECT policyname, cmd FROM pg_policies WHERE tablename = 'readiness_scores';
