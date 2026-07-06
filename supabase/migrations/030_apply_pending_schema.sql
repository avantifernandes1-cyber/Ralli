-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 030: Apply all schema changes from 023–029 in one idempotent pass.
--
-- Run this in: Supabase Dashboard → SQL Editor → New Query → paste → Run
--
-- Safe to re-run — all statements use IF NOT EXISTS / DROP CONSTRAINT IF EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Allow 'quiz' as content_type in tenant_assignments ────────────────────
-- Fixes: quiz assignment failing with constraint violation
ALTER TABLE public.tenant_assignments
  DROP CONSTRAINT IF EXISTS tenant_assignments_content_type_check;

ALTER TABLE public.tenant_assignments
  ADD CONSTRAINT tenant_assignments_content_type_check
  CHECK (content_type IN ('course', 'lesson', 'quiz'));

-- ── 2. Profile preference columns ────────────────────────────────────────────
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

-- ── 3. tenant_bc_categories ───────────────────────────────────────────────────
-- Fixes: battle card category creation failing ("relation does not exist")
CREATE TABLE IF NOT EXISTS public.tenant_bc_categories (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  created_by  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bc_categories_tenant
  ON public.tenant_bc_categories (tenant_id, created_at DESC);

ALTER TABLE public.tenant_bc_categories ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_tenant_read') THEN
    CREATE POLICY "bc_categories_tenant_read"
      ON public.tenant_bc_categories FOR SELECT TO authenticated
      USING (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_admin_insert') THEN
    CREATE POLICY "bc_categories_admin_insert"
      ON public.tenant_bc_categories FOR INSERT TO authenticated
      WITH CHECK (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_bc_categories' AND policyname = 'bc_categories_admin_update') THEN
    CREATE POLICY "bc_categories_admin_update"
      ON public.tenant_bc_categories FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
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
  created_by  UUID        REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bc_cards_tenant
  ON public.tenant_battle_cards (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bc_cards_category
  ON public.tenant_battle_cards (tenant_id, category_id);

ALTER TABLE public.tenant_battle_cards ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_tenant_read') THEN
    CREATE POLICY "bc_cards_tenant_read"
      ON public.tenant_battle_cards FOR SELECT TO authenticated
      USING (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id());
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_insert') THEN
    CREATE POLICY "bc_cards_admin_insert"
      ON public.tenant_battle_cards FOR INSERT TO authenticated
      WITH CHECK (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_update') THEN
    CREATE POLICY "bc_cards_admin_update"
      ON public.tenant_battle_cards FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_battle_cards' AND policyname = 'bc_cards_admin_delete') THEN
    CREATE POLICY "bc_cards_admin_delete"
      ON public.tenant_battle_cards FOR DELETE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
END $$;

-- ── 5. tenant_assignments — add UPDATE policy (from 026) ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'tenant_assignments' AND policyname = 'tenant_assignments_update') THEN
    CREATE POLICY "tenant_assignments_update"
      ON public.tenant_assignments FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
END $$;

-- ── Verify ───────────────────────────────────────────────────────────────────
-- After running, confirm with:
--   SELECT conname, consrc FROM pg_constraint WHERE conname = 'tenant_assignments_content_type_check';
--   SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('tenant_bc_categories','tenant_battle_cards');
