-- Repeatable tests for migration 062 (get_knowledge_heatmap canonical RPC).
-- Proves: attempt-time snapshots are the ONLY attribution source (current
-- quiz_tag_map never rewrites history); trusted server_v2-only scoring; legacy +
-- awaiting exclusion with honest coverage meta; every active learner is a column
-- even with no data; admin/inactive excluded; merged tags resolve transitively +
-- dedupe once; multi-tag contributes to each topic once; manager and learner
-- values match; threshold source is explicit (tenant_settings vs default); tenant
-- isolation; no quiz content in output. One rolled-back transaction. Local only.
-- Expect "062 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Users (auth.users insert auto-creates a profiles row via trigger) ─────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','l1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','l2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','l3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','m@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','lb@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','mb@t.test',now(),now());

INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');

-- TA has a configured threshold (70); TB has none (must fall back to 80/default).
INSERT INTO public.tenant_settings (tenant_id, learning_settings) VALUES
 ('00000000-0000-0000-0000-0000000000a0','{"readinessThreshold":70}'::jsonb),
 ('00000000-0000-0000-0000-0000000000b0','{}'::jsonb);

UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='L1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='L2' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='inactive', name='L3' WHERE id='00000000-0000-0000-0000-0000000000a3';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='M'  WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000b0', status='active',   name='LB' WHERE id='00000000-0000-0000-0000-0000000000b1';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active',   name='MB' WHERE id='00000000-0000-0000-0000-0000000000b9';

-- ── Tags ─────────────────────────────────────────────────────────────────────
-- TA: A=Discovery, B=Pricing, C=Objection (all active); Mg=Legacy merged INTO A.
INSERT INTO public.tenant_quiz_tags (id, tenant_id, label, status, merged_into) VALUES
 ('00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0','Discovery','active',   NULL),
 ('00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0','Pricing',  'active',   NULL),
 ('00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0','Objection','active',   NULL),
 ('00000000-0000-0000-0000-00000000a013','00000000-0000-0000-0000-0000000000a0','Legacy',   'archived','00000000-0000-0000-0000-00000000a010'),
 ('00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0','Onboarding','active',  NULL);

-- ── Quizzes (classified => tags_classified_at set; Q4 unclassified) ───────────
INSERT INTO public.tenant_quizzes (id, tenant_id, name, status, tags_classified_at) VALUES
 ('00000000-0000-0000-0000-00000000a020','00000000-0000-0000-0000-0000000000a0','Q1','active',now()),
 ('00000000-0000-0000-0000-00000000a021','00000000-0000-0000-0000-0000000000a0','Q2','active',now()),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-0000000000a0','Q3','active',now()),
 ('00000000-0000-0000-0000-00000000a023','00000000-0000-0000-0000-0000000000a0','Q4','active',NULL),
 ('00000000-0000-0000-0000-00000000b020','00000000-0000-0000-0000-0000000000b0','QB','active',now());

-- CURRENT mappings (RPC must IGNORE these for history). Note Q2's current map is A
-- although its attempt snapshots below are B — proves history is not rewritten.
INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id) VALUES
 ('00000000-0000-0000-0000-00000000a020','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a021','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000b020','00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0');

