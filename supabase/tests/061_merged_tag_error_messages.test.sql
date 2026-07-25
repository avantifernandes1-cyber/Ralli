-- Repeatable tests for migration 061 (honest merged-tag collision messages).
-- Proves create/rename report the correct message per collision kind (active /
-- plain-archived / merged) and that NO taxonomy mappings or historical snapshots
-- change. RPCs run as owner with request.jwt.claims set. One rolled-back
-- transaction. Local only. Expect "061 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a0','ta','TA');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdminA' WHERE id='00000000-0000-0000-0000-0000000000a9';

-- Tags: Avanti (active target), Discovery (active, will be archived plain),
--       Testing (active, will be merged into Avanti).
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.create_quiz_tag('Avanti');
  PERFORM public.create_quiz_tag('Discovery');
  PERFORM public.create_quiz_tag('Testing');
END $$;

-- Snapshot baseline counts to prove no data/mapping/snapshot change.
DO $$ DECLARE map0 int; tags0 int; snap0 int; link0 int; BEGIN
  SELECT count(*) INTO map0 FROM public.quiz_tag_map;
  SELECT count(*) INTO snap0 FROM public.quiz_attempt_tag_snapshots;
  SELECT count(*) INTO link0 FROM public.quiz_attempt_tags;
  PERFORM set_config('app.map0', map0::text, true);
  PERFORM set_config('app.snap0', snap0::text, true);
  PERFORM set_config('app.link0', link0::text, true);
END $$;

-- Set up: archive Discovery (plain), merge Testing -> Avanti.
DO $$ DECLARE disc uuid; test uuid; av uuid; BEGIN
  SELECT id INTO disc FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT id INTO test FROM public.tenant_quiz_tags WHERE normalized_label='testing';
  SELECT id INTO av   FROM public.tenant_quiz_tags WHERE normalized_label='avanti';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.archive_quiz_tag(disc);        -- plain archived (no mappings -> allowed)
  PERFORM public.merge_quiz_tags(test, av);     -- Testing archived + merged_into Avanti
END $$;

-- ── 1. CREATE on a plain archived name → Restore message ─────────────────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.create_quiz_tag('discovery'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%is archived. Restore it instead%', 'create/plain-archived -> Restore message: '||msg;
  ASSERT msg NOT LIKE '%merged into%', 'plain-archived message must NOT mention merge';
  RAISE NOTICE '1. create on plain-archived name -> Restore message: PASS';
END $$;

-- ── 2. RENAME onto a plain archived name → Restore message ───────────────────
DO $$ DECLARE av uuid; msg text := ''; BEGIN
  SELECT id INTO av FROM public.tenant_quiz_tags WHERE normalized_label='avanti';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.rename_quiz_tag(av, 'Discovery'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%is archived. Restore it instead%', 'rename/plain-archived -> Restore message: '||msg;
  RAISE NOTICE '2. rename onto plain-archived name -> Restore message: PASS';
END $$;

-- ── 3. CREATE on a merged name → merged-target message (no Restore) ──────────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.create_quiz_tag('testing'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%Testing was merged into Avanti and cannot be recreated. Use Avanti instead.%', 'create/merged -> merged-target message: '||msg;
  ASSERT msg NOT LIKE '%Restore%', 'merged message must NOT say Restore';
  RAISE NOTICE '3. create on merged name -> merged-target message (no Restore): PASS';
END $$;

-- ── 4. RENAME onto a merged name → merged-target message ─────────────────────
DO $$ DECLARE av uuid; msg text := ''; BEGIN
  SELECT id INTO av FROM public.tenant_quiz_tags WHERE normalized_label='avanti';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.rename_quiz_tag(av, 'testing'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%Testing was merged into Avanti and cannot be recreated. Use Avanti instead.%', 'rename/merged -> merged-target message: '||msg;
  ASSERT msg NOT LIKE '%Restore%', 'merged message must NOT say Restore';
  RAISE NOTICE '4. rename onto merged name -> merged-target message: PASS';
END $$;

-- ── 5. Active duplicate → plain "already exists" (unchanged reservation) ──────
DO $$ DECLARE msg text := ''; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.create_quiz_tag('avanti'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%already exists%' AND msg NOT LIKE '%archived%' AND msg NOT LIKE '%merged%', 'active dup message: '||msg;
  RAISE NOTICE '5. active duplicate -> plain already-exists: PASS';
END $$;

-- ── 6. State proof: merged tag has merged_into set; plain archived does not ───
DO $$ DECLARE disc_merged uuid; test_merged uuid; BEGIN
  SELECT merged_into INTO disc_merged FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT merged_into INTO test_merged FROM public.tenant_quiz_tags WHERE normalized_label='testing';
  ASSERT disc_merged IS NULL, 'plain archived tag has NULL merged_into (Restore eligible)';
  ASSERT test_merged IS NOT NULL, 'merged tag has merged_into set (no Restore)';
  RAISE NOTICE '6. plain-archived restorable / merged not (merged_into distinguishes): PASS';
END $$;

-- ── 7. No mappings or historical snapshots changed by any of the above ───────
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM public.quiz_tag_map) = current_setting('app.map0')::int, 'quiz_tag_map unchanged';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots) = current_setting('app.snap0')::int, 'snapshots unchanged';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags) = current_setting('app.link0')::int, 'snapshot links unchanged';
  RAISE NOTICE '7. no mappings/snapshots changed: PASS';
END $$;

ROLLBACK;
\echo '061 ALL TESTS PASSED'
