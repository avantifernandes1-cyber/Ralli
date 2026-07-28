-- Repeatable test for migration 069 (Battle Card category → tag conversion).
-- Runs against a local DB with 068+069 applied. Inserts fixtures with a valid
-- category association, applies the exact 069 conversion, and asserts honest
-- preservation. Local only. One rolled-back transaction. Expect "069 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a0','ta','TA');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id='00000000-0000-0000-0000-0000000000a9';

INSERT INTO public.tenant_bc_categories (id, tenant_id, label) VALUES
 ('00000000-0000-0000-0000-0000000000ca','00000000-0000-0000-0000-0000000000a0','Competitors'),
 ('00000000-0000-0000-0000-0000000000cb','00000000-0000-0000-0000-0000000000a0','Personality'),
 ('00000000-0000-0000-0000-0000000000cc','00000000-0000-0000-0000-0000000000a0','   ');  -- blank label edge case

-- Insert fixture cards with EXPLICIT provenance (trigger off) so we can assert it is preserved.
ALTER TABLE public.tenant_battle_cards DISABLE TRIGGER trg_touch_tenant_battle_cards;
INSERT INTO public.tenant_battle_cards (id, tenant_id, category_id, title, tags, status, created_by, created_at, updated_by, updated_at) VALUES
 ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ca','C1: has cat + tag', ARRAY['objections'],'active','00000000-0000-0000-0000-0000000000a9','2026-01-01T00:00:00Z','00000000-0000-0000-0000-0000000000a9','2026-02-02T00:00:00Z'),
 ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000cb','C2: label dup of tag (case)', ARRAY['personality'],'active','00000000-0000-0000-0000-0000000000a9','2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z'),
 ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000a0',NULL,'C3: no category', ARRAY['standalone'],'active','00000000-0000-0000-0000-0000000000a9','2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z'),
 ('00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ca','C4: cat only, no tags', ARRAY[]::text[],'active','00000000-0000-0000-0000-0000000000a9','2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z'),
 ('00000000-0000-0000-0000-00000000f005','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000cc','C5: blank-label cat', ARRAY['keep'],'active','00000000-0000-0000-0000-0000000000a9','2026-01-01T00:00:00Z',NULL,'2026-01-01T00:00:00Z');
ALTER TABLE public.tenant_battle_cards ENABLE TRIGGER trg_touch_tenant_battle_cards;

-- ── Apply the exact 069 conversion ───────────────────────────────────────────
ALTER TABLE public.tenant_battle_cards DISABLE TRIGGER trg_touch_tenant_battle_cards;
UPDATE public.tenant_battle_cards c
SET tags = CASE
             WHEN btrim(g.label) = '' THEN c.tags
             WHEN EXISTS (SELECT 1 FROM unnest(c.tags) AS x WHERE lower(x) = lower(btrim(g.label))) THEN c.tags
             ELSE c.tags || ARRAY[btrim(g.label)]
           END,
    category_id = NULL
FROM public.tenant_bc_categories g
WHERE c.category_id = g.id;
ALTER TABLE public.tenant_battle_cards ENABLE TRIGGER trg_touch_tenant_battle_cards;

DO $$
DECLARE r record;
BEGIN
  -- C1: label appended, existing tag preserved, category cleared
  SELECT * INTO r FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF r.tags <> ARRAY['objections','Competitors'] THEN RAISE EXCEPTION 'T1 FAIL: C1 tags = %', r.tags; END IF;
  IF r.category_id IS NOT NULL THEN RAISE EXCEPTION 'T1 FAIL: C1 category not cleared'; END IF;
  RAISE NOTICE '1. valid category label appended as tag; existing tag preserved; category cleared: PASS';

  -- Provenance preserved exactly (trigger off during conversion)
  IF r.created_by <> '00000000-0000-0000-0000-0000000000a9' OR r.created_at <> '2026-01-01T00:00:00Z'::timestamptz
     OR r.updated_by <> '00000000-0000-0000-0000-0000000000a9' OR r.updated_at <> '2026-02-02T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'T2 FAIL: C1 provenance/timestamps changed (created_by % created_at % updated_by % updated_at %)', r.created_by, r.created_at, r.updated_by, r.updated_at;
  END IF;
  RAISE NOTICE '2. created_by/created_at/updated_by/updated_at preserved by conversion: PASS';

  -- C2: label duplicates an existing tag case-insensitively → no duplicate added
  SELECT * INTO r FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f002';
  IF r.tags <> ARRAY['personality'] OR r.category_id IS NOT NULL THEN RAISE EXCEPTION 'T3 FAIL: C2 tags % cat %', r.tags, r.category_id; END IF;
  RAISE NOTICE '3. case-insensitive duplicate label not re-added: PASS';

  -- C3: no category → completely untouched
  SELECT * INTO r FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f003';
  IF r.tags <> ARRAY['standalone'] OR r.category_id IS NOT NULL THEN RAISE EXCEPTION 'T4 FAIL: C3 changed (tags % cat %)', r.tags, r.category_id; END IF;
  RAISE NOTICE '4. card with no category is untouched (no invented tag): PASS';

  -- C4: category, empty tags → single label tag
  SELECT * INTO r FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f004';
  IF r.tags <> ARRAY['Competitors'] OR r.category_id IS NOT NULL THEN RAISE EXCEPTION 'T5 FAIL: C4 tags % cat %', r.tags, r.category_id; END IF;
  RAISE NOTICE '5. empty-tag card gets exactly the category label: PASS';

  -- C5: blank category label → no blank tag added, category still cleared
  SELECT * INTO r FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f005';
  IF r.tags <> ARRAY['keep'] OR r.category_id IS NOT NULL THEN RAISE EXCEPTION 'T6 FAIL: C5 tags % cat %', r.tags, r.category_id; END IF;
  RAISE NOTICE '6. blank category label contributes no tag; category cleared: PASS';

  -- Global: no card retains a category association
  IF EXISTS (SELECT 1 FROM public.tenant_battle_cards WHERE category_id IS NOT NULL) THEN RAISE EXCEPTION 'T7 FAIL: some card still has category_id'; END IF;
  RAISE NOTICE '7. every card category_id cleared after conversion: PASS';

  -- Category table itself is kept intact (migration safety)
  IF (SELECT count(*) FROM public.tenant_bc_categories WHERE tenant_id='00000000-0000-0000-0000-0000000000a0') <> 3 THEN RAISE EXCEPTION 'T8 FAIL: category rows were deleted'; END IF;
  RAISE NOTICE '8. legacy category table left intact: PASS';

  RAISE NOTICE '069 ALL TESTS PASSED';
END $$;

ROLLBACK;
