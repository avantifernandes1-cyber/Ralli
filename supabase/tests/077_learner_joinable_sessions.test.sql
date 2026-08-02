-- Real-JWT test for migration 077 (learner-safe joinable-session list).
-- SELF-CONTAINED: creates the 077 function inside a transaction, seeds ephemeral
-- identities/sessions, exercises rpc_learner_joinable_sessions under real
-- request.jwt.claims, asserts the learner contract, then ROLLS BACK — no residual
-- function/data. Runs against a DB with the base schema present. Expect
-- "077 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_learner_joinable_sessions()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid;
BEGIN
  IF auth.uid() IS NULL THEN RETURN '[]'::jsonb; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles WHERE id = auth.uid();
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', s.id, 'pin', s.pin, 'name', s.name, 'quiz_id', s.quiz_id,
      'question_count', s.question_count, 'status', s.status,
      'player_count', s.player_count, 'demo_mode', s.demo_mode)
      ORDER BY s.created_at DESC)
    FROM public.game_sessions s
    WHERE s.tenant_id = v_tenant::text AND s.status = 'waiting' AND COALESCE(s.demo_mode,false) = false), '[]'::jsonb);
END; $$;

INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000770a0','r77_ta','R77 A'),('00000000-0000-0000-0000-0000000770b0','r77_tb','R77 B');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000077001','authenticated','authenticated','r77learn@t.test',now(),now()),  -- learner (tA)
 ('00000000-0000-0000-0000-000000077002','authenticated','authenticated','r77learnB@t.test',now(),now());  -- learner (tB)
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000770a0', status='active' WHERE id='00000000-0000-0000-0000-000000077001';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000770b0', status='active' WHERE id='00000000-0000-0000-0000-000000077002';
-- tA: one WAITING joinable (W), one STARTED (ST), one COMPLETED (CP), one CANCELED (CN), one DEMO waiting (DM). tB: one WAITING (WB).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, question_snapshot, live_question) VALUES
 ('00000000-0000-0000-0000-0000000770f1','00000000-0000-0000-0000-0000000770a0','q','h','770001','W','waiting',   1,false,'[{"id":"q","correct":1}]'::jsonb, '{"qIdx":0}'::jsonb),
 ('00000000-0000-0000-0000-0000000770f2','00000000-0000-0000-0000-0000000770a0','q','h','770002','ST','started',  1,false,'[{"id":"q","correct":1}]'::jsonb, NULL),
 ('00000000-0000-0000-0000-0000000770f3','00000000-0000-0000-0000-0000000770a0','q','h','770003','CP','completed',1,false,'[{"id":"q","correct":1}]'::jsonb, NULL),
 ('00000000-0000-0000-0000-0000000770f4','00000000-0000-0000-0000-0000000770a0','q','h','770004','CN','canceled', 1,false,'[{"id":"q","correct":1}]'::jsonb, NULL),
 ('00000000-0000-0000-0000-0000000770f5','00000000-0000-0000-0000-0000000770a0','q','h','770005','DM','waiting',  1,true, '[{"id":"q","correct":1}]'::jsonb, NULL),
 ('00000000-0000-0000-0000-0000000770f6','00000000-0000-0000-0000-0000000770b0','q','h','770006','WB','waiting',  1,false,'[{"id":"q","correct":1}]'::jsonb, NULL);

DO $$
DECLARE v jsonb; ids text[];
BEGIN
  -- learner (tA) sees ONLY the tA waiting non-demo session W.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000077001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_learner_joinable_sessions();
  SELECT array_agg(e->>'id') INTO ids FROM jsonb_array_elements(v) e;
  IF NOT (ids @> ARRAY['00000000-0000-0000-0000-0000000770f1']) THEN RAISE EXCEPTION 'T1 learner missing waiting W'; END IF;
  IF ids && ARRAY['00000000-0000-0000-0000-0000000770f2','00000000-0000-0000-0000-0000000770f3','00000000-0000-0000-0000-0000000770f4'] THEN RAISE EXCEPTION 'T1 learner saw started/completed/canceled'; END IF;
  IF ids && ARRAY['00000000-0000-0000-0000-0000000770f5'] THEN RAISE EXCEPTION 'T1 learner saw demo session'; END IF;
  IF ids && ARRAY['00000000-0000-0000-0000-0000000770f6'] THEN RAISE EXCEPTION 'T1 learner saw cross-tenant WB'; END IF;
  -- confidentiality: no snapshot / live_question / answers keys in any row.
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v) e WHERE e ? 'question_snapshot' OR e ? 'live_question' OR e ? 'answers' OR e ? 'correct') THEN RAISE EXCEPTION 'T1 learner row leaked snapshot/live/answers'; END IF;
  RESET ROLE;
  RAISE NOTICE '1. learner sees same-tenant waiting only; no cross-tenant / started / completed / canceled / demo; no confidential fields: PASS';

  -- learner (tB) sees ONLY WB, never tA sessions.
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-000000077002","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT array_agg(e->>'id') INTO ids FROM jsonb_array_elements(public.rpc_learner_joinable_sessions()) e;
  IF NOT (ids @> ARRAY['00000000-0000-0000-0000-0000000770f6']) THEN RAISE EXCEPTION 'T2 tB learner missing WB'; END IF;
  IF ids && ARRAY['00000000-0000-0000-0000-0000000770f1'] THEN RAISE EXCEPTION 'T2 tB learner saw tA session'; END IF;
  RESET ROLE;
  RAISE NOTICE '2. tenant isolation (tB learner sees only tB): PASS';

  -- anon → [] (no rows, no error).
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  IF public.rpc_learner_joinable_sessions() <> '[]'::jsonb THEN RAISE EXCEPTION 'T3 anon not empty'; END IF;
  RESET ROLE;
  RAISE NOTICE '3. anon receives []: PASS';

  RAISE NOTICE '077 ALL TESTS PASSED';
END $$;

ROLLBACK;
