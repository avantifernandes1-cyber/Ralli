-- Repeatable tests for migration 059 (attempt-time taxonomy snapshots). Covers
-- the THREE explicit classification states and transitions:
--   • awaiting            — no decision (no envelope); passive calls never finalize.
--   • tagged (initial)    — inherit initial tag set to awaiting attempts once.
--   • uncategorized       — intentional zero-tag classification (envelope, 0 links).
-- Plus: future-only attach/detach, immutability of existing snapshots, unchanged
-- grading, manager-only immutable RLS, and the history-protecting tag FK.
-- RPC calls run as owner with request.jwt.claims set; direct-table RLS tests run
-- under SET ROLE authenticated. One rolled-back transaction. Local only.
-- Expect "059 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

GRANT SELECT ON public.quiz_attempt_tag_snapshots TO authenticated;
GRANT SELECT ON public.quiz_attempt_tags          TO authenticated;
GRANT SELECT ON public.profiles                   TO authenticated;

-- Fixtures: tenant A, a9 orgAdmin, a1 rep, quizzes QA + QB (both unclassified),
-- each with one pre-taxonomy attempt (created directly = "awaiting").
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','a9@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','a1@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES ('00000000-0000-0000-0000-0000000000a0','ta','TA');
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='AdminA' WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', name='RepA1'  WHERE id='00000000-0000-0000-0000-0000000000a1';
INSERT INTO public.tenant_quizzes (id, tenant_id, name, questions, status, is_favorite, passing_score, tags) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a0','QA','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a0','QB','[{"id":"q1","type":"mc","options":["A","B"],"correct":1}]'::jsonb,'active',false,100,'[]'::jsonb);
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key, grading_provenance) VALUES
 ('00000000-0000-0000-0000-00000000a101','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1',100,true,1,'[{"questionId":"q1","selected":1,"isCorrect":true}]'::jsonb,'a1010101-0000-0000-0000-0000000000f1','server_v2'),
 ('00000000-0000-0000-0000-00000000a201','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f2',100,true,1,'[{"questionId":"q1","selected":1,"isCorrect":true}]'::jsonb,'a2010101-0000-0000-0000-0000000000f2','server_v2');

-- Governance: create the tenant vocabulary up front (orgAdmin).
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.create_quiz_tag('Discovery');
  PERFORM public.create_quiz_tag('Objections');
END $$;

-- ── 1. AWAITING: no envelope; passive calls never finalize an untouched quiz ──
DO $$ DECLARE rev text; res jsonb; t1 uuid; err boolean := false; e2 boolean := false; BEGIN
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots)=0, 'pre-taxonomy attempts have no envelope';
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  res := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[{"questionId":"q1","selected":1}]'::jsonb, rev, gen_random_uuid());
  ASSERT (res->>'server_score')='100' AND (res->>'server_passed')='true', 'grading unchanged';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots WHERE quiz_id='00000000-0000-0000-0000-0000000000f1')=0, 'new attempt on UNCLASSIFIED quiz stays awaiting';
  -- Post-060: a zero-tag classification is rejected (no Uncategorized state), so
  -- an untouched quiz cannot be accidentally finalized empty.
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[]::uuid[], true); EXCEPTION WHEN others THEN e2 := true; END;
  ASSERT e2, 'zero-tag classification rejected';
  ASSERT (SELECT tags_classified_at IS NULL FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f2'), 'rejected call did not finalize';
  -- Assigning tags to an unclassified quiz without p_classify is rejected.
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[t1], false); EXCEPTION WHEN others THEN err := true; END;
  ASSERT err, 'tags without p_classify rejected';
  RAISE NOTICE '1. awaiting: no envelope; zero-tag classify rejected; tags-without-classify rejected: PASS';
END $$;

-- ── 2. TAGGED initial classification inherits initial set once to awaiting ───
DO $$ DECLARE t1 uuid; t2 uuid; res jsonb; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  res := public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[t1, t2], true);
  ASSERT (res->>'classification')='tagged', 'classified tagged';
  ASSERT (SELECT tags_classified_at IS NOT NULL FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1'), 'watermark set';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots WHERE quiz_id='00000000-0000-0000-0000-0000000000f1' AND snapshot_source='initial_classification')=2, 'both awaiting attempts enveloped';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags qt JOIN public.quiz_attempt_tag_snapshots s ON s.attempt_id=qt.attempt_id WHERE s.quiz_id='00000000-0000-0000-0000-0000000000f1')=4, 'each of 2 attempts inherited 2 tags';
  RAISE NOTICE '2. tagged initial classification inherits set once: PASS';
END $$;

-- ── 3. Immutability + future-only: detach on classified quiz ─────────────────
DO $$ DECLARE t1 uuid; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f1', ARRAY[t1], false);   -- detach Objections
  ASSERT (SELECT count(*) FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1')=1, 'current map now 1 tag';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags qt JOIN public.quiz_attempt_tag_snapshots s ON s.attempt_id=qt.attempt_id WHERE s.quiz_id='00000000-0000-0000-0000-0000000000f1')=4, 'historical snapshots UNCHANGED';
  RAISE NOTICE '3. detach affects future only; existing snapshots immutable: PASS';
END $$;

-- ── 4. Post-classification new attempt snapshots the CURRENT set (grading) ───
DO $$ DECLARE rev text; res jsonb; aid uuid; BEGIN
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  res := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[{"questionId":"q1","selected":1}]'::jsonb, rev, gen_random_uuid());
  aid := (res->'attempt'->>'id')::uuid;
  ASSERT (SELECT snapshot_source FROM public.quiz_attempt_tag_snapshots WHERE attempt_id=aid)='grading', 'grading snapshot';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags WHERE attempt_id=aid)=1, 'reflects CURRENT set (1 tag)';
  RAISE NOTICE '4. post-classification attempt snapshots current set: PASS';
END $$;

-- ── 5. Classified quiz with ZERO current mappings -> grading envelope, 0 links ─
-- Post-060, set_quiz_tags cannot empty a quiz and archive blocks the last active
-- tag, so a classified quiz reaches zero current mappings only via archive-detach
-- or legacy state. Simulate that directly (owner delete), then a new attempt still
-- records an envelope with ZERO tag links (059 grading-path behavior intact).
DO $$ DECLARE rev text; res jsonb; aid uuid; BEGIN
  DELETE FROM public.quiz_tag_map WHERE quiz_id='00000000-0000-0000-0000-0000000000f1';
  ASSERT (SELECT tags_classified_at IS NOT NULL FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1'), 'still classified with zero current mappings';
  SELECT question_revision INTO rev FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f1';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  res := public.submit_quiz_attempt_atomic_v2('00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000f1','[{"questionId":"q1","selected":1}]'::jsonb, rev, gen_random_uuid());
  aid := (res->'attempt'->>'id')::uuid;
  ASSERT EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots WHERE attempt_id=aid), 'classified+zero-mappings attempt HAS an envelope';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags WHERE attempt_id=aid)=0, 'envelope has ZERO tag links';
  RAISE NOTICE '5. classified + zero current mappings -> envelope, 0 links: PASS';