-- ── Attempts (server_v2 unless noted legacy) ─────────────────────────────────
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, grading_provenance, created_at) VALUES
 -- L1/Q1: latest (80 @ t2) wins over 60 @ t1
 ('00000000-0000-0000-0000-00000000a030','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a020',60,false,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a031','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a020',80,true, 2,'server_v2','2026-01-02 10:00'),
 -- L1/Q2: score 40, snapshot B (history) despite current map A
 ('00000000-0000-0000-0000-00000000a032','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a021',40,false,1,'server_v2','2026-01-01 10:00'),
 -- L1/Q3: score 100, multi-tag snapshot A+C
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a022',100,true,1,'server_v2','2026-01-01 10:00'),
 -- L2/Q1: score 50, snapshot Mg+A (merged+target -> A once)
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a020',50,false,1,'server_v2','2026-01-01 10:00'),
 -- L2/Q4: score 30, server_v2 but NO snapshot (awaiting, excluded)
 ('00000000-0000-0000-0000-00000000a035','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a023',30,false,1,'server_v2','2026-01-01 10:00'),
 -- L2/Q2: score 20, LEGACY (null provenance) with snapshot (legacyExcluded)
 ('00000000-0000-0000-0000-00000000a036','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a021',20,false,1,NULL,'2026-01-01 10:00'),
 -- L3 (inactive)/Q1: 100 server_v2 — MUST be excluded
 ('00000000-0000-0000-0000-00000000a037','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000a020',100,true,1,'server_v2','2026-01-01 10:00'),
 -- M (orgAdmin)/Q1: 100 server_v2 — MUST be excluded (governor)
 ('00000000-0000-0000-0000-00000000a038','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-00000000a020',100,true,1,'server_v2','2026-01-01 10:00'),
 -- TB isolation: LB/QB 55 server_v2 snapshot TBt
 ('00000000-0000-0000-0000-00000000b030','00000000-0000-0000-0000-0000000000b0','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000b020',55,false,1,'server_v2','2026-01-01 10:00');

-- ── Snapshot envelopes (presence = classified/attributable) ──────────────────
-- Every attempt EXCEPT a035 (L2/Q4 awaiting) gets an envelope.
INSERT INTO public.quiz_attempt_tag_snapshots (attempt_id, tenant_id, quiz_id, snapshot_source) VALUES
 ('00000000-0000-0000-0000-00000000a030','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a020','grading'),
 ('00000000-0000-0000-0000-00000000a031','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a020','grading'),
 ('00000000-0000-0000-0000-00000000a032','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a021','grading'),
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a022','grading'),
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a020','grading'),
 ('00000000-0000-0000-0000-00000000a036','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a021','initial_classification'),
 ('00000000-0000-0000-0000-00000000a037','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a020','grading'),
 ('00000000-0000-0000-0000-00000000a038','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-00000000a020','grading'),
 ('00000000-0000-0000-0000-00000000b030','00000000-0000-0000-0000-0000000000b0','00000000-0000-0000-0000-00000000b020','grading');

-- ── Snapshot tag links (attempt-time truth) ──────────────────────────────────
INSERT INTO public.quiz_attempt_tags (attempt_id, tag_id, tenant_id) VALUES
 ('00000000-0000-0000-0000-00000000a030','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- L1/Q1 a1 -> A
 ('00000000-0000-0000-0000-00000000a031','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- L1/Q1 a2 -> A
 ('00000000-0000-0000-0000-00000000a032','00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0'), -- L1/Q2 -> B (history)
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- L1/Q3 -> A
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0'), -- L1/Q3 -> C (multi)
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-00000000a013','00000000-0000-0000-0000-0000000000a0'), -- L2/Q1 -> Mg (merged->A)
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- L2/Q1 -> A (dedupe with Mg)
 ('00000000-0000-0000-0000-00000000a036','00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0'), -- L2/Q2 legacy -> B
 ('00000000-0000-0000-0000-00000000a037','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- L3/Q1 -> A (excluded via inactive)
 ('00000000-0000-0000-0000-00000000a038','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'), -- M/Q1  -> A (excluded via role)
 ('00000000-0000-0000-0000-00000000b030','00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0'); -- TB

-- ═════════════════════ MANAGER VIEW (call as M, TA) ═════════════════════════
DO $$
DECLARE v jsonb; tA jsonb; tB jsonb; tC jsonb; rs1 jsonb; rs2 jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();

  -- 3 topics only (A, B, C) — Q4/awaiting and legacy do not create topics.
  ASSERT jsonb_array_length(v->'topics') = 3, '1. manager topic count = 3: '||(v->'topics')::text;

  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  SELECT e INTO tB FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Pricing';
  SELECT e INTO tC FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Objection';

  -- Topic A: equal-weight mean of L1(90) and L2(50) = 70. tagId is the ACTIVE target.
  ASSERT tA->>'tagId' = '00000000-0000-0000-0000-00000000a010', '2. A tagId is stable active id';
  ASSERT (tA->>'avgScore')::int = 70, '2. A avg = 70 (equal-weight): '||(tA->>'avgScore');
  ASSERT (tA->>'measuredLearners')::int = 2, '2. A measured=2';
  ASSERT (tA->>'learnersNoData')::int = 0, '2. A noData=0';
  ASSERT (tA->>'repsBelow')::int = 1 AND (tA->>'repsAbove')::int = 1, '2. A below/above=1/1 (thr 70)';

  SELECT rs INTO rs1 FROM jsonb_array_elements(tA->'repScores') rs WHERE rs->>'userId'='00000000-0000-0000-0000-0000000000a1';
  SELECT rs INTO rs2 FROM jsonb_array_elements(tA->'repScores') rs WHERE rs->>'userId'='00000000-0000-0000-0000-0000000000a2';
  -- L1/A = mean(Q1 latest 80, Q3 100) = 90 over n=2 quizzes (history: Q2 is under B, NOT A)
  ASSERT (rs1->>'score')::int = 90 AND (rs1->>'n')::int = 2, '3. L1/A=90 n=2 (Q1 latest 80 + Q3 100): '||rs1::text;
  -- L2/A = 50 from Q1 snapshot {Mg,A} resolved+deduped to A once (n=1)
  ASSERT (rs2->>'score')::int = 50 AND (rs2->>'n')::int = 1, '4. L2/A=50 n=1 (merged Mg+A dedupe once): '||rs2::text;
  -- Excluded identities never appear as repScores
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tA->'repScores') rs
                     WHERE rs->>'userId' IN ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a9')),
         '5. inactive L3 and governor M excluded from repScores';

  -- Topic B: only L1 (40) — proves Q2 history attributed to B, not current map A
  ASSERT (tB->>'avgScore')::int = 40 AND (tB->>'measuredLearners')::int = 1 AND (tB->>'learnersNoData')::int = 1,
         '6. B avg=40 measured=1 noData=1 (attempt-time B, not current-map A): '||tB::text;
  -- Topic C: only L1 (100) from the multi-tag attempt
  ASSERT (tC->>'avgScore')::int = 100 AND (tC->>'measuredLearners')::int = 1, '7. C avg=100 measured=1 (multi-tag): '||tC::text;

  -- Topics sorted weakest-first: B(40), A(70), C(100)
  ASSERT (v->'topics'->0->>'label')='Pricing' AND (v->'topics'->2->>'label')='Objection', '8. topics sorted weakest-first';

  -- learners[] = both active learners as columns; excluded identities absent
  ASSERT jsonb_array_length(v->'learners') = 2, '9. learners=2 columns';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'learners') l
                     WHERE l->>'userId' IN ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a9')),
         '9. L3/M not columns';

  -- Coverage meta (population = L1,L2 -> 7 attempts): 5 verified / 1 legacy / 1 awaiting
  m := v->'meta';
  ASSERT (m->>'totalActiveLearners')::int = 2, '10. meta totalActiveLearners=2';
  ASSERT (m->>'measuredLearners')::int    = 2, '10. meta measuredLearners=2';
  ASSERT (m->>'totalAttempts')::int        = 7, '10. meta totalAttempts=7: '||m::text;
  ASSERT (m->>'verifiedAttributed')::int   = 5, '10. meta verified=5';
  ASSERT (m->>'legacyExcluded')::int       = 1, '10. meta legacyExcluded=1';
  ASSERT (m->>'awaitingClassification')::int = 1, '10. meta awaiting=1';
  ASSERT (m->>'threshold')::int = 70 AND m->>'thresholdSource' = 'tenant_settings', '10. threshold=70 source=tenant_settings';

  -- No quiz content leaks anywhere in the payload
  ASSERT v::text NOT LIKE '%question%' AND v::text NOT LIKE '%answer%' AND v::text NOT LIKE '%solution%',
         '11. no quiz content in output';
  RAISE NOTICE 'MANAGER view: PASS';
END $$;

-- ═════════════════════ LEARNER VIEW parity (call as L1) ═════════════════════
DO $$
DECLARE v jsonb; tA jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();

  -- Learner sees only self as a column
  ASSERT jsonb_array_length(v->'learners') = 1
     AND (v->'learners'->0->>'userId') = '00000000-0000-0000-0000-0000000000a1', '12. learner sees only self';
  -- Only own repScores; no other learner
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v->'topics') t, jsonb_array_elements(t->'repScores') rs
    WHERE rs->>'userId' <> '00000000-0000-0000-0000-0000000000a1'), '12. learner only own repScores';

  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  -- Parity: learner A avg (90) == manager A repScores[L1] (90)
  ASSERT (tA->>'avgScore')::int = 90, '13. learner L1/A avg=90 matches manager cell';

  m := v->'meta';
  ASSERT (m->>'totalActiveLearners')::int = 1 AND (m->>'measuredLearners')::int = 1, '14. learner meta self-scoped';
  ASSERT (m->>'totalAttempts')::int = 4 AND (m->>'verifiedAttributed')::int = 4
     AND (m->>'legacyExcluded')::int = 0 AND (m->>'awaitingClassification')::int = 0, '14. learner L1 coverage 4/4/0/0';
  ASSERT (m->>'threshold')::int = 70 AND m->>'thresholdSource'='tenant_settings', '14. learner threshold source';
  RAISE NOTICE 'LEARNER L1 view: PASS';
