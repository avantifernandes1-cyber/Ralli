-- Repeatable tests for migration 062 (get_knowledge_heatmap canonical RPC).
-- Proves: attempt-time snapshots are the ONLY attribution source (current
-- quiz_tag_map never rewrites history); trusted server_v2-only scoring; legacy +
-- awaiting exclusion with honest coverage meta; EVERY active tenant tag is a topic
-- row (no-verified-evidence topics show avgScore=null, never 0); EVERY active
-- learner is a column with a truthful RPC-supplied name even without readiness or
-- attempts; admin/inactive excluded; merged tags resolve transitively + dedupe
-- once; multi-tag contributes to each topic once; manager and learner values match;
-- learner sees only relevant topics + only own identity; threshold source explicit;
-- multi-tenant authorization (own-only for manager/learner, explicit for ralli
-- admin, foreign/unknown rejected); no quiz content. One rolled-back transaction.
-- Local only. Expect "062 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Users (auth.users insert auto-creates a profiles row via trigger) ─────────
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','l1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','l2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','l3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a4','authenticated','authenticated','l4@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a9','authenticated','authenticated','m@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','lb@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b9','authenticated','authenticated','mb@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000c9','authenticated','authenticated','ra@t.test',now(),now());

INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','ta','TA'),
 ('00000000-0000-0000-0000-0000000000b0','tb','TB');

-- TA has a configured threshold (70); TB has none (must fall back to 80/default).
INSERT INTO public.tenant_settings (tenant_id, learning_settings) VALUES
 ('00000000-0000-0000-0000-0000000000a0','{"readinessThreshold":70}'::jsonb),
 ('00000000-0000-0000-0000-0000000000b0','{}'::jsonb);

UPDATE public.profiles SET role='user',       tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='L1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user',       tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='L2' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='user',       tenant_id='00000000-0000-0000-0000-0000000000a0', status='inactive', name='L3' WHERE id='00000000-0000-0000-0000-0000000000a3';
-- L4: active learner with NO readiness row and NO attempts, valid name.
UPDATE public.profiles SET role='user',       tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='L4' WHERE id='00000000-0000-0000-0000-0000000000a4';
UPDATE public.profiles SET role='orgAdmin',   tenant_id='00000000-0000-0000-0000-0000000000a0', status='active',   name='M'  WHERE id='00000000-0000-0000-0000-0000000000a9';
UPDATE public.profiles SET role='user',       tenant_id='00000000-0000-0000-0000-0000000000b0', status='active',   name='LB' WHERE id='00000000-0000-0000-0000-0000000000b1';
UPDATE public.profiles SET role='orgAdmin',   tenant_id='00000000-0000-0000-0000-0000000000b0', status='active',   name='MB' WHERE id='00000000-0000-0000-0000-0000000000b9';
UPDATE public.profiles SET role='ralli_admin',tenant_id='00000000-0000-0000-0000-0000000000b0', status='active',   name='RA' WHERE id='00000000-0000-0000-0000-0000000000c9';

-- ── Tags ─────────────────────────────────────────────────────────────────────
-- TA: A=Discovery, B=Pricing, C=Objection, D=Retention (all active); Mg=Legacy
-- merged INTO A. D has NO evidence at all (proves no-data active topic is shown).
INSERT INTO public.tenant_quiz_tags (id, tenant_id, label, status, merged_into) VALUES
 ('00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0','Discovery','active',   NULL),
 ('00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0','Pricing',  'active',   NULL),
 ('00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0','Objection','active',   NULL),
 ('00000000-0000-0000-0000-00000000a013','00000000-0000-0000-0000-0000000000a0','Legacy',   'archived','00000000-0000-0000-0000-00000000a010'),
 ('00000000-0000-0000-0000-00000000a014','00000000-0000-0000-0000-0000000000a0','Retention','active',   NULL),
 ('00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0','Onboarding','active',  NULL);

-- ── Quizzes (classified => tags_classified_at set; Q4 unclassified) ───────────
INSERT INTO public.tenant_quizzes (id, tenant_id, name, status, tags_classified_at) VALUES
 ('00000000-0000-0000-0000-00000000a020','00000000-0000-0000-0000-0000000000a0','Q1','active',now()),
 ('00000000-0000-0000-0000-00000000a021','00000000-0000-0000-0000-0000000000a0','Q2','active',now()),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-0000000000a0','Q3','active',now()),
 ('00000000-0000-0000-0000-00000000a023','00000000-0000-0000-0000-0000000000a0','Q4','active',NULL),
 ('00000000-0000-0000-0000-00000000b020','00000000-0000-0000-0000-0000000000b0','QB','active',now());

