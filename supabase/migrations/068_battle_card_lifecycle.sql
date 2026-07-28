-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 068: Battle Card lifecycle (archive/restore) + provenance + RLS hardening
--
-- Additive and production-safe. Does NOT edit applied migrations 023/030.
--
-- 1. tenant_battle_cards: add status ('active'|'archived'), archived_at, updated_by.
--    Existing rows default to 'active' (no card is destroyed). No hard delete added.
-- 2. tenant_bc_categories: add updated_by (categories get provenance, NOT status —
--    category archive/restore is explicitly out of scope this slice).
-- 3. Server-authoritative provenance triggers (BEFORE INSERT/UPDATE):
--    - created_by / created_at set on INSERT only and made IMMUTABLE on UPDATE
--      (fixes the created_by-clobber bug: editing never overwrites the creator).
--    - updated_by := auth.uid(), updated_at := now() on every write (never the
--      browser clock).
--    - cards: archived_at derived from the status transition (server-owned), never
--      trusted from the client.
-- 4. SELECT RLS: learners (role 'user') read ONLY active cards; managers/orgAdmin
--    read active + archived in their tenant; ralli_admin reads all tenants.
-- 5. UPDATE RLS: add WITH CHECK mirroring USING on BOTH tables so a manager can
--    never move a row to another tenant (tenant_id stays == get_my_tenant_id()).
--
-- Confidentiality/immutability: archive/restore only flips status + archived_at;
-- card id and content are untouched, so restore returns the exact same card.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Additive columns on tenant_battle_cards ──────────────────────────────────
ALTER TABLE public.tenant_battle_cards
  ADD COLUMN IF NOT EXISTS status      text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenant_battle_cards_status_chk') THEN
    ALTER TABLE public.tenant_battle_cards
      ADD CONSTRAINT tenant_battle_cards_status_chk CHECK (status IN ('active', 'archived'));
  END IF;
END $$;

-- Keep the archived-status filter fast for learner reads.
CREATE INDEX IF NOT EXISTS idx_bc_cards_tenant_status
  ON public.tenant_battle_cards (tenant_id, status);

-- Any pre-existing rows are live content → active with no archived_at (the column
-- default already backfilled them; this is a belt-and-suspenders no-op that also
-- keeps archived_at consistent with status).
UPDATE public.tenant_battle_cards SET archived_at = NULL WHERE status = 'active' AND archived_at IS NOT NULL;

-- ── 2. Additive column on tenant_bc_categories (provenance only, no status) ──────
ALTER TABLE public.tenant_bc_categories
  ADD COLUMN IF NOT EXISTS updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL;

-- ── 3a. Provenance + archived_at trigger for cards ──────────────────────────────
CREATE OR REPLACE FUNCTION public.tenant_battle_cards_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.created_by := auth.uid();   -- server-authoritative creator (may be NULL for service/seed)
    NEW.updated_by := auth.uid();
    IF NEW.status = 'archived' THEN NEW.archived_at := now(); ELSE NEW.archived_at := NULL; END IF;
  ELSE  -- UPDATE
    NEW.created_at := OLD.created_at;   -- immutable
    NEW.created_by := OLD.created_by;   -- immutable creator: editing NEVER overwrites it
    NEW.updated_at := now();            -- server clock, never the browser
    NEW.updated_by := auth.uid();
    IF NEW.status = 'archived' AND OLD.status <> 'archived' THEN
      NEW.archived_at := now();         -- first transition into archived
    ELSIF NEW.status <> 'archived' THEN
      NEW.archived_at := NULL;          -- any active state clears it
    END IF;                             -- archived → archived keeps the original archived_at (idempotent)
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_tenant_battle_cards ON public.tenant_battle_cards;
CREATE TRIGGER trg_touch_tenant_battle_cards
  BEFORE INSERT OR UPDATE ON public.tenant_battle_cards
  FOR EACH ROW EXECUTE FUNCTION public.tenant_battle_cards_touch();

-- ── 3b. Provenance trigger for categories (no status) ───────────────────────────
CREATE OR REPLACE FUNCTION public.tenant_bc_categories_touch()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    NEW.created_at := now();
    NEW.updated_at := now();
    NEW.created_by := auth.uid();
    NEW.updated_by := auth.uid();
  ELSE  -- UPDATE
    NEW.created_at := OLD.created_at;   -- immutable
    NEW.created_by := OLD.created_by;   -- immutable creator
    NEW.updated_at := now();
    NEW.updated_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_touch_tenant_bc_categories ON public.tenant_bc_categories;
CREATE TRIGGER trg_touch_tenant_bc_categories
  BEFORE INSERT OR UPDATE ON public.tenant_bc_categories
  FOR EACH ROW EXECUTE FUNCTION public.tenant_bc_categories_touch();

-- ── 4. SELECT RLS: learners read active only; managers read active + archived ────
DROP POLICY IF EXISTS bc_cards_tenant_read ON public.tenant_battle_cards;
CREATE POLICY bc_cards_tenant_read
  ON public.tenant_battle_cards FOR SELECT TO authenticated
  USING (
    get_my_role() = 'ralli_admin'
    OR (
      tenant_id = get_my_tenant_id()
      AND (status = 'active' OR get_my_role() IN ('orgAdmin', 'manager'))
    )
  );

-- ── 5. UPDATE RLS: add WITH CHECK (mirror USING) so tenant_id cannot cross tenants ─
DROP POLICY IF EXISTS bc_cards_admin_update ON public.tenant_battle_cards;
CREATE POLICY bc_cards_admin_update
  ON public.tenant_battle_cards FOR UPDATE TO authenticated
  USING (
    get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
    AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
  )
  WITH CHECK (
    get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
    AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
  );

DROP POLICY IF EXISTS bc_categories_admin_update ON public.tenant_bc_categories;
CREATE POLICY bc_categories_admin_update
  ON public.tenant_bc_categories FOR UPDATE TO authenticated
  USING (
    get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
    AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
  )
  WITH CHECK (
    get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
    AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (read-only):
--   \d+ public.tenant_battle_cards  → status, archived_at, updated_by present
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.tenant_battle_cards'::regclass;
--   SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE tablename = 'tenant_battle_cards';
-- ─────────────────────────────────────────────────────────────────────────────
