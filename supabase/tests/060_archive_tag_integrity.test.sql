-- Repeatable tests for migration 060 (archived-tag integrity). Covers: sole-
-- active-tag archive rejected atomically with a count-bearing error; archive
-- succeeds + detaches when every affected quiz keeps another active tag;
-- conditional cleanup never strands a quiz; zero/archived-only/foreign/merged
-- set_quiz_tags rejected server-side; valid first classification + later edits;
-- immutable attempt snapshots unchanged; merge + restore behavior. RPCs run as
-- owner with request.jwt.claims set (SECURITY DEFINER resolves the caller).
-- One rolled-back transaction. Local only. Expect "060 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures: tenant A (a9 orgAdmin, a1 rep) + tenant B (b9 orgAdmin).
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','b9@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdminA' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1'  WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', name='AdminB' WHERE id='00000000-0000-0000-0000-0000000000b9';

INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score, tags) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','QA','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a0','QB','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a0','QC','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb),
 ('00000000-0000-0000-0000-0000000000fb','00000000-0000-0000-0000-0000000000b0','QBt','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb);
-- Pre-existing attempt on QA so first classification creates immutable snapshots.
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key, grading_provenance) VALUES
 ('00000000-0000-0000-0000-00000000a101','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',100,true,1,'[{"questionId":"q1","selected":1,"isCorrect":true}]'::jsonb,'a1010101-0000-0000-0000-0000000000f1','server_v2');

-- Governance: create tenant-A tags T1,T2 and tenant-B tag TB.
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.create_quiz_tag('Discovery');   -- T1
  PERFORM public.create_quiz_tag('Objections');  -- T2
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  PERFORM public.create_quiz_tag('TenantBTag');  -- TB
END $$;

-- ── 1. set_quiz_tags rejects empty / archived-only / foreign / merged sets ───
DO $$ DECLARE t1 uuid; t2 uuid; tb uuid; e int := 0; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='discovery';
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000a0' AND normalized_label='objections';
  SELECT id INTO tb FROM public.tenant_quiz_tags WHERE tenant_id='00000000-0000-0000-0000-0000000000b0' AND normalized_label='tenantbtag';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[]::uuid[], true); EXCEPTION WHEN others THEN e := e+1; END; -- empty
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[tb], true);       EXCEPTION WHEN others THEN e := e+1; END; -- foreign tenant
  ASSERT e = 2, 'empty and foreign-tenant sets rejected';
  -- Now classify QA with [T1,T2] (valid first classification) -> snapshots form.
  ASSERT (public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[t1,t2], true)->>'classification')='tagged', 'valid first classification';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags WHERE attempt_id='00000000-0000-0000-0000-00000000a101')=2, 'initial classification created 2 snapshot links';
  RAISE NOTICE '1. set_quiz_tags rejects empty/foreign; valid first classification + snapshots: PASS';
END $$;

-- ── 2. Sole-active-tag archive is REJECTED atomically (count-bearing) ─────────
DO $$ DECLARE t1 uuid; t2 uuid; blocked boolean := false; msg text; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  -- QB classified with ONLY T1 -> T1 is QB's sole active tag.
  PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[t1], true);
  BEGIN PERFORM public.archive_quiz_tag(t1);
  EXCEPTION WHEN others THEN blocked := true; msg := SQLERRM; END;
  ASSERT blocked, 'archive of a sole active tag is rejected';
  ASSERT msg LIKE '%only active tag on 1 quiz%', 'error is count-bearing';
  -- Atomic: nothing changed.
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=t1)='active', 'tag still active after rejected archive';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE tag_id=t1)=2, 'mappings intact (QA + QB)';
  RAISE NOTICE '2. sole-active-tag archive rejected atomically with count: PASS';
END $$;

-- ── 3. Archive SUCCEEDS + detaches when every affected quiz keeps another tag ─
DO $$ DECLARE t1 uuid; t2 uuid; res jsonb; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  -- Give QB a second active tag so T1 is no longer anyone's sole active tag.
  PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[t1,t2], false);
  res := public.archive_quiz_tag(t1);
  ASSERT (res->>'status')='archived', 'archive succeeds';
  ASSERT (res->>'detached')::int = 2, 'detached from QA + QB';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE tag_id=t1)=0, 'current mappings removed';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1' AND tag_id=t2)=1, 'QA still mapped to T2 (kept its active tag)';
  RAISE NOTICE '3. archive succeeds + detaches current mappings (no quiz stranded): PASS';
END $$;

-- ── 4. Immutable attempt snapshots are UNCHANGED by archive+detach ───────────
DO $$ DECLARE t1 uuid; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags WHERE attempt_id='00000000-0000-0000-0000-00000000a101')=2, 'snapshot links still 2 after archive';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags WHERE tag_id=t1)=1, 'archived tag still referenced by history (preserved)';
  RAISE NOTICE '4. immutable attempt snapshots unchanged (history preserved): PASS';
