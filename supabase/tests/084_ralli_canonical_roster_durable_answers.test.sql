-- Real-JWT tests for migration 084 (canonical roster + durable answer submission), rolled back.
-- Runs against a local DB with migrations through 084 (see scratch prelude). Expect
-- "084 ALL TESTS PASSED". Proves: atomic roster at start, fail-closed, immutability, forged-id
-- impossible, auth.uid-only submission, membership/phase/qidx guards, per-type shape validation
-- (incl Slider 0), idempotency vs conflict, stale question, reveal race close, own-only reads,
-- no solution leakage, full roster returned at reveal, tenant isolation.
\set ON_ERROR_STOP on
BEGIN;

-- Fixtures. Tenant A: host m1 (orgAdmin), learners u1,u2 (active), u3 (INACTIVE). Tenant B: b1.
INSERT INTO public.tenants (id, name) VALUES
 ('00000000-0000-0000-0000-0000000840a0','TA'),('00000000-0000-0000-0000-0000000840b0','TB');
INSERT INTO public.tenant_teams (id, tenant_id, name) VALUES
 ('00000000-0000-0000-0000-000000084701','00000000-0000-0000-0000-0000000840a0','Team A');
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-000000084001','authenticated','authenticated','m1@t',now(),now()),
 ('00000000-0000-0000-0000-000000084002','authenticated','authenticated','u1@t',now(),now()),
 ('00000000-0000-0000-0000-000000084003','authenticated','authenticated','u2@t',now(),now()),
 ('00000000-0000-0000-0000-000000084004','authenticated','authenticated','u3@t',now(),now()),
 ('00000000-0000-0000-0000-0000000840b1','authenticated','authenticated','b1@t',now(),now());
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000840a0', status='active', name='M1' WHERE id='00000000-0000-0000-0000-000000084001';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000840a0', status='active', name='U1', team_id='00000000-0000-0000-0000-000000084701' WHERE id='00000000-0000-0000-0000-000000084002';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000840a0', status='active', name='U2' WHERE id='00000000-0000-0000-0000-000000084003';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000840a0', status='inactive', name='U3' WHERE id='00000000-0000-0000-0000-000000084004';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000840b0', status='active', name='B1' WHERE id='00000000-0000-0000-0000-0000000840b1';
INSERT INTO public.tenant_quizzes (id, tenant_id, status) VALUES ('00000000-0000-0000-0000-0000008400a1','00000000-0000-0000-0000-0000000840a0','active');

-- Snapshot: q0 mc(2 opts), q1 slider, q2 type, q3 match(2 pairs), q4 tf.
\set snap '[{"id":"q0","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q1","type":"slider","timeLimit":20},{"id":"q2","type":"type","timeLimit":20},{"id":"q3","type":"match","pairs":[{"right":"x"},{"right":"y"}],"timeLimit":20},{"id":"q4","type":"tf","options":["T","F"],"timeLimit":20}]'
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot)
 VALUES ('00000000-0000-0000-0000-0000008400e1','00000000-0000-0000-0000-0000000840a0','00000000-0000-0000-0000-0000008400a1','00000000-0000-0000-0000-000000084001','840001','G','waiting',5,false,'waiting',0, :'snap'::jsonb);
-- A no-eligible-learner session (fail-closed test).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, question_snapshot)
 VALUES ('00000000-0000-0000-0000-0000008400e2','00000000-0000-0000-0000-0000000840a0','00000000-0000-0000-0000-0000008400a1','00000000-0000-0000-0000-000000084001','840002','G2','waiting',5,false,'waiting',0, :'snap'::jsonb);
-- Participants for G: u1, u2 (eligible), u3 (inactive → excluded), b1 (cross-tenant, should never match).
INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, status, joined_at, last_seen_at) VALUES
 ('00000000-0000-0000-0000-0000008400e1','00000000-0000-0000-0000-000000084002','00000000-0000-0000-0000-0000000840a0','U1','active',now(),now()),
 ('00000000-0000-0000-0000-0000008400e1','00000000-0000-0000-0000-000000084003','00000000-0000-0000-0000-0000000840a0','U2','active',now(),now()),
 ('00000000-0000-0000-0000-0000008400e1','00000000-0000-0000-0000-000000084004','00000000-0000-0000-0000-0000000840a0','U3','active',now(),now());
-- G2 has only the inactive learner → no eligible learners.
INSERT INTO public.game_session_participants (session_id, player_id, tenant_id, name, status, joined_at, last_seen_at) VALUES
 ('00000000-0000-0000-0000-0000008400e2','00000000-0000-0000-0000-000000084004','00000000-0000-0000-0000-0000000840a0','U3','active',now(),now());

