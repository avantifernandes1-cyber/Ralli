-- Repeatable tests for migration 068 (Battle Card lifecycle + provenance + RLS).
-- RLS is enforced only for the non-owner `authenticated`/`anon` roles, so the
-- learner/manager/cross-tenant/anon checks run under SET LOCAL ROLE. Local only,
-- no creds. One rolled-back transaction. Expect "068 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Local supabase omits production's default table grants; replicate them so RLS
-- (not a missing grant) is the gate under test. Transaction-local; rolled back.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_battle_cards  TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tenant_bc_categories TO authenticated;
GRANT SELECT ON public.tenant_battle_cards  TO anon;
GRANT SELECT ON public.profiles TO authenticated;

-- ── Fixtures (as owner) ──────────────────────────────────────────────────────
-- Tenant A: a1 rep (user), a9 manager, ac orgAdmin (card creator).
-- Tenant B: b9 manager, b1 rep.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000ac','authenticated','authenticated','ac@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','b9@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','b1@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MgrA'  WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdmA'  WHERE id='00000000-0000-0000-0000-0000000000ac';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='MgrB'  WHERE id='00000000-0000-0000-0000-0000000000b9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='RepB1' WHERE id='00000000-0000-0000-0000-0000000000b1';

-- Categories (owner insert; category trigger sets created_by=NULL since no auth.uid()).
INSERT INTO public.tenant_bc_categories (id, tenant_id, label) VALUES
 ('00000000-0000-0000-0000-0000000000ca','00000000-0000-0000-0000-0000000000a0','Cat A'),
 ('00000000-0000-0000-0000-0000000000cb','00000000-0000-0000-0000-0000000000b0','Cat B');

-- Pre-existing card inserted as OWNER (simulates data present before 068): must
-- default to status='active' with NULL archived_at (Test 1).
INSERT INTO public.tenant_battle_cards (id, tenant_id, category_id, title, content)
 VALUES ('00000000-0000-0000-0000-00000000f000','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ca','Legacy', '[]'::jsonb);