-- CURRENT mappings (RPC must IGNORE these for history). Q2 current map is A although
-- its attempt snapshots below are B — proves history is not rewritten.
INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id) VALUES
 ('00000000-0000-0000-0000-00000000a020','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a021','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a022','00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000b020','00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0');

-- ── Attempts (server_v2 unless noted legacy) ─────────────────────────────────
INSERT INTO public.quiz_attempts (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, grading_provenance, created_at) VALUES
 ('00000000-0000-0000-0000-00000000a030','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a020',60,false,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a031','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a020',80,true, 2,'server_v2','2026-01-02 10:00'),
 ('00000000-0000-0000-0000-00000000a032','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a021',40,false,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000a022',100,true,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a020',50,false,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a035','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a023',30,false,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a036','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-00000000a021',20,false,1,NULL,'2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a037','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-00000000a020',100,true,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000a038','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-00000000a020',100,true,1,'server_v2','2026-01-01 10:00'),
 ('00000000-0000-0000-0000-00000000b030','00000000-0000-0000-0000-0000000000b0','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-00000000b020',55,false,1,'server_v2','2026-01-01 10:00');

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

INSERT INTO public.quiz_attempt_tags (attempt_id, tag_id, tenant_id) VALUES
 ('00000000-0000-0000-0000-00000000a030','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a031','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a032','00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a033','00000000-0000-0000-0000-00000000a012','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-00000000a013','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a034','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a036','00000000-0000-0000-0000-00000000a011','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a037','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000a038','00000000-0000-0000-0000-00000000a010','00000000-0000-0000-0000-0000000000a0'),
 ('00000000-0000-0000-0000-00000000b030','00000000-0000-0000-0000-00000000b010','00000000-0000-0000-0000-0000000000b0');

-- ═════════════════════ MANAGER VIEW (call as M, TA, null tenant = own) ═══════
DO $$
DECLARE v jsonb; tA jsonb; tB jsonb; tC jsonb; tD jsonb; rs1 jsonb; rs2 jsonb; m jsonb; l4 jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();  -- p_tenant_id NULL -> own tenant

  -- All FOUR active tenant tags are rows (incl. no-evidence Retention).
  ASSERT jsonb_array_length(v->'topics') = 4, '1. all active tags as topics = 4: '||(v->'topics')::text;

  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  SELECT e INTO tB FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Pricing';
  SELECT e INTO tC FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Objection';
  SELECT e INTO tD FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Retention';

  -- Discovery: equal-weight mean of L1(90) and L2(50) = 70.
  ASSERT tA->>'tagId' = '00000000-0000-0000-0000-00000000a010', '2. A tagId stable';
  ASSERT (tA->>'avgScore')::int = 70 AND (tA->>'measuredLearners')::int = 2, '2. A avg70 measured2';
  ASSERT (tA->>'learnersNoData')::int = 1, '2. A noData=1 (3 active - 2 measured)';
  ASSERT (tA->>'repsBelow')::int = 1 AND (tA->>'repsAbove')::int = 1, '2. A below/above=1/1 (thr70)';
  SELECT rs INTO rs1 FROM jsonb_array_elements(tA->'repScores') rs WHERE rs->>'userId'='00000000-0000-0000-0000-0000000000a1';
  SELECT rs INTO rs2 FROM jsonb_array_elements(tA->'repScores') rs WHERE rs->>'userId'='00000000-0000-0000-0000-0000000000a2';
  ASSERT (rs1->>'score')::int = 90 AND (rs1->>'n')::int = 2, '3. L1/A=90 n=2 (attempt-time, Q2 is under B): '||rs1::text;
  ASSERT (rs2->>'score')::int = 50 AND (rs2->>'n')::int = 1, '4. L2/A=50 n=1 (merged Mg+A dedupe once): '||rs2::text;
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(tA->'repScores') rs
                     WHERE rs->>'userId' IN ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a9','00000000-0000-0000-0000-0000000000a4')),
         '5. inactive L3, governor M, no-data L4 excluded from A repScores';

  ASSERT (tB->>'avgScore')::int = 40 AND (tB->>'measuredLearners')::int = 1 AND (tB->>'learnersNoData')::int = 2,
         '6. B avg40 measured1 noData2 (Q2 attempt-time B, not current-map A)';
  ASSERT (tC->>'avgScore')::int = 100 AND (tC->>'measuredLearners')::int = 1, '7. C avg100 measured1 (multi-tag)';

  -- Retention: active tag with NO verified evidence -> null, not 0.
  ASSERT (tD->'avgScore') = 'null'::jsonb, '8. Retention avgScore = null (never 0): '||tD::text;
  ASSERT (tD->>'measuredLearners')::int = 0 AND (tD->>'learnersNoData')::int = 3
         AND (tD->>'repsBelow')::int = 0 AND (tD->>'repsAbove')::int = 0
         AND jsonb_array_length(tD->'repScores') = 0, '8. Retention no-data shape';

  -- Ordering: scored weakest-first (B,A,C) then no-data (Retention) last.
  ASSERT (v->'topics'->0->>'label')='Pricing' AND (v->'topics'->1->>'label')='Discovery'
     AND (v->'topics'->2->>'label')='Objection' AND (v->'topics'->3->>'label')='Retention',
         '9. sort: scored weakest-first, no-data last';

  -- Columns: ALL 3 active learners incl. no-data L4 with a truthful name.
  ASSERT jsonb_array_length(v->'learners') = 3, '10. learners=3 columns (incl no-data L4)';
  SELECT l INTO l4 FROM jsonb_array_elements(v->'learners') l WHERE l->>'userId'='00000000-0000-0000-0000-0000000000a4';
  ASSERT l4 IS NOT NULL AND l4->>'name' = 'L4', '10. L4 present with truthful name';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'learners') l
                     WHERE l->>'userId' IN ('00000000-0000-0000-0000-0000000000a3','00000000-0000-0000-0000-0000000000a9')),
         '10. L3/M not columns';

  m := v->'meta';
  ASSERT (m->>'tenantId') = '00000000-0000-0000-0000-0000000000a0', '11. meta tenantId = TA';
  ASSERT (m->>'totalActiveLearners')::int = 3 AND (m->>'measuredLearners')::int = 2, '11. meta 3 active / 2 measured';
  ASSERT (m->>'totalAttempts')::int = 7 AND (m->>'verifiedAttributed')::int = 5
     AND (m->>'legacyExcluded')::int = 1 AND (m->>'awaitingClassification')::int = 1, '11. coverage 7/5/1/1';
  ASSERT (m->>'threshold')::int = 70 AND m->>'thresholdSource' = 'tenant_settings', '11. threshold 70 tenant_settings';

  ASSERT v::text NOT LIKE '%question%' AND v::text NOT LIKE '%answer%' AND v::text NOT LIKE '%solution%',
         '12. no quiz content in output';
  RAISE NOTICE 'MANAGER view: PASS';