END $$;

-- ── 5. Archived-only + merged-source sets rejected by set_quiz_tags ──────────
DO $$ DECLARE t1 uuid; t2 uuid; t3 uuid; e int := 0; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';   -- now archived
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';  -- active
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  t3 := (public.create_quiz_tag('Prospecting')->>'id')::uuid;
  PERFORM public.merge_quiz_tags(t3, t2);   -- T3 archived + merged_into T2
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f3', ARRAY[t1], true); EXCEPTION WHEN others THEN e := e+1; END; -- archived-only
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f3', ARRAY[t3], true); EXCEPTION WHEN others THEN e := e+1; END; -- merged source
  ASSERT e = 2, 'archived-only and merged-source sets rejected';
  RAISE NOTICE '5. archived-only + merged-source set_quiz_tags rejected: PASS';
END $$;

-- ── 6. Merge moves current mappings to the active target; source not on quizzes ─
DO $$ DECLARE t2 uuid; t4 uuid; BEGIN
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  t4 := (public.create_quiz_tag('Negotiation')->>'id')::uuid;
  PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f3', ARRAY[t4], true);   -- QC -> T4
  PERFORM public.merge_quiz_tags(t4, t2);   -- move T4's mappings to T2
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE tag_id=t4)=0, 'merged source not mapped to any quiz';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f3' AND tag_id=t2)=1, 'QC repointed to target T2';
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=t4)='archived', 'merged source archived';
  RAISE NOTICE '6. merge repoints to active target; source not on quizzes: PASS';
END $$;

-- ── 7. Restore reactivates the tag but does NOT reattach any mapping ─────────
DO $$ DECLARE t1 uuid; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';   -- archived (detached in §3)
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.restore_quiz_tag(t1);
  ASSERT (SELECT status FROM public.tenant_quiz_tags WHERE id=t1)='active', 'restore reactivates';
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE tag_id=t1)=0, 'restore does NOT reattach any quiz mapping';
  RAISE NOTICE '7. restore does not reattach mappings: PASS';
END $$;

-- ── 8. Conditional cleanup rule never strands a quiz (logic check) ───────────
-- Two quizzes carry an archived tag: one also has an active tag (cleanup removes
-- the archived mapping); the other has ONLY the archived tag (cleanup leaves it).
DO $$ DECLARE t1 uuid; t2 uuid; keep int; drop_cnt int; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  -- Re-archive T1 safely (QA keeps T2; QB has T1+T2). After archive T1 detached everywhere;
  -- craft the pre-060 scenario directly: QC mapped to archived-only; QA mapped to archived + active.
  UPDATE public.tenant_quiz_tags SET status='archived' WHERE id=t1;
  DELETE FROM public.quiz_tag_map WHERE quiz_id IN ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000f3');
  INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id) VALUES
    ('00000000-0000-0000-0000-0000000000f1', t1, '00000000-0000-0000-0000-0000000000a0'),  -- QA: archived T1
    ('00000000-0000-0000-0000-0000000000f1', t2, '00000000-0000-0000-0000-0000000000a0'),  -- QA: active   T2
    ('00000000-0000-0000-0000-0000000000f3', t1, '00000000-0000-0000-0000-0000000000a0');  -- QC: archived T1 ONLY
  -- Run the same conditional-cleanup rule the migration applies.
  DELETE FROM public.quiz_tag_map m USING public.tenant_quiz_tags t
  WHERE m.tag_id = t.id AND t.status='archived'
    AND EXISTS (SELECT 1 FROM public.quiz_tag_map m2 JOIN public.tenant_quiz_tags t2 ON t2.id=m2.tag_id
                WHERE m2.quiz_id=m.quiz_id AND t2.status='active');
  SELECT count(*) INTO drop_cnt FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1' AND tag_id=t1;
  SELECT count(*) INTO keep     FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f3' AND tag_id=t1;
  ASSERT drop_cnt = 0, 'cleanup removed archived mapping from the quiz that still has an active tag';
  ASSERT keep = 1, 'cleanup LEFT the archived-only mapping (never strands the quiz)';
  RAISE NOTICE '8. conditional cleanup removes-when-safe, leaves-when-sole: PASS';
END $$;

-- ── 9. Later valid edit of a classified quiz still works ─────────────────────
DO $$ DECLARE t2 uuid; BEGIN
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  ASSERT (public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[t2], false)->>'classification')='tagged', 'later edit (classify:false) works';
  RAISE NOTICE '9. later valid edit still works: PASS';
END $$;

ROLLBACK;
\echo '060 ALL TESTS PASSED'
