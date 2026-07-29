-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 069: Battle Cards taxonomy → tags only (durable category→tag conversion)
--
-- Product decision: Battle Cards use tags only; categories are removed from the UI.
-- This migration preserves existing organization HONESTLY: every card that still
-- has a VALID category association gets that category's label folded into its
-- Battle Card tags (normalized + de-duplicated by the existing tag rules, never
-- overwriting existing tags), then its category_id is cleared. Cards with no valid
-- category are left untouched — no replacement tag is invented.
--
-- Data-only. Does NOT modify migration 068 or earlier. Does NOT change RLS,
-- grants, triggers, or schema. The legacy `tenant_bc_categories` table is KEPT
-- intact for migration safety; the new frontend simply stops reading/writing it.
--
-- Generic + idempotent: no hardcoded row/category IDs; a second run matches zero
-- rows (all category_id already NULL). Provenance is preserved exactly — the 068
-- BEFORE-UPDATE trigger is briefly disabled so this system conversion does not
-- rewrite created_by/created_at/updated_by/updated_at (only tags + category_id
-- change).
-- ─────────────────────────────────────────────────────────────────────────────

-- Preserve provenance/timestamps across this system conversion (only tags +
-- category_id should change). Owner-only DISABLE/ENABLE; does not alter the trigger.
ALTER TABLE public.tenant_battle_cards DISABLE TRIGGER trg_touch_tenant_battle_cards;

UPDATE public.tenant_battle_cards c
SET tags = CASE
             -- blank/whitespace label contributes nothing (honest: no empty tag)
             WHEN btrim(g.label) = '' THEN c.tags
             -- label already present as a tag (case-insensitive) → no duplicate
             WHEN EXISTS (SELECT 1 FROM unnest(c.tags) AS x WHERE lower(x) = lower(btrim(g.label))) THEN c.tags
             -- otherwise APPEND the normalized label; existing tags are never overwritten
             ELSE c.tags || ARRAY[btrim(g.label)]
           END,
    category_id = NULL
FROM public.tenant_bc_categories g
WHERE c.category_id = g.id;

ALTER TABLE public.tenant_battle_cards ENABLE TRIGGER trg_touch_tenant_battle_cards;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (read-only):
--   SELECT id, title, tags, category_id FROM public.tenant_battle_cards ORDER BY created_at;
--   -- expect: every card category_id IS NULL; each formerly-categorized card's tags
--   -- include its old category label exactly once (case-insensitive), existing tags intact.
-- ─────────────────────────────────────────────────────────────────────────────