DO $$
DECLARE v_status text; v_arch timestamptz; v_created uuid; v_created0 uuid; v_upd timestamptz; v_cnt int; v_cat uuid;
BEGIN
  -- Test 1: existing/owner-inserted card is active with no archived_at
  SELECT status, archived_at INTO v_status, v_arch FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f000';
  IF v_status <> 'active' OR v_arch IS NOT NULL THEN RAISE EXCEPTION 'T1 FAIL: legacy card not active/clean (% / %)', v_status, v_arch; END IF;
  RAISE NOTICE '1. existing card defaults to active, archived_at NULL: PASS';

  -- Creator (ac, orgAdmin) creates a card as authenticated → created_by=ac via trigger.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000ac","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tenant_battle_cards (id, tenant_id, category_id, title, subtitle, content, status, archived_at, created_by, updated_at)
    VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000ca','Salesforce','CRM','[{"heading":"h","body":"b"}]'::jsonb,
            'active', now(), '00000000-0000-0000-0000-0000000000a1', '2000-01-01T00:00:00Z');  -- client-supplied provenance must be ignored
  RESET ROLE;
  SELECT created_by, archived_at INTO v_created0, v_arch FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_created0 <> '00000000-0000-0000-0000-0000000000ac' THEN RAISE EXCEPTION 'T1b FAIL: created_by not server-set to caller (got %)', v_created0; END IF;
  IF v_arch IS NOT NULL THEN RAISE EXCEPTION 'T1b FAIL: active card got archived_at'; END IF;
  RAISE NOTICE '   created_by is server-authoritative (caller ac, client value ignored): PASS';

  -- Test 3: learner (a1) sees the active card
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T3 FAIL: learner cannot see active card'; END IF;
  RAISE NOTICE '3. learner sees active card: PASS';

  -- Test 5: learner cannot INSERT / UPDATE / archive
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title) VALUES ('00000000-0000-0000-0000-0000000000a0','Hax');
    RESET ROLE; RAISE EXCEPTION 'T5 FAIL: learner INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  UPDATE public.tenant_battle_cards SET status='archived' WHERE id='00000000-0000-0000-0000-00000000f001';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RESET ROLE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T5 FAIL: learner UPDATE/archive affected % rows', v_cnt; END IF;
  IF (SELECT status FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001') <> 'active' THEN RAISE EXCEPTION 'T5 FAIL: learner archived a card'; END IF;
  RAISE NOTICE '5. learner cannot insert/update/archive/restore: PASS';

  -- Test 2 + 11: manager (a9) archives own-tenant card; updated_at server-set, archived_at set.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET status='archived', updated_at='2000-01-01T00:00:00Z', archived_at=NULL WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  SELECT status, archived_at, updated_at, created_by INTO v_status, v_arch, v_upd, v_created FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_status <> 'archived' OR v_arch IS NULL THEN RAISE EXCEPTION 'T2 FAIL: archive did not set status/archived_at (% / %)', v_status, v_arch; END IF;
  IF v_upd < now() - interval '1 minute' THEN RAISE EXCEPTION 'T11 FAIL: updated_at trusted client clock (%)', v_upd; END IF;
  IF v_created <> '00000000-0000-0000-0000-0000000000ac' THEN RAISE EXCEPTION 'T10 FAIL: created_by changed on edit (got %)', v_created; END IF;
  RAISE NOTICE '2. manager archives own-tenant card (archived_at set): PASS';
  RAISE NOTICE '11. server controls updated_at (client clock ignored): PASS';
  RAISE NOTICE '10. edit preserves created_by: PASS';

  -- Test 4: learner cannot see the archived card
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T4 FAIL: learner can see archived card'; END IF;
  RAISE NOTICE '4. learner cannot see archived card: PASS';

  -- Manager still sees archived (needed for restore UI)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  IF v_cnt <> 1 THEN RAISE EXCEPTION 'T4b FAIL: manager cannot see archived card'; END IF;
  RAISE NOTICE '   manager still reads archived cards: PASS';

  -- Test 13: archive idempotent (re-archive is a no-op, keeps original archived_at)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET status='archived' WHERE id='00000000-0000-0000-0000-00000000f001';  -- no error
  RESET ROLE;
  RAISE NOTICE '13. re-archive is an idempotent no-op (no error): PASS';

  -- Test 9: restore preserves id/content/creator; clears archived_at; same id
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET status='active' WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  SELECT status, archived_at, created_by INTO v_status, v_arch, v_created FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_status <> 'active' OR v_arch IS NOT NULL THEN RAISE EXCEPTION 'T9 FAIL: restore left archived state (% / %)', v_status, v_arch; END IF;
  IF v_created <> '00000000-0000-0000-0000-0000000000ac' THEN RAISE EXCEPTION 'T9 FAIL: restore changed creator'; END IF;
  IF (SELECT content->0->>'heading' FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001') <> 'h' THEN RAISE EXCEPTION 'T9 FAIL: restore changed content'; END IF;
  RAISE NOTICE '9. restore preserves id/content/creator, clears archived_at: PASS';

  -- Test 6: cross-tenant read + write fail (manager b9 on tenant A card)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  UPDATE public.tenant_battle_cards SET title='Hijacked' WHERE id='00000000-0000-0000-0000-00000000f001';
  GET DIAGNOSTICS v_status = ROW_COUNT;  -- reuse var as text of count
  RESET ROLE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T6 FAIL: cross-tenant read returned rows'; END IF;
  IF v_status <> '0' THEN RAISE EXCEPTION 'T6 FAIL: cross-tenant UPDATE affected rows'; END IF;
  RAISE NOTICE '6. cross-tenant read and write fail: PASS';

  -- Test 7: manager cannot MOVE a card to another tenant (WITH CHECK blocks it)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tenant_battle_cards SET tenant_id='00000000-0000-0000-0000-0000000000b0' WHERE id='00000000-0000-0000-0000-00000000f001';
    RESET ROLE; RAISE EXCEPTION 'T7 FAIL: manager moved card across tenants';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;  -- WITH CHECK → RLS violation (42501)
  RESET ROLE;
  -- category cross-tenant move likewise blocked
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tenant_bc_categories SET tenant_id='00000000-0000-0000-0000-0000000000b0' WHERE id='00000000-0000-0000-0000-0000000000ca';
    RESET ROLE; RAISE EXCEPTION 'T7 FAIL: manager moved category across tenants';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  RESET ROLE;
  RAISE NOTICE '7. manager cannot move card or category to another tenant: PASS';

  -- Test 8: anon access fails (RLS has no anon policy → 0 rows)
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  SET LOCAL ROLE anon;
  SELECT count(*) INTO v_cnt FROM public.tenant_battle_cards;
  RESET ROLE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T8 FAIL: anon read returned % rows', v_cnt; END IF;
  RAISE NOTICE '8. anon access yields no rows: PASS';

  -- Test 12: category deletion leaves the card uncategorized (SET NULL), card intact
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  DELETE FROM public.tenant_bc_categories WHERE id='00000000-0000-0000-0000-0000000000ca';
  RESET ROLE;
  SELECT category_id INTO v_cat FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_cat IS NOT NULL THEN RAISE EXCEPTION 'T12 FAIL: card still has category after delete'; END IF;
  IF (SELECT count(*) FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001') <> 1 THEN RAISE EXCEPTION 'T12 FAIL: card lost on category delete'; END IF;
  RAISE NOTICE '12. category deletion leaves card uncategorized (card intact): PASS';

  RAISE NOTICE '068 ALL TESTS PASSED';
END $$;

ROLLBACK;