END $$;

-- ═════════════════════ LEARNER L1 parity + privacy ══════════════════════════
DO $$
DECLARE v jsonb; tA jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();
  -- Learner sees only self as a column; no peer identity anywhere.
  ASSERT jsonb_array_length(v->'learners') = 1
     AND (v->'learners'->0->>'userId') = '00000000-0000-0000-0000-0000000000a1'
     AND (v->'learners'->0->>'name') = 'L1', '13. learner sees only self identity';
  ASSERT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v->'topics') t, jsonb_array_elements(t->'repScores') rs
    WHERE rs->>'userId' <> '00000000-0000-0000-0000-0000000000a1'), '13. learner only own repScores';
  -- Only relevant topics (A,B,C from history); D (Retention) NOT exposed.
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'topics') t WHERE t->>'label'='Retention'),
         '13. learner does not see irrelevant Retention';
  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  ASSERT (tA->>'avgScore')::int = 90, '14. learner L1/A=90 matches manager cell (parity)';
  m := v->'meta';
  ASSERT (m->>'totalActiveLearners')::int = 1 AND (m->>'measuredLearners')::int = 1
     AND (m->>'totalAttempts')::int = 4 AND (m->>'verifiedAttributed')::int = 4
     AND (m->>'legacyExcluded')::int = 0 AND (m->>'awaitingClassification')::int = 0, '14. L1 coverage 4/4/0/0';
  RAISE NOTICE 'LEARNER L1 view: PASS';
END $$;

