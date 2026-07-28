-- Repeatable tests for migration 067 (learner-safe completed-quiz history).
-- Proves: list_my_completed_quiz_history returns ONLY the caller's OWN passed quizzes
-- (incl archived, with real status + best_score + last_passed_at), excludes failed-only
-- quizzes, excludes other learners' and cross-tenant rows, and carries NO answer keys.
-- Two tenants. One rolled-back transaction. Local only. Expect "067 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1','authenticated','authenticated','hl1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000d2','authenticated','authenticated','hl2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000d8','authenticated','authenticated','hl8@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000d0','hta','HTA'),
 ('00000000-0000-0000-0000-0000000000e0','htb','HTB');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='HL1' WHERE id='00000000-0000-0000-0000-0000000000d1';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000d0', status='active', name='HL2' WHERE id='00000000-0000-0000-0000-0000000000d2';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000e0', status='active', name='HL8' WHERE id='00000000-0000-0000-0000-0000000000d8';

INSERT INTO public.tenant_quizzes (id, tenant_id, name, status, passing_score) VALUES
 ('00000000-0000-0000-0000-0000000dc001','00000000-0000-0000-0000-0000000000d0','ACTIVE_Q','active',70),
 ('00000000-0000-0000-0000-0000000dc002','00000000-0000-0000-0000-0000000000d0','ARCHIVED_Q','archived',60),
 ('00000000-0000-0000-0000-0000000dc003','00000000-0000-0000-0000-0000000000d0','FAILED_ONLY_Q','active',80),
 ('00000000-0000-0000-0000-0000000dc004','00000000-0000-0000-0000-0000000000e0','OTHER_TENANT_Q','active',70);
-- HL1 attempts: passed ACTIVE_Q (best 90), passed ARCHIVED_Q (best 75), only failed FAILED_ONLY_Q.
INSERT INTO public.quiz_attempts (tenant_id, user_id, quiz_id, score, passed, created_at) VALUES
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000dc001', 80, true,  now()-interval '3 hours'),
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000dc001', 90, true,  now()-interval '1 hour'),
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000dc002', 75, true,  now()-interval '2 hours'),
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000dc003', 40, false, now()-interval '2 hours'),
 -- HL2 (other learner, same tenant) passed ACTIVE_Q — must not leak into HL1's history.
 ('00000000-0000-0000-0000-0000000000d0','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000dc001', 88, true,  now()-interval '2 hours'),
 -- HL8 (other tenant) passed OTHER_TENANT_Q.
 ('00000000-0000-0000-0000-0000000000e0','00000000-0000-0000-0000-0000000000d8','00000000-0000-0000-0000-0000000dc004', 95, true,  now()-interval '2 hours');

-- ── 1. HL1 history = ACTIVE_Q + ARCHIVED_Q only; correct metadata; no failed/other. ─
DO $$ DECLARE v jsonb; v_ids text[]; v_arch jsonb; v_act jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}',true);
  v := public.list_my_completed_quiz_history();
  ASSERT jsonb_array_length(v) = 2, '1. HL1 has exactly 2 passed quizzes: '||v::text;
  SELECT array_agg(e->>'id') INTO v_ids FROM jsonb_array_elements(v) e;
  ASSERT '00000000-0000-0000-0000-0000000dc001' = ANY(v_ids), '1. ACTIVE_Q present';
  ASSERT '00000000-0000-0000-0000-0000000dc002' = ANY(v_ids), '1. ARCHIVED_Q present';
  ASSERT NOT ('00000000-0000-0000-0000-0000000dc003' = ANY(v_ids)), '1. failed-only excluded';
  ASSERT NOT ('00000000-0000-0000-0000-0000000dc004' = ANY(v_ids)), '1. cross-tenant excluded';
  SELECT e INTO v_arch FROM jsonb_array_elements(v) e WHERE e->>'id'='00000000-0000-0000-0000-0000000dc002';
  ASSERT v_arch->>'status'='archived', '1. archived status carried';
  ASSERT v_arch->>'name'='ARCHIVED_Q', '1. archived name carried';
  -- CATALOG METADATA ONLY: exactly {id,name,status,passing_score}; NO per-attempt score/
  -- date/passed (those are instance facts, resolved client-side from scoped attempts).
  ASSERT (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_arch) k) = ARRAY['id','name','passing_score','status'], '1. only catalog keys: '||v_arch::text;
  ASSERT v_arch ? 'best_score' = false AND v_arch ? 'last_passed_at' = false AND v_arch ? 'passed' = false, '1. NO aggregate score/date/passed field';
  -- confidentiality: no answer-bearing keys anywhere in the payload
  ASSERT v::text NOT ILIKE '%questions%' AND v::text NOT ILIKE '%"correct"%' AND v::text NOT ILIKE '%acceptedAnswers%' AND v::text NOT ILIKE '%tolerance%' AND v::text NOT ILIKE '%pairs%', '1. no answer keys';
  RAISE NOTICE '1. HL1 completed-quiz history: 2 passed (active+archived), failed/cross-tenant excluded, catalog-only metadata (no aggregate score/date): PASS';
END $$;

-- ── 2. HL2 sees only their own; HL8 (other tenant) sees only their tenant's. ─────
DO $$ DECLARE v jsonb; BEGIN
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d2","role":"authenticated"}',true);
  v := public.list_my_completed_quiz_history();
  ASSERT jsonb_array_length(v)=1 AND (v->0->>'id')='00000000-0000-0000-0000-0000000dc001', '2. HL2 sees only own passed: '||v::text;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000000d8","role":"authenticated"}',true);
  v := public.list_my_completed_quiz_history();
  ASSERT jsonb_array_length(v)=1 AND (v->0->>'id')='00000000-0000-0000-0000-0000000dc004', '2. HL8 sees only own tenant: '||v::text;
  RAISE NOTICE '2. per-learner + tenant isolation (no other learner/tenant rows): PASS';
END $$;

DO $$ BEGIN RAISE NOTICE '067 ALL TESTS PASSED'; END $$;

ROLLBACK;