END $$;

-- ═════════════════════ LEARNER L2 (legacy+awaiting excluded from own scores) ══
DO $$
DECLARE v jsonb; tA jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();
  ASSERT jsonb_array_length(v->'topics') = 1, '15. L2 has exactly one measured topic (A)';
  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  ASSERT (tA->>'avgScore')::int = 50, '15. L2/A=50 (parity with manager)';
  m := v->'meta';
  ASSERT (m->>'totalAttempts')::int = 3 AND (m->>'verifiedAttributed')::int = 1
     AND (m->>'legacyExcluded')::int = 1 AND (m->>'awaitingClassification')::int = 1, '15. L2 coverage 3/1/1/1';
  RAISE NOTICE 'LEARNER L2 view: PASS';
END $$;

-- ═════════════════════ TENANT ISOLATION + DEFAULT THRESHOLD (call as MB, TB) ══
DO $$
DECLARE v jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();
  -- Only TB's own tag/learner; NONE of TA's tags or learners
  ASSERT jsonb_array_length(v->'topics') = 1 AND (v->'topics'->0->>'label') = 'Onboarding', '16. TB sees only its topic';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'topics') t
                     WHERE t->>'label' IN ('Discovery','Pricing','Objection')), '16. no TA topic leak';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'learners') l
                     WHERE l->>'userId' LIKE '00000000-0000-0000-0000-0000000000a%'), '16. no TA learner leak';
  m := v->'meta';
  -- TB has no configured threshold -> documented 80 default, source explicit
  ASSERT (m->>'threshold')::int = 80 AND m->>'thresholdSource' = 'default', '17. TB threshold=80 source=default (no hidden fallback)';
  RAISE NOTICE 'TENANT ISOLATION + DEFAULT THRESHOLD: PASS';
END $$;

ROLLBACK;
\echo '062 ALL TESTS PASSED'
