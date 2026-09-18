-- Same-org reactivation history contract: a learner removed from an org and reinvited/reactivated into the
-- SAME org must regain visibility of their previously-passed quizzes (attempt-based, identity-scoped).
-- Proves list_my_completed_quiz_history returns the passed quiz BEFORE removal and AGAIN after same-org
-- reactivation — records are preserved by identity + tenant, never deleted or mis-attached. One rolled-back
-- transaction. Local only (091+092+093 applied). Expect "SAME-ORG REINVITE HISTORY: ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL readiness.allow_unguarded='1';   -- lets postgres fixtures set profile state past the 092 guard

CREATE FUNCTION pg_temp.ok(cond boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF NOT COALESCE(cond,false) THEN RAISE EXCEPTION 'SAME-ORG REINVITE HISTORY FAIL: %', label; END IF; END $$;
-- completed-quiz-history count as a given user (SECDEF RPC reads auth.uid() from the jwt claim)
CREATE FUNCTION pg_temp.hist(p_uid uuid) RETURNS int LANGUAGE plpgsql AS $$
DECLARE n int; BEGIN
  PERFORM set_config('request.jwt.claims', json_build_object('sub',p_uid)::text, true);
  SELECT jsonb_array_length(public.list_my_completed_quiz_history()) INTO n;
  PERFORM set_config('request.jwt.claims', NULL, true);
  RETURN n;
END $$;

-- fixtures: tenant T, orgAdmin A, learner U (active in T), a quiz in T, and a PASSED attempt by U.
INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-00000000e001','authenticated','authenticated','u@sor.test',now(),now()),
 ('00000000-0000-0000-0000-00000000e0ad','authenticated','authenticated','a@sor.test',now(),now());
INSERT INTO public.tenants(id,slug,name) VALUES ('00000000-0000-0000-0000-00000000e00a','sor','SOR');
INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES ('00000000-0000-0000-0000-00000000e00a','{}');
UPDATE public.profiles SET role='user',    tenant_id='00000000-0000-0000-0000-00000000e00a',status='active' WHERE id='00000000-0000-0000-0000-00000000e001';
UPDATE public.profiles SET role='orgAdmin',tenant_id='00000000-0000-0000-0000-00000000e00a',status='active' WHERE id='00000000-0000-0000-0000-00000000e0ad';
INSERT INTO public.tenant_quizzes(id,tenant_id,name,status,passing_score)
  VALUES ('00000000-0000-0000-0000-00000000e0f1','00000000-0000-0000-0000-00000000e00a','Objection Handling','active',70);
INSERT INTO public.quiz_attempts(id,tenant_id,user_id,quiz_id,score,passed,created_at)
  VALUES ('00000000-0000-0000-0000-00000000e0a1','00000000-0000-0000-0000-00000000e00a','00000000-0000-0000-0000-00000000e001','00000000-0000-0000-0000-00000000e0f1',90,true,now());

\set U '00000000-0000-0000-0000-00000000e001'
\set A '00000000-0000-0000-0000-00000000e0ad'
\set T '00000000-0000-0000-0000-00000000e00a'

-- BEFORE removal: the learner sees their passed quiz in Completed history.
SELECT pg_temp.ok(pg_temp.hist(:'U') = 1, 'B1: passed quiz visible before removal');

-- REMOVE from the org (as orgAdmin A), then REACTIVATE into the SAME org (same-org reinvite).
SELECT set_config('request.jwt.claims', json_build_object('sub',:'A')::text, true);
SELECT public.readiness_lifecycle_remove_member(:'U');
SELECT set_config('request.jwt.claims', NULL, true);
-- while removed (detached/inactive) the completed-history RPC returns [] (no active tenant) — expected.
SELECT pg_temp.ok(pg_temp.hist(:'U') = 0, 'R1: history hidden while removed (detached/inactive)');

SELECT set_config('request.jwt.claims', json_build_object('sub',:'A')::text, true);
SELECT public.readiness_lifecycle_reactivate_member(:'U', :'T', 'user');   -- SAME org
SELECT set_config('request.jwt.claims', NULL, true);

-- AFTER same-org reactivation: the passed quiz is visible AGAIN (preserved by identity + tenant).
SELECT pg_temp.ok((SELECT tenant_id FROM public.profiles WHERE id=:'U') = :'T', 'A0: back in the same org');
SELECT pg_temp.ok((SELECT status FROM public.profiles WHERE id=:'U') = 'active', 'A0b: active again');
SELECT pg_temp.ok(pg_temp.hist(:'U') = 1, 'A1: passed quiz visible again after same-org reinvite');
-- the attempt row was never deleted or re-attached (same id + user + tenant).
SELECT pg_temp.ok((SELECT count(*) FROM public.quiz_attempts WHERE user_id=:'U' AND tenant_id=:'T' AND passed) = 1,
                  'A2: original passed attempt intact (not deleted / not re-identified)');

SELECT 'SAME-ORG REINVITE HISTORY: ALL TESTS PASSED' AS result;
ROLLBACK;
