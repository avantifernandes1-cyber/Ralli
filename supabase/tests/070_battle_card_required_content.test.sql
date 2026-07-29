-- Repeatable tests for migration 070 (Battle Card required-content enforcement).
-- The helper is exercised directly; enforcement is exercised under SET LOCAL ROLE
-- (authenticated/anon = untrusted API clients) with owner + service_role proving the
-- exemption. Local only, no creds. One rolled-back transaction. Expect "070 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Replicate the POST-068 production grants so RLS/trigger (not a stray grant) is the
-- gate under test. Cards have NO DELETE grant (068 revokes it). service_role gets the
-- same DML grant so the role-exemption test exercises the trigger, not a missing grant.
GRANT SELECT, INSERT, UPDATE ON public.tenant_battle_cards TO authenticated;  -- no DELETE (068)
GRANT SELECT               ON public.tenant_battle_cards TO anon;
GRANT SELECT, INSERT, UPDATE ON public.tenant_battle_cards TO service_role;
GRANT SELECT ON public.profiles TO authenticated;

-- ── Fixtures (as owner) ──────────────────────────────────────────────────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),  -- rep A
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now()),  -- manager A
 ('00000000-0000-0000-0000-0000000000ac','authenticated','authenticated','ac@t.test',now(),now()),  -- orgAdmin A
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','b9@t.test',now(),now());  -- manager B
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MgrA'  WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdmA'  WHERE id='00000000-0000-0000-0000-0000000000ac';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='MgrB'  WHERE id='00000000-0000-0000-0000-0000000000b9';

-- Legacy INCOMPLETE card, inserted AS OWNER (simulates the two production cards):
-- has title + a tag but blank strength/weakness/our_win. That the owner insert
-- SUCCEEDS is itself the postgres/owner exemption (Test 20).
INSERT INTO public.tenant_battle_cards (id, tenant_id, title, subtitle, content, tags, strength, weakness, our_win, status)
 VALUES ('00000000-0000-0000-0000-00000000f900','00000000-0000-0000-0000-0000000000a0','Legacy Incomplete','old','[]'::jsonb,
         ARRAY['persona'], '', '', '', 'active');

