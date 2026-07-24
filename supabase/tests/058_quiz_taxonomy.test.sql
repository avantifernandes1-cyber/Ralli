-- Repeatable tests for migration 058 (Quiz Taxonomy foundation). Covers role
-- gates (governance vs assignment), case-insensitive dedupe reserved across ALL
-- statuses, restore/unarchive, tenant isolation, structural tenant-consistency
-- FKs, rename/archive/merge behavior + merge hardening, learner RLS denial, the
-- manager read path for assignable tags, and the additive learner-safe RPC.
-- RLS-on-tables tests run under SET ROLE authenticated (RLS is only enforced for
-- non-owners); RPC role-gate tests run as owner with request.jwt.claims set (RPCs
-- are SECURITY DEFINER and resolve the caller via the claim). One rolled-back
-- transaction. Local only, no creds. Expect "058 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

GRANT SELECT ON public.tenant_quiz_tags TO authenticated;
GRANT SELECT ON public.quiz_tag_map     TO authenticated;
GRANT SELECT ON public.profiles         TO authenticated;

-- Fixtures: tenant A (a9 orgAdmin, a8 manager, a1 rep) + tenant B (b9 orgAdmin).
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a8','authenticated','authenticated','a8@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','b9@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdminA' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='manager',  tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='MgrA'   WHERE id='00000000-0000-0000-0000-0000000000a8';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1'  WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='AdminB' WHERE id='00000000-0000-0000-0000-0000000000b9';

INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score, tags) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','QA',
   '[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb),
 ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000b0','QB',
   '[{"id":"w1","type":"mc","options":["A","B"],"correct":0}]'::jsonb,'active',false,100,'[]'::jsonb);
INSERT INTO public.tenant_assignments (tenant_id, content_type, content_id, assigned_to, source_type, required, assigned_at) VALUES
 ('00000000-0000-0000-0000-0000000000a0','quiz','00000000-0000-0000-0000-0000000000f1','{"type":"individual","userId":"00000000-0000-0000-0000-0000000000a1"}'::jsonb,'individual',false,now());

-- ── 1. orgAdmin creates tags; case-insensitive dedupe rejected ───────────────
DO $$ DECLARE t1 jsonb; dup boolean := false; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  t1 := public.create_quiz_tag('Discovery');
  PERFORM public.create_quiz_tag('Objections');
  ASSERT (t1 ? 'id') AND (t1->>'label')='Discovery' AND (t1->>'status')='active', 'orgAdmin created tag';
  BEGIN PERFORM public.create_quiz_tag('  discovery '); EXCEPTION WHEN unique_violation THEN dup := true; END;
  ASSERT dup, 'case-insensitive duplicate rejected';
  RAISE NOTICE '1. orgAdmin create + case-insensitive dedupe: PASS';
END $$;

-- ── 2. Manager and learner CANNOT create taxonomy (governance) ───────────────
DO $$ DECLARE blocked int := 0; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}',true);
  BEGIN PERFORM public.create_quiz_tag('MgrTag'); EXCEPTION WHEN others THEN blocked := blocked + 1; END;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  BEGIN PERFORM public.create_quiz_tag('RepTag'); EXCEPTION WHEN others THEN blocked := blocked + 1; END;
  ASSERT blocked = 2, 'manager AND learner both blocked from creating taxonomy';
  RAISE NOTICE '2. governance gate: manager+learner cannot create tags: PASS';
END $$;

-- ── 3. Tenant isolation: same label ok across tenants; foreign mgmt blocked ───
DO $$ DECLARE tb jsonb; blocked boolean := false; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  tb := public.create_quiz_tag('Discovery');   -- allowed in tenant B (per-tenant uniqueness)
  ASSERT (tb ? 'id'), 'tenant B may reuse a label active in tenant A';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.rename_quiz_tag((tb->>'id')::uuid, 'Hijack'); EXCEPTION WHEN others THEN blocked := true; END;
  ASSERT blocked, 'cross-tenant rename rejected';
  RAISE NOTICE '3. tenant isolation (dup label ok; foreign mgmt blocked): PASS';
END $$;

-- ── 4. Structural tenant-consistency FK: cross-tenant map insert impossible ──
DO $$ DECLARE btag uuid; fk boolean := false; BEGIN
  SELECT id INTO btag FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000b0' AND normalized_label='discovery';
  BEGIN
    INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id)
      VALUES ('00000000-0000-0000-0000-0000000000f1', btag, '00000000-0000-0000-0000-0000000000a0');
  EXCEPTION WHEN foreign_key_violation THEN fk := true; END;
  ASSERT fk, 'composite FK blocks cross-tenant quiz↔tag mapping';
  RAISE NOTICE '4. structural tenant-consistency FK: PASS';
END $$;

-- ── 5. Manager assigns EXISTING tags (explicit classify); learner blocked ────
DO $$ DECLARE d_id uuid; o_id uuid; res jsonb; blocked boolean := false; badtag boolean := false; btag uuid; BEGIN
  SELECT id INTO d_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='discovery';
  SELECT id INTO o_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}',true);
  res := public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[d_id, o_id], true);
  ASSERT (res->>'classification')='tagged', 'manager classified with tags';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1')=2, 'two tags mapped';
  SELECT id INTO btag FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000b0' AND normalized_label='discovery';
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[btag], true); EXCEPTION WHEN others THEN badtag := true; END;
  ASSERT badtag, 'foreign tag id rejected';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[d_id], true); EXCEPTION WHEN others THEN blocked := true; END;
  ASSERT blocked, 'learner cannot assign tags';
  RAISE NOTICE '5. manager assign (explicit) ok; learner blocked; foreign tag rejected: PASS';