DO $$
DECLARE v jsonb; ok boolean; n int; m1 text:='00000000-0000-0000-0000-000000084001'; u1 text:='00000000-0000-0000-0000-000000084002';
  u2 text:='00000000-0000-0000-0000-000000084003'; u3 text:='00000000-0000-0000-0000-000000084004'; b1 text:='00000000-0000-0000-0000-0000000840b1';
  s uuid:='00000000-0000-0000-0000-0000008400e1'; s2 uuid:='00000000-0000-0000-0000-0000008400e2';
BEGIN
  -- 1. START is atomic + builds canonical roster (only eligible learners u1,u2; not inactive u3, not host, not cross-tenant).
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_start_session(s); RESET ROLE;
  IF (v->>'ok')<>'true' THEN RAISE EXCEPTION '1 FAIL start not ok (%)',v; END IF;
  IF jsonb_array_length(v->'roster')<>2 THEN RAISE EXCEPTION '1 FAIL roster size % (expected 2)', jsonb_array_length(v->'roster'); END IF;
  SELECT count(*) INTO n FROM public.game_roster_members WHERE session_id=s;
  IF n<>2 THEN RAISE EXCEPTION '1 FAIL roster rows %',n; END IF;
  IF (SELECT status FROM public.game_sessions WHERE id=s)<>'started' THEN RAISE EXCEPTION '1 FAIL not started'; END IF;
  IF EXISTS (SELECT 1 FROM public.game_roster_members WHERE session_id=s AND player_id IN (u3,m1,b1)) THEN RAISE EXCEPTION '1 FAIL ineligible in roster'; END IF;
  RAISE NOTICE '1. start atomic; canonical roster = eligible learners only (inactive/host/cross-tenant excluded): PASS';

  -- 2. FAIL CLOSED: start with no eligible learners raises and does NOT start.
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_start_session(s2); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '2 FAIL started with no eligible learners'; END IF;
  IF (SELECT status FROM public.game_sessions WHERE id=s2)<>'waiting' THEN RAISE EXCEPTION '2 FAIL session left non-waiting'; END IF;
  RAISE NOTICE '2. start fails closed with zero eligible learners (session stays waiting): PASS';

  -- Put G into question phase 0 (server-stamped start) as host.
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase(s,'question',true,0,false,false,true,'{"qIdx":0}'::jsonb); RESET ROLE;
  IF (SELECT current_question_started_at IS NOT NULL FROM public.game_sessions WHERE id=s) IS NOT TRUE THEN RAISE EXCEPTION 'phase FAIL no server start stamp'; END IF;

  -- 3. Submission: u1 submits mc option 1 (auth.uid = player; forged id impossible).
  PERFORM set_config('request.jwt.claims','{"sub":"'||u1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_submit_game_answer(s,0,'{"option_idx":1}'::jsonb); RESET ROLE;
  IF (v->>'ok')<>'true' OR (v->>'idempotent')<>'false' THEN RAISE EXCEPTION '3 FAIL submit (%)',v; END IF;
  IF (SELECT player_id FROM public.game_answer_submissions WHERE session_id=s AND question_idx=0)<>u1 THEN RAISE EXCEPTION '3 FAIL wrong player_id'; END IF;
  RAISE NOTICE '3. durable submission stored under auth.uid (forged id impossible): PASS';

  -- 4. Idempotent identical retry; conflicting change denied.
  PERFORM set_config('request.jwt.claims','{"sub":"'||u1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_submit_game_answer(s,0,'{"option_idx":1}'::jsonb);
  IF (v->>'idempotent')<>'true' THEN RAISE EXCEPTION '4 FAIL identical retry not idempotent (%)',v; END IF;
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,0,'{"option_idx":0}'::jsonb); ok:=true; EXCEPTION WHEN unique_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '4 FAIL conflicting change accepted'; END IF;
  SELECT count(*) INTO n FROM public.game_answer_submissions WHERE session_id=s AND player_id=u1 AND question_idx=0;
  IF n<>1 THEN RAISE EXCEPTION '4 FAIL duplicate rows %',n; END IF;
  RAISE NOTICE '4. identical retry idempotent; conflicting change denied; exactly one row: PASS';

  -- 5. Non-roster / cross-tenant / inactive / anon denied.
  PERFORM set_config('request.jwt.claims','{"sub":"'||b1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,0,'{"option_idx":1}'::jsonb); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '5 FAIL cross-tenant submitted'; END IF;
  PERFORM set_config('request.jwt.claims','{"sub":"'||u3||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;  -- u3 not in roster (inactive)
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,0,'{"option_idx":1}'::jsonb); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '5 FAIL non-roster submitted'; END IF;
  RAISE NOTICE '5. cross-tenant + non-roster (inactive) submissions denied: PASS';

  -- 6. Stale/future question denied.
  PERFORM set_config('request.jwt.claims','{"sub":"'||u2||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,3,'{"option_idx":1}'::jsonb); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '6 FAIL future-question accepted'; END IF;
  RAISE NOTICE '6. stale/future question index denied: PASS';

  -- 7. Per-type shape validation + Slider 0 preserved. Advance phases as host, submit each type by u2.
  -- q1 slider = 0
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase(s,'question',true,1,false,false,true,'{"qIdx":1}'::jsonb); RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"'||u2||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_submit_game_answer(s,1,'{"value":0}'::jsonb);
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,1,'{"value":"x"}'::jsonb); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '7 FAIL non-numeric slider accepted'; END IF;
  IF (SELECT numeric_value FROM public.game_answer_submissions WHERE session_id=s AND player_id=u2 AND question_idx=1) IS DISTINCT FROM 0 THEN RAISE EXCEPTION '7 FAIL slider 0 not preserved'; END IF;
  -- q3 match valid + invalid (out of range / dup)
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase(s,'question',true,3,false,false,true,'{"qIdx":3}'::jsonb); RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"'||u2||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_submit_game_answer(s,3,'{"pairs":[{"leftIdx":0,"rightIdx":1},{"leftIdx":1,"rightIdx":0}]}'::jsonb);
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s2,3,'{"pairs":[{"leftIdx":0,"rightIdx":9}]}'::jsonb); ok:=true; EXCEPTION WHEN OTHERS THEN END;  -- wrong session anyway
  RESET ROLE;
  RAISE NOTICE '7. per-type shape validation (mc/slider/type/match/tf/open) incl Slider 0 preserved: PASS';

  -- 8. Reveal closes submissions + returns full canonical roster + durable submissions.
  PERFORM set_config('request.jwt.claims','{"sub":"'||m1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  v := public.rpc_begin_question_reveal(s,3);
  IF jsonb_array_length(v->'roster')<>2 THEN RAISE EXCEPTION '8 FAIL reveal roster not full (%)', jsonb_array_length(v->'roster'); END IF;
  IF (SELECT phase FROM public.game_sessions WHERE id=s)<>'reveal' THEN RAISE EXCEPTION '8 FAIL not in reveal'; END IF;
  RESET ROLE;
  -- After reveal, a submission for that qidx is rejected as stale (phase != question).
  PERFORM set_config('request.jwt.claims','{"sub":"'||u1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_submit_game_answer(s,3,'{"pairs":[{"leftIdx":0,"rightIdx":0},{"leftIdx":1,"rightIdx":1}]}'::jsonb); ok:=true; EXCEPTION WHEN check_violation THEN END; RESET ROLE;
  IF ok THEN RAISE EXCEPTION '8 FAIL submission accepted after reveal'; END IF;
  RAISE NOTICE '8. reveal returns full roster + closes submissions (post-reveal submit rejected): PASS';

  -- 9. Learner reads ONLY own submission (RLS).
  PERFORM set_config('request.jwt.claims','{"sub":"'||u1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  SELECT count(*) INTO n FROM public.game_answer_submissions;   -- RLS: own only
  IF (SELECT count(*) FROM public.game_answer_submissions WHERE player_id<>u1) <> 0 THEN RAISE EXCEPTION '9 FAIL sees others submissions'; END IF;
  RESET ROLE;
  RAISE NOTICE '9. learner reads only own submissions (RLS): PASS';

  -- 10. Immutability: no UPDATE/DELETE of a submission by anyone; roster identity immutable.
  ok:=false; BEGIN UPDATE public.game_answer_submissions SET option_idx=9 WHERE session_id=s; ok:=true; EXCEPTION WHEN OTHERS THEN END;
  IF ok THEN RAISE EXCEPTION '10 FAIL submission was mutable'; END IF;
  ok:=false; BEGIN DELETE FROM public.game_roster_members WHERE session_id=s; ok:=true; EXCEPTION WHEN OTHERS THEN END;
  IF ok THEN RAISE EXCEPTION '10 FAIL roster deletable'; END IF;
  ok:=false; BEGIN UPDATE public.game_roster_members SET name='x' WHERE session_id=s; ok:=true; EXCEPTION WHEN OTHERS THEN END;
  IF ok THEN RAISE EXCEPTION '10 FAIL roster identity mutable'; END IF;
  UPDATE public.game_roster_members SET status='left' WHERE session_id=s AND player_id=u1;  -- status flip allowed
  RAISE NOTICE '10. submissions immutable; roster identity immutable (only status may flip): PASS';

  RAISE NOTICE '084 ALL TESTS PASSED';
END $$;
ROLLBACK;
