-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli: Data Architecture Stabilization
-- Run after 022_ai_insights.sql
--
-- Changes:
--   1. tenant_assignments — add 'quiz' to content_type CHECK constraint
--   2. profiles           — add nickname, avatar_emoji, profile_pic_url, notif_prefs
--   3. tenant_bc_categories — new table (replaces localStorage battle card categories)
--   4. tenant_battle_cards  — new table (replaces localStorage battle cards)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Fix tenant_assignments to accept quiz assignments ──────────────────────
-- The original CHECK only allowed 'course' | 'lesson'. Quiz assignments were
-- being written by the app but silently rejected. Drop and recreate the constraint.

ALTER TABLE public.tenant_assignments
  DROP CONSTRAINT IF EXISTS tenant_assignments_content_type_check;

ALTER TABLE public.tenant_assignments
  ADD CONSTRAINT tenant_assignments_content_type_check
  CHECK (content_type IN ('course', 'lesson', 'quiz'));

-- ── 2. Profile preferences ───────────────────────────────────────────────────
-- These fields were stored in localStorage per device. Moving to Supabase so
-- preferences persist across devices and sessions.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS nickname        TEXT,
  ADD COLUMN IF NOT EXISTS avatar_emoji    TEXT,
  ADD COLUMN IF NOT EXISTS profile_pic_url TEXT,
  ADD COLUMN IF NOT EXISTS notif_prefs     JSONB NOT NULL DEFAULT '{
    "quizAssigned":   true,
    "courseAssigned": true,
    "lessonAssigned": true,
    "gameResults":    true,
    "dueSoon":        true,
    "overdue":        true
  }'::jsonb;

COMMENT ON COLUMN public.profiles.nickname        IS 'Optional display name used in game lobby and UI';
COMMENT ON COLUMN public.profiles.avatar_emoji    IS 'Emoji avatar for game lobby';
COMMENT ON COLUMN public.profiles.profile_pic_url IS 'URL to uploaded profile picture';
COMMENT ON COLUMN public.profiles.notif_prefs     IS 'Per-user notification preference toggles';

-- ── 3. tenant_bc_categories ───────────────────────────────────────────────────
-- Battle card categories, scoped per tenant. Previously stored in localStorage.
-- Schema mirrors the in-app shape: { id, label, description }.

CREATE TABLE IF NOT EXISTS public.tenant_bc_categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  created_by  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.tenant_bc_categories IS 'Battle card categories per tenant — replaces localStorage';

CREATE INDEX IF NOT EXISTS idx_bc_categories_tenant
  ON public.tenant_bc_categories (tenant_id, created_at DESC);

ALTER TABLE public.tenant_bc_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- All tenant members can read categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_tenant_read') THEN
    CREATE POLICY "bc_categories_tenant_read"
      ON public.tenant_bc_categories FOR SELECT TO authenticated
      USING (
        get_my_role() = 'ralli_admin'
        OR tenant_id = get_my_tenant_id()
      );
  END IF;

  -- Only managers/admins can create categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_admin_insert') THEN
    CREATE POLICY "bc_categories_admin_insert"
      ON public.tenant_bc_categories FOR INSERT TO authenticated
      WITH CHECK (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;

  -- Only managers/admins can update categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_admin_update') THEN
    CREATE POLICY "bc_categories_admin_update"
      ON public.tenant_bc_categories FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;

  -- Only managers/admins can delete categories
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_admin_delete') THEN
    CREATE POLICY "bc_categories_admin_delete"
      ON public.tenant_bc_categories FOR DELETE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
END $$;

-- ── 4. tenant_battle_cards ────────────────────────────────────────────────────
-- Battle cards per tenant. Previously stored in localStorage — not shared between
-- users or devices. Moving to Supabase enables manager-created cards to be visible
-- to all reps in the same tenant.
--
-- Schema mirrors the in-app shape:
--   { id, categoryId, title, subtitle, summary, strength, weakness,
--     ourWin, talkTrack, tags, content: [{heading, body}] }
--
-- content and tags stored as JSONB/TEXT[] to preserve the existing array structures.

CREATE TABLE IF NOT EXISTS public.tenant_battle_cards (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  category_id UUID        REFERENCES public.tenant_bc_categories(id) ON DELETE SET NULL,
  title       TEXT        NOT NULL,
  subtitle    TEXT        NOT NULL DEFAULT '',
  summary     TEXT        NOT NULL DEFAULT '',
  strength    TEXT        NOT NULL DEFAULT '',
  weakness    TEXT        NOT NULL DEFAULT '',
  our_win     TEXT        NOT NULL DEFAULT '',
  talk_track  TEXT        NOT NULL DEFAULT '',
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  content     JSONB       NOT NULL DEFAULT '[]',
  -- content format: [{ heading: string, body: string }]
  created_by  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.tenant_battle_cards         IS 'Battle cards per tenant — replaces localStorage';
COMMENT ON COLUMN public.tenant_battle_cards.content IS 'Array of {heading, body} sections for in-depth content';
COMMENT ON COLUMN public.tenant_battle_cards.our_win IS 'Why we win section (maps to ourWin in the UI)';

CREATE INDEX IF NOT EXISTS idx_bc_cards_tenant
  ON public.tenant_battle_cards (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bc_cards_category
  ON public.tenant_battle_cards (tenant_id, category_id);

ALTER TABLE public.tenant_battle_cards ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- All tenant members can read cards
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_tenant_read') THEN
    CREATE POLICY "bc_cards_tenant_read"
      ON public.tenant_battle_cards FOR SELECT TO authenticated
      USING (
        get_my_role() = 'ralli_admin'
        OR tenant_id = get_my_tenant_id()
      );
  END IF;

  -- Only managers/admins can create cards
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_insert') THEN
    CREATE POLICY "bc_cards_admin_insert"
      ON public.tenant_battle_cards FOR INSERT TO authenticated
      WITH CHECK (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;

  -- Only managers/admins can update cards
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_update') THEN
    CREATE POLICY "bc_cards_admin_update"
      ON public.tenant_battle_cards FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;

  -- Only managers/admins can delete cards
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_delete') THEN
    CREATE POLICY "bc_cards_admin_delete"
      ON public.tenant_battle_cards FOR DELETE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('tenant_bc_categories','tenant_battle_cards');
--
-- SELECT column_name FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'profiles'
--   AND column_name IN ('nickname','avatar_emoji','profile_pic_url','notif_prefs');