END $$;

-- ── 6. Zero-tag classification rejected; valid first classification inherits ──
DO $$ DECLARE t2 uuid; e boolean := false; res jsonb; BEGIN
  SELECT id INTO t2 FROM public.tenant_quiz_tags WHERE normalized_label='objections';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[]::uuid[], true); EXCEPTION WHEN others THEN e := true; END;
  ASSERT e, 'zero-tag initial classification rejected (no Uncategorized state)';
  ASSERT (SELECT tags_classified_at IS NULL FROM public.tenant_quizzes WHERE id='00000000-0000-0000-0000-0000000000f2')
     AND (SELECT count(*) FROM public.quiz_attempt_tag_snapshots WHERE quiz_id='00000000-0000-0000-0000-0000000000f2')=0, 'f2 still awaiting, no envelope';
  -- A VALID (non-empty) first classification inherits to f2's awaiting attempt once.
  res := public.set_quiz_tags('00000000-0000-0000-0000-0000000000f2', ARRAY[t2], true);
  ASSERT (res->>'classification')='tagged', 'valid first classification';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots WHERE quiz_id='00000000-0000-0000-0000-0000000000f2' AND snapshot_source='initial_classification')=1, 'f2 attempt enveloped';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags qt JOIN public.quiz_attempt_tag_snapshots s ON s.attempt_id=qt.attempt_id WHERE s.quiz_id='00000000-0000-0000-0000-0000000000f2')=1, 'inherited 1 tag';
  RAISE NOTICE '6. zero-tag classification rejected; valid first classification inherits: PASS';
END $$;

-- ── 7. Stored answers stay learner-safe (confidentiality unchanged by 059) ───
DO $$ DECLARE leaked int; BEGIN
  SELECT count(*) INTO leaked FROM public.quiz_attempts qa, jsonb_array_elements(qa.answers) a
    WHERE qa.grading_provenance='server_v2' AND (a ? 'correct' OR a ? 'acceptedAnswers' OR a ? 'tolerance');
  ASSERT leaked=0, 'server_v2 answers carry no canonical key';
  RAISE NOTICE '7. grading path answers remain learner-safe: PASS';
END $$;

-- ── 8. Snapshot tables: manager-only SELECT + NO write policy (immutable) ─────
DO $$ BEGIN
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempt_tag_snapshots' AND cmd='SELECT')=1, 'snapshot single SELECT policy';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempt_tag_snapshots' AND cmd<>'SELECT')=0, 'snapshot no write policy';
  ASSERT (SELECT count(*) FROM pg_policies WHERE tablename='quiz_attempt_tags' AND cmd<>'SELECT')=0, 'tag-links no write policy';
  RAISE NOTICE '8. snapshot tables immutable (no write policy): PASS';
END $$;

-- ── 9. Learner cannot read snapshot tables; manager can ──────────────────────
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots)=0, 'learner cannot read snapshots';
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tags)=0, 'learner cannot read tag links';
END $$;
DO $$ BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  ASSERT (SELECT count(*) FROM public.quiz_attempt_tag_snapshots) >= 3, 'manager reads tenant snapshots';
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE '9. learner snapshot read blocked; manager read retained: PASS'; END $$;

-- ── 10. A tag referenced by history can NEVER be hard-deleted (RESTRICT) ──────
DO $$ DECLARE t1 uuid; fk boolean := false; BEGIN
  SELECT id INTO t1 FROM public.tenant_quiz_tags WHERE normalized_label='discovery';
  BEGIN DELETE FROM public.tenant_quiz_tags WHERE id=t1; EXCEPTION WHEN foreign_key_violation THEN fk := true; END;
  ASSERT fk, 'tag referenced by attempt history cannot be hard-deleted';
  RAISE NOTICE '10. history-referenced tag protected from hard delete: PASS';
END $$;

ROLLBACK;
\echo '059 ALL TESTS PASSED'