DO $$
DECLARE h boolean; v_cnt int; v_created uuid; v_updby uuid; v_upd timestamptz; v_str text; v_status text; v_arch timestamptz;
BEGIN
  -- ══ (A) HELPER: battle_card_has_meaningful_text — real serializer outputs ═════
  -- TRUE for visible text regardless of supported formatting:
  IF public.battle_card_has_meaningful_text('Hello world')            IS NOT TRUE  THEN RAISE EXCEPTION 'H1: plain text should be meaningful'; END IF;
  IF public.battle_card_has_meaningful_text('**Fast** onboarding')    IS NOT TRUE  THEN RAISE EXCEPTION 'H2: bold text should be meaningful'; END IF;
  IF public.battle_card_has_meaningful_text('*win* and __key__')      IS NOT TRUE  THEN RAISE EXCEPTION 'H3: italic/underline text should be meaningful'; END IF;
  IF public.battle_card_has_meaningful_text('- alpha'||chr(10)||'- beta')     IS NOT TRUE THEN RAISE EXCEPTION 'H4: unordered list with content'; END IF;
  IF public.battle_card_has_meaningful_text('1. first'||chr(10)||'2. second') IS NOT TRUE THEN RAISE EXCEPTION 'H5: ordered list with content'; END IF;
  IF public.battle_card_has_meaningful_text('24/7 world-class support.') IS NOT TRUE THEN RAISE EXCEPTION 'H6: prose w/ digits/hyphen/period is meaningful'; END IF;
  -- FALSE for null/blank/whitespace/nbsp/line-breaks/empty formatting/empty lists:
  IF public.battle_card_has_meaningful_text(NULL)                     IS NOT FALSE THEN RAISE EXCEPTION 'H7: NULL should be empty'; END IF;
  IF public.battle_card_has_meaningful_text('')                       IS NOT FALSE THEN RAISE EXCEPTION 'H8: empty string'; END IF;
  IF public.battle_card_has_meaningful_text('   ')                    IS NOT FALSE THEN RAISE EXCEPTION 'H9: whitespace only'; END IF;
  IF public.battle_card_has_meaningful_text(chr(160)||chr(160))       IS NOT FALSE THEN RAISE EXCEPTION 'H10: non-breaking spaces only'; END IF;
  IF public.battle_card_has_meaningful_text(chr(10)||chr(10))         IS NOT FALSE THEN RAISE EXCEPTION 'H11: line breaks only'; END IF;
  IF public.battle_card_has_meaningful_text('****')                   IS NOT FALSE THEN RAISE EXCEPTION 'H12: empty bold markers'; END IF;
  IF public.battle_card_has_meaningful_text('__ __')                  IS NOT FALSE THEN RAISE EXCEPTION 'H13: underline wrapping a space'; END IF;
  IF public.battle_card_has_meaningful_text('- ')                     IS NOT FALSE THEN RAISE EXCEPTION 'H14: empty bullet marker'; END IF;
  IF public.battle_card_has_meaningful_text('- '||chr(10)||'- ')      IS NOT FALSE THEN RAISE EXCEPTION 'H15: empty bullets'; END IF;
  IF public.battle_card_has_meaningful_text('1. ')                    IS NOT FALSE THEN RAISE EXCEPTION 'H16: empty numbered item'; END IF;
  IF public.battle_card_has_meaningful_text(E'\t'||chr(160)||'  ')    IS NOT FALSE THEN RAISE EXCEPTION 'H17: mixed whitespace + nbsp'; END IF;
  RAISE NOTICE '1. helper: visible text TRUE; null/blank/ws/nbsp/linebreak/empty-format/empty-list FALSE: PASS';

  -- ══ (B) VALID authenticated INSERT (manager) succeeds; provenance server-set ═
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tenant_battle_cards (id, tenant_id, title, content, tags, strength, weakness, our_win, status, created_by, updated_at)
    VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','Gong','[]'::jsonb,
            ARRAY['crm'], '**Recording** + insights', '- passive'||chr(10)||'- no coaching', 'Proactive coaching',
            'active', '00000000-0000-0000-0000-0000000000a1', '2000-01-01T00:00:00Z');  -- client provenance ignored
  RESET ROLE;
  SELECT created_by, updated_by, updated_at INTO v_created, v_updby, v_upd FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_created <> '00000000-0000-0000-0000-0000000000a9' THEN RAISE EXCEPTION 'T-prov FAIL: created_by not caller (got %)', v_created; END IF;
  IF v_updby  <> '00000000-0000-0000-0000-0000000000a9' THEN RAISE EXCEPTION 'T-prov FAIL: updated_by not caller'; END IF;
  IF v_upd < now() - interval '1 minute' THEN RAISE EXCEPTION 'T-prov FAIL: updated_at trusted client clock (%)', v_upd; END IF;
  RAISE NOTICE '2. valid authenticated INSERT succeeds; created_by/updated_by/updated_at server-authoritative: PASS';

  -- ══ (C) INVALID authenticated INSERT rejected (each missing dimension) ═══════
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  -- missing meaningful strength (formatting-only)
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','X',ARRAY['t'],'****','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-ins FAIL: formatting-only strength accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- missing tag (empty-string-only array)
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','X',ARRAY['   '],'s','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-ins FAIL: blank-only tag array accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- null tags
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','X',NULL,'s','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-ins FAIL: null tags accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- blank title
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','   ',ARRAY['t'],'s','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-ins FAIL: blank title accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RESET ROLE;
  RAISE NOTICE '3. invalid authenticated INSERT rejected (formatting-only body, blank/null tags, blank title): PASS';

  -- ══ (D) INVALID content UPDATE on a VALID card rejected (non-regression) ═════
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tenant_battle_cards SET strength='   ' WHERE id='00000000-0000-0000-0000-00000000f001';
    RESET ROLE; RAISE EXCEPTION 'T-upd FAIL: blanking a valid strength accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE public.tenant_battle_cards SET tags=ARRAY[]::text[] WHERE id='00000000-0000-0000-0000-00000000f001';
    RESET ROLE; RAISE EXCEPTION 'T-upd FAIL: removing the last tag from a valid card accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RESET ROLE;
  IF NOT public.battle_card_has_meaningful_text((SELECT strength FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001')) THEN RAISE EXCEPTION 'T-upd FAIL: valid card strength was corrupted'; END IF;
  RAISE NOTICE '4. content-removing UPDATE on a valid card rejected; stored content unchanged: PASS';

  -- Valid metadata edit on a valid card still works (subtitle/summary optional)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET subtitle='Revenue Intelligence', summary='' WHERE id='00000000-0000-0000-0000-00000000f001';
  RESET ROLE;
  RAISE NOTICE '5. valid metadata edit (optional subtitle/summary) succeeds: PASS';

  -- ══ (E) LEGACY row: lifecycle + metadata + retag allowed; regression blocked ═
  -- archive
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET status='archived' WHERE id='00000000-0000-0000-0000-00000000f900';
  RESET ROLE;
  SELECT status, archived_at INTO v_status, v_arch FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f900';
  IF v_status <> 'archived' OR v_arch IS NULL THEN RAISE EXCEPTION 'T-legacy FAIL: could not archive incomplete legacy card (% / %)', v_status, v_arch; END IF;
  -- restore
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET status='active' WHERE id='00000000-0000-0000-0000-00000000f900';
  -- retag (keep >=1) + metadata edit
  UPDATE public.tenant_battle_cards SET tags=ARRAY['persona','coaching'], subtitle='updated' WHERE id='00000000-0000-0000-0000-00000000f900';
  RESET ROLE;
  SELECT status INTO v_status FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f900';
  IF v_status <> 'active' THEN RAISE EXCEPTION 'T-legacy FAIL: could not restore incomplete legacy card'; END IF;
  RAISE NOTICE '6. incomplete legacy card can be archived / restored / retagged / metadata-edited: PASS';

  -- removing the legacy card's last tag is a regression → blocked
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tenant_battle_cards SET tags=ARRAY['  ']::text[] WHERE id='00000000-0000-0000-0000-00000000f900';
    RESET ROLE; RAISE EXCEPTION 'T-legacy FAIL: stripping legacy last tag accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RESET ROLE;
  RAISE NOTICE '7. removing the last good tag from a legacy card is blocked (non-regression): PASS';

  -- ══ (F) LEGACY row: valid full correction succeeds, then re-invalidation blocked
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards
     SET strength='Brand recognition', weakness='- complex'||chr(10)||'- costly', our_win='__Faster__ time to value'
   WHERE id='00000000-0000-0000-0000-00000000f900';
  RESET ROLE;
  IF NOT public.battle_card_has_meaningful_text((SELECT our_win FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f900')) THEN RAISE EXCEPTION 'T-fix FAIL: legacy our_win not saved'; END IF;
  -- now fully valid → can no longer be re-blanked (real serializer-empty value: "- "
  -- is what an empty bullet stores as; the helper reduces it to no visible text)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE public.tenant_battle_cards SET weakness='- ' WHERE id='00000000-0000-0000-0000-00000000f900';
    RESET ROLE; RAISE EXCEPTION 'T-fix FAIL: re-blanking a now-valid legacy weakness accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RESET ROLE;
  RAISE NOTICE '8. legacy row can be fully corrected; once valid it cannot regress: PASS';

  -- ══ (G) service_role + owner are EXEMPT (068 emergency access preserved) ═════
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  SET LOCAL ROLE service_role;
  -- No meaningful tag + blank bodies: the trigger would reject this for a client,
  -- but service_role is exempt (tags is NOT NULL, so use an empty array, not NULL).
  INSERT INTO public.tenant_battle_cards (id, tenant_id, title, content, tags, strength, weakness, our_win, status)
    VALUES ('00000000-0000-0000-0000-00000000f902','00000000-0000-0000-0000-0000000000a0','svc backfill','[]'::jsonb, ARRAY[]::text[], '', '', '', 'active');
  RESET ROLE;
  IF (SELECT count(*) FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f902') <> 1 THEN RAISE EXCEPTION 'T-exempt FAIL: service_role incomplete insert blocked'; END IF;
  RAISE NOTICE '9. service_role + owner may write incomplete cards (emergency/seed access preserved): PASS';

  -- ══ (H) learner / anon / cross-tenant still rejected (RLS unbroken) ══════════
  -- learner cannot INSERT even a fully-valid card (no INSERT policy → RLS denies)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','Rep card',ARRAY['t'],'s','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-rls FAIL: learner INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  RESET ROLE;
  -- anon cannot INSERT (no grant)
  PERFORM set_config('request.jwt.claims','{"role":"anon"}',true);
  SET LOCAL ROLE anon;
  BEGIN
    INSERT INTO public.tenant_battle_cards (tenant_id, title, tags, strength, weakness, our_win, content)
      VALUES ('00000000-0000-0000-0000-0000000000a0','Anon',ARRAY['t'],'s','w','o','[]'::jsonb);
    RESET ROLE; RAISE EXCEPTION 'T-rls FAIL: anon INSERT succeeded';
  EXCEPTION WHEN insufficient_privilege OR check_violation THEN NULL; END;
  RESET ROLE;
  -- cross-tenant manager B cannot UPDATE tenant-A card (RLS filters → 0 rows)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  UPDATE public.tenant_battle_cards SET subtitle='hijack' WHERE id='00000000-0000-0000-0000-00000000f001';
  GET DIAGNOSTICS v_cnt = ROW_COUNT;
  RESET ROLE;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'T-rls FAIL: cross-tenant UPDATE affected % rows', v_cnt; END IF;
  RAISE NOTICE '10. learner/anon INSERT and cross-tenant UPDATE still rejected (RLS intact): PASS';

  -- ══ (I) hard-delete remains blocked (068 closure intact) ════════════════════
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  BEGIN
    DELETE FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001';
    RESET ROLE; RAISE EXCEPTION 'T-del FAIL: manager hard-deleted a card';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RESET ROLE;
  IF (SELECT count(*) FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f001') <> 1 THEN RAISE EXCEPTION 'T-del FAIL: card was deleted'; END IF;
  RAISE NOTICE '11. hard-delete of a Battle Card still blocked for clients: PASS';

  -- ══ (J) orgAdmin can create a valid card (manager/orgAdmin behavior) ════════
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000ac","role":"authenticated"}',true);
  SET LOCAL ROLE authenticated;
  INSERT INTO public.tenant_battle_cards (id, tenant_id, title, content, tags, strength, weakness, our_win, status)
    VALUES ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000a0','Admin card','[]'::jsonb,
            ARRAY['ops'], 'strong brand', 'slow rollout', 'we are faster', 'active');
  RESET ROLE;
  IF (SELECT count(*) FROM public.tenant_battle_cards WHERE id='00000000-0000-0000-0000-00000000f003') <> 1 THEN RAISE EXCEPTION 'T-admin FAIL: orgAdmin valid insert blocked'; END IF;
  RAISE NOTICE '12. orgAdmin can create a fully-valid card: PASS';

  RAISE NOTICE '070 ALL TESTS PASSED';
END $$;

ROLLBACK;
