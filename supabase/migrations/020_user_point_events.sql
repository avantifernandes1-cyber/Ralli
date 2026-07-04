-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli: Centralized Points / XP Event Log
-- Run after 002_auth_tables.sql (profiles + tenants must exist).
--
-- Purpose:
--   Immutable ledger of every point award across all scoring sources.
--   Leaderboard, dashboards, and analytics aggregate from this table.
--
-- Source types:
--   lesson  — lesson completed (+25 XP, +10 early bonus)
--   course  — course completed (+100 XP, +10 early bonus)
--   quiz    — quiz completed/passed/perfect/retake
--   game    — live game participation + game score
--   bonus   — speed bonus, placement bonus, any future award
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_point_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id)   ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.profiles(id)  ON DELETE CASCADE,
  source_type TEXT        NOT NULL CHECK (source_type IN ('lesson','course','quiz','game','bonus')),
  source_id   TEXT        NOT NULL,   -- lesson id, quiz id, session pin, etc.
  points      INTEGER     NOT NULL CHECK (points > 0),
  reason      TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.user_point_events             IS 'Immutable log of every point/XP award — source of truth for leaderboard and analytics';
COMMENT ON COLUMN public.user_point_events.source_type IS 'lesson | course | quiz | game | bonus';
COMMENT ON COLUMN public.user_point_events.source_id   IS 'Primary key of the originating entity (lesson id, quiz id, game session pin, etc.)';
COMMENT ON COLUMN public.user_point_events.points      IS 'Points awarded — always positive; negations are not modelled';
COMMENT ON COLUMN public.user_point_events.reason      IS 'Human-readable label, e.g. "Quiz passed" or "1st place bonus"';

-- ── Indexes ───────────────────────────────────────────────────────────────────

-- Primary leaderboard query: all events for a tenant
CREATE INDEX IF NOT EXISTS idx_upe_tenant
  ON public.user_point_events (tenant_id, created_at DESC);

-- Per-user history
CREATE INDEX IF NOT EXISTS idx_upe_user
  ON public.user_point_events (user_id, created_at DESC);

-- Leaderboard breakdown by source_type
CREATE INDEX IF NOT EXISTS idx_upe_tenant_type
  ON public.user_point_events (tenant_id, source_type);

-- ── Row Level Security ────────────────────────────────────────────────────────

ALTER TABLE public.user_point_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Authenticated members of a tenant can read ALL point events for their tenant.
  -- This allows leaderboard aggregation on the client.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_point_events' AND policyname = 'tenant_members_read_point_events'
  ) THEN
    CREATE POLICY "tenant_members_read_point_events"
      ON public.user_point_events
      FOR SELECT TO authenticated
      USING (
        tenant_id IN (
          SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
        )
      );
  END IF;

  -- Users may only insert point events for themselves, within their own tenant.
  -- In production, point awards should be server-side (service_role key).
  -- This policy is a safety net for the current client-side implementation.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'user_point_events' AND policyname = 'users_insert_own_point_events'
  ) THEN
    CREATE POLICY "users_insert_own_point_events"
      ON public.user_point_events
      FOR INSERT TO authenticated
      WITH CHECK (
        user_id = auth.uid()
        AND tenant_id IN (
          SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
        )
      );
  END IF;

  -- No UPDATE or DELETE — point events are immutable once written.
END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT column_name, data_type, is_nullable
-- FROM information_schema.columns
-- WHERE table_name = 'user_point_events'
-- ORDER BY ordinal_position;