END $$;

-- ── 6. Rename preserves id; Archive retires; archived not assignable ─────────
DO $$ DECLARE d_id uuid; o_id uuid; nm text; blocked boolean := false; BEGIN
  SELECT id INTO d_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='discovery';
  SELECT id INTO o_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.rename_quiz_tag(d_id, 'Discovery Calls');
  SELECT label INTO nm FROM public.tenant_quiz_tags WHERE id=d_id;
  ASSERT nm='Discovery Calls', 'rename preserves id, updates label';
  PERFORM public.archive_quiz_tag(o_id);
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=o_id)='archived', 'tag archived';
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[d_id, o_id], false); EXCEPTION WHEN others THEN blocked := true; END;
  ASSERT blocked, 'archived tag not assignable';
  RAISE NOTICE '6. rename preserves id; archive retires + not assignable: PASS';
END $$;

-- ── 7. Archived label GLOBALLY RESERVED; restore/unarchive by id ─────────────
DO $$ DECLARE c jsonb; c_id uuid; dup boolean := false; rn boolean := false; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  c := public.create_quiz_tag('Compliance'); c_id := (c->>'id')::uuid;
  PERFORM public.archive_quiz_tag(c_id);
  -- Cannot recreate an archived label (would split analytics under identical text).
  BEGIN PERFORM public.create_quiz_tag('compliance'); EXCEPTION WHEN unique_violation THEN dup := true; END;
  ASSERT dup, 'archived label reserved: recreate rejected';
  -- Cannot rename another tag onto the archived label either.
  BEGIN PERFORM public.rename_quiz_tag((SELECT id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='discovery calls'), 'Compliance');
  EXCEPTION WHEN unique_violation THEN rn := true; END;
  ASSERT rn, 'rename onto an archived label rejected';
  -- Reuse = restore the same stable id.
  PERFORM public.restore_quiz_tag(c_id);
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=c_id)='active', 'restore reactivates the SAME id';
  RAISE NOTICE '7. archived label globally reserved; restore by id: PASS';
END $$;

-- ── 8. Merge repoints mapping, archives source w/ merged_into (+ hardening) ──
DO $$ DECLARE d_id uuid; o_id uuid; p_id uuid; c_id uuid;
        e int := 0; BEGIN
  SELECT id INTO d_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='discovery calls';
  SELECT id INTO o_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='objections';   -- archived
  SELECT id INTO c_id FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='compliance';    -- active (restored)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  p_id := (public.create_quiz_tag('Prospecting')->>'id')::uuid;
  -- Clean QA to a single active tag, then merge it into Prospecting.
  PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[d_id], false);
  PERFORM public.merge_quiz_tags(d_id, p_id);
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=d_id)='archived', 'merge source archived';
  ASSERT (SELECT merged_into FROM public.tenant_quiz_tags WHERE id=d_id)=p_id, 'source points to target';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1' AND tag_id=p_id)=1, 'mapping repointed to target';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1' AND tag_id=d_id)=0, 'source mapping removed';
  -- Hardening: self-merge / archived target / merged source all rejected.
  BEGIN PERFORM public.merge_quiz_tags(p_id, p_id);  EXCEPTION WHEN others THEN e := e + 1; END;   -- self-merge
  BEGIN PERFORM public.merge_quiz_tags(c_id, o_id);  EXCEPTION WHEN others THEN e := e + 1; END;   -- archived target
  BEGIN PERFORM public.merge_quiz_tags(d_id, p_id);  EXCEPTION WHEN others THEN e := e + 1; END;   -- already-merged source
  ASSERT e = 3, 'self-merge, archived-target, merged-source all rejected';
  RAISE NOTICE '8. merge repoints + archives source; hardening (self/archived/merged) rejected: PASS';
END $$;

-- ── 9. Learner CANNOT read taxonomy tables; manager CAN (assignable list) ────
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.tenant_quiz_tags)=0, 'learner cannot read tenant_quiz_tags';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map)=0, 'learner cannot read quiz_tag_map';
END $$;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a8","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND status='active') >= 1, 'manager reads assignable (active) own-tenant tags';
  ASSERT NOT EXISTS (SELECT 1 FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000b0'), 'manager cannot read tenant B tags';
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE '9. learner taxonomy read blocked; manager assignable-tag read path ok: PASS'; END $$;

-- ── 10. Learner-safe RPC: additive tagIds/tagDefs; legacy tags; labels only ──
DO $$ DECLARE tags jsonb; row0 jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  tags := public.list_quiz_tags_for_learner();
  SELECT e INTO row0 FROM jsonb_array_elements(tags) e WHERE e->>'id'='00000000-0000-0000-0000-0000000000f1';
  ASSERT row0 IS NOT NULL, 'assigned quiz present for learner';
  ASSERT (row0 ? 'tags') AND (row0 ? 'tagIds') AND (row0 ? 'tagDefs'), 'legacy tags + tagIds/tagDefs present';
  ASSERT jsonb_array_length(row0->'tagIds')=1, 'one current tag id (Prospecting)';
  ASSERT (row0->'tagDefs'->0->>'label')='Prospecting', 'tagDefs carry labels only';
  ASSERT NOT (row0::text LIKE '%correct%') AND NOT (row0::text LIKE '%options%'), 'no answer/question content in tag metadata';
  RAISE NOTICE '10. learner-safe additive tag metadata (labels only): PASS';
END $$;

ROLLBACK;
\echo '058 ALL TESTS PASSED'