-- ═════════════════════ LEARNER L2 (relevant no-data topic + parity) ══════════
DO $$
DECLARE v jsonb; tA jsonb; tB jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();
  SELECT e INTO tA FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Discovery';
  SELECT e INTO tB FROM jsonb_array_elements(v->'topics') e WHERE e->>'label'='Pricing';
  ASSERT (tA->>'avgScore')::int = 50, '15. L2/A=50 (parity with manager)';
  -- Pricing is relevant via L2's immutable (legacy) history, but has NO verified
  -- evidence -> present as a no-data topic (null), never invented as 0.
  ASSERT tB IS NOT NULL AND (tB->'avgScore') = 'null'::jsonb AND (tB->>'measuredLearners')::int = 0,
         '15. L2 relevant Pricing shown as no-data (null)';
  m := v->'meta';
  ASSERT (m->>'totalAttempts')::int = 3 AND (m->>'verifiedAttributed')::int = 1
     AND (m->>'legacyExcluded')::int = 1 AND (m->>'awaitingClassification')::int = 1, '15. L2 coverage 3/1/1/1';
  RAISE NOTICE 'LEARNER L2 view: PASS';
END $$;

-- ═════════════════════ TB manager (isolation + DEFAULT threshold) ════════════
DO $$
DECLARE v jsonb; m jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000b9","role":"authenticated"}',true);
  v := public.get_knowledge_heatmap();
  ASSERT jsonb_array_length(v->'topics') = 1 AND (v->'topics'->0->>'label') = 'Onboarding', '16. TB sees only its topic';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'topics') t
                     WHERE t->>'label' IN ('Discovery','Pricing','Objection','Retention')), '16. no TA topic leak';
  ASSERT NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v->'learners') l
                     WHERE l->>'userId' LIKE '00000000-0000-0000-0000-0000000000a%'), '16. no TA learner leak';
  m := v->'meta';
  ASSERT (m->>'threshold')::int = 80 AND m->>'thresholdSource' = 'default', '17. TB threshold=80 default (no hidden fallback)';
  RAISE NOTICE 'TENANT ISOLATION + DEFAULT THRESHOLD: PASS';
END $$;

-- ═════════════════════ ralli-admin explicit tenant selection ═════════════════
DO $$
DECLARE vTA jsonb; vTB jsonb;
BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}',true);
  -- RA (whose own tenant is TB) may explicitly request TA.
  vTA := public.get_knowledge_heatmap('00000000-0000-0000-0000-0000000000a0');
  ASSERT (vTA->'meta'->>'tenantId') = '00000000-0000-0000-0000-0000000000a0', '18. ralli-admin explicit TA';
  ASSERT EXISTS (SELECT 1 FROM jsonb_array_elements(vTA->'topics') t WHERE t->>'label'='Discovery')
     AND jsonb_array_length(vTA->'learners') = 3, '18. ralli-admin sees TA matrix';
  -- And its own/other tenant TB.
  vTB := public.get_knowledge_heatmap('00000000-0000-0000-0000-0000000000b0');
  ASSERT (vTB->'meta'->>'tenantId') = '00000000-0000-0000-0000-0000000000b0'
     AND (vTB->'topics'->0->>'label') = 'Onboarding', '18. ralli-admin explicit TB';
  RAISE NOTICE 'RALLI-ADMIN EXPLICIT TENANT: PASS';
END $$;

-- ═════════════════════ Foreign / unknown tenant rejection ════════════════════
DO $$
DECLARE msg text := '';
BEGIN
  -- orgAdmin M (TA) cannot target TB.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a9","role":"authenticated"}',true);
  BEGIN PERFORM public.get_knowledge_heatmap('00000000-0000-0000-0000-0000000000b0'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not authorized%', '19. orgAdmin foreign tenant rejected: '||msg;

  -- learner L1 (TA) cannot target TB.
  msg := '';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}',true);
  BEGIN PERFORM public.get_knowledge_heatmap('00000000-0000-0000-0000-0000000000b0'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%not authorized%', '20. learner foreign tenant rejected: '||msg;

  -- ralli-admin unknown tenant rejected honestly.
  msg := '';
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}',true);
  BEGIN PERFORM public.get_knowledge_heatmap('00000000-0000-0000-0000-0000000000ff'); EXCEPTION WHEN others THEN msg := SQLERRM; END;
  ASSERT msg LIKE '%tenant not found%', '21. unknown tenant rejected: '||msg;
  RAISE NOTICE 'FOREIGN / UNKNOWN TENANT REJECTION: PASS';
END $$;

ROLLBACK;
\echo '062 ALL TESTS PASSED'
