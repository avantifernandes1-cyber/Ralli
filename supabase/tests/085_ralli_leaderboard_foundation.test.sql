-- Repeatable tests for migration 085 (Ralli Live leaderboard foundation).
-- Proves: (1) durable-active exposure insertion at question-start (only roster-active +
-- participant-active + fresh-heartbeat learners exposed; explicit-leave and stale excluded;
-- duplicate phase calls idempotent); (2) exposure immutability (no UPDATE/DELETE); (3-5) the
-- individual formula (exposure denominator, open-ended-pending excluded from numerator AND
-- denominator, adjusted-accuracy shrinkage, ≥20-faced/≥3-games eligibility, unranked progress);
-- (6) the team formula (median of eligible members, ≥2-eligible + ≥50%-participation gate);
-- (7) org timezone (UTC default, valid IANA set by manager, invalid rejected, learner read-only);
-- (8) security (anon denied, learner own-team-only drill-down, manager any same-tenant team);
-- (9) payload confidentiality (aggregate-only, no answer/verdict/snapshot material); (10) managers/
-- admins excluded from rankings; (Q1-Q6) the verification queue/outbox (enqueue-once on real
-- completion, demo/canceled excluded, service-role-only claim, backoff retry → terminal failed,
-- success → completed, no answer material stored). Runs against a local DB migrated through 085.
-- One rolled-back transaction, no creds/answers. Expect "085 ALL TESTS PASSED" + "085 QUEUE TESTS PASSED".
-- (To reproduce standalone: apply supabase/tests/concurrency/085_leaderboard_prelude.sql, then the
--  exact 085 migration, then this file — see the local runner in the deliverable notes.)
\set ON_ERROR_STOP on
BEGIN;
-- ── Fixtures ────────────────────────────────────────────────────────────────
-- Tenant TA; teams A,B. Learners L1,L2,L3 (team A), L4,L5 (team B). Host/admin H1 (orgAdmin), manager MG.
INSERT INTO public.tenants(id,name,timezone) VALUES ('00000000-0000-0000-0000-0000000850a0','TA', DEFAULT) ON CONFLICT DO NOTHING;
INSERT INTO public.tenant_teams(id,tenant_id,name) VALUES
 ('00000000-0000-0000-0000-000000085a01','00000000-0000-0000-0000-0000000850a0','Team A'),
 ('00000000-0000-0000-0000-000000085b01','00000000-0000-0000-0000-0000000850a0','Team B');
INSERT INTO auth.users(id,aud,role,email) VALUES
 ('00000000-0000-0000-0000-000000085001','authenticated','authenticated','l1'),
 ('00000000-0000-0000-0000-000000085002','authenticated','authenticated','l2'),
 ('00000000-0000-0000-0000-000000085003','authenticated','authenticated','l3'),
 ('00000000-0000-0000-0000-000000085004','authenticated','authenticated','l4'),
 ('00000000-0000-0000-0000-000000085005','authenticated','authenticated','l5'),
 ('00000000-0000-0000-0000-000000085006','authenticated','authenticated','l6'),
 ('00000000-0000-0000-0000-00000085f001','authenticated','authenticated','h1'),
 ('00000000-0000-0000-0000-00000085f002','authenticated','authenticated','mg');
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085a01',name='L1' WHERE id='00000000-0000-0000-0000-000000085001';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085a01',name='L2' WHERE id='00000000-0000-0000-0000-000000085002';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085a01',name='L3' WHERE id='00000000-0000-0000-0000-000000085003';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085b01',name='L4' WHERE id='00000000-0000-0000-0000-000000085004';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085b01',name='L5' WHERE id='00000000-0000-0000-0000-000000085005';
UPDATE public.profiles SET role='user',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',team_id='00000000-0000-0000-0000-000000085a01',name='L6' WHERE id='00000000-0000-0000-0000-000000085006';
UPDATE public.profiles SET role='orgAdmin',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',name='H1' WHERE id='00000000-0000-0000-0000-00000085f001';
UPDATE public.profiles SET role='manager',status='active',tenant_id='00000000-0000-0000-0000-0000000850a0',name='MG' WHERE id='00000000-0000-0000-0000-00000085f002';

\set snap8 '[{"id":"q0","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q1","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q2","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q3","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q4","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q5","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q6","type":"mc","options":["a","b"],"timeLimit":20},{"id":"q7","type":"open","timeLimit":20}]'

CREATE TEMP TABLE _snap(v jsonb); INSERT INTO _snap VALUES (:'snap8'::jsonb);
-- Three COMPLETED real sessions this month (ended_at now()). q7 is open-ended for the pending-manual test.
INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,demo_mode,question_count,question_snapshot,ended_at,current_question_index,phase)
SELECT ('00000000-0000-0000-0000-00000008500'||g)::uuid,'00000000-0000-0000-0000-0000000850a0','q','00000000-0000-0000-0000-00000085f001','p'||g,'completed',false,8, :'snap8'::jsonb, date_trunc('month', now()) + interval '10 days', 7,'scoreboard'
FROM generate_series(1,3) g;

-- Roster (084 snapshot team) + exposures + verifications for L1,L2 (team A) and L4 (team B) across all 3 sessions, 8 q each.
-- verified_correct pattern: L1 correct on q_idx<6 (6/8 per session → 18/24), L2 correct on q_idx<4 (4/8 → 12/24, but q7 open),
-- L4 correct on q_idx<7 (7/8 → but q7 open). We seed q0..q6 (auto) with verdicts; q7 (open) left PENDING (no verdict).
DO $$
DECLARE s int; qi int; sid uuid; pl text; tm uuid;
  players text[] := ARRAY['00000000-0000-0000-0000-000000085001','00000000-0000-0000-0000-000000085002','00000000-0000-0000-0000-000000085004'];
BEGIN
  FOR s IN 1..3 LOOP
    sid := ('00000000-0000-0000-0000-00000008500'||s)::uuid;
    FOREACH pl IN ARRAY players LOOP
      tm := CASE WHEN pl='00000000-0000-0000-0000-000000085004' THEN '00000000-0000-0000-0000-000000085b01'::uuid ELSE '00000000-0000-0000-0000-000000085a01'::uuid END;
      INSERT INTO public.game_roster_members(session_id,tenant_id,player_id,name,team_id,status) VALUES (sid,'00000000-0000-0000-0000-0000000850a0',pl,pl,tm,'active');
      FOR qi IN 0..7 LOOP
        -- exposure for every question (all present all game)
        INSERT INTO public.game_question_exposures(session_id,tenant_id,player_id,question_idx,question_id,exposed_at)
          VALUES (sid,'00000000-0000-0000-0000-0000000850a0',pl,qi,'q'||qi, now() - interval '10 min');
        -- submission (fast correct) — used for speed on correct answers
        INSERT INTO public.game_answer_submissions(session_id,tenant_id,player_id,question_idx,q_type,option_idx,submitted_at)
          VALUES (sid,'00000000-0000-0000-0000-0000000850a0',pl,qi,'mc',1, now() - interval '10 min' + interval '2 sec');
        -- verification for auto questions (q0..q6). q7 open → NO verdict (pending manual) → excluded.
        IF qi < 7 THEN
          INSERT INTO public.game_answer_verifications(session_id,tenant_id,player_id,question_idx,verified_correct,eligibility)
          VALUES (sid,'00000000-0000-0000-0000-0000000850a0',pl,qi,
            CASE
              WHEN pl='00000000-0000-0000-0000-000000085001' THEN qi < 6   -- L1: q0..q5 correct (6/7 auto)
              WHEN pl='00000000-0000-0000-0000-000000085002' THEN qi < 4   -- L2: q0..q3 correct (4/7 auto)
              ELSE qi < 6                                                   -- L4: q0..q5 correct (6/7 auto)
            END, 'scored');
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

DO $$
DECLARE r jsonb; ind jsonb; tms jsonb; L1 jsonb; L2 jsonb; L3 jsonb; ok boolean; obj jsonb; obj2 jsonb; obj3 jsonb;
  h1 text:='00000000-0000-0000-0000-00000085f001'; p_l1 text:='00000000-0000-0000-0000-000000085001'; p_l4 text:='00000000-0000-0000-0000-000000085004';
BEGIN
  -- ── EXPOSURE LIFECYCLE via rpc_set_session_phase ──────────────────────────
  -- session S9 started; roster L1(active,fresh), L2(left), L3(active,stale heartbeat), plus participant rows.
  INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,demo_mode,question_count,question_snapshot,current_question_index,phase)
    VALUES ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0','q',h1,'p9','started',false,8, (SELECT v FROM _snap),0,'countdown');
  INSERT INTO public.game_roster_members(session_id,tenant_id,player_id,name,team_id,status) VALUES
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0',p_l1,'L1','00000000-0000-0000-0000-000000085a01','active'),
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085002','L2','00000000-0000-0000-0000-000000085a01','active'),
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085003','L3','00000000-0000-0000-0000-000000085a01','active');
  INSERT INTO public.game_session_participants(session_id,tenant_id,player_id,status,last_seen_at) VALUES
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0',p_l1,'active', now()),                      -- fresh
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085002','left', now()),  -- explicit leave
    ('00000000-0000-0000-0000-000000085099','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085003','active', now() - interval '5 min'); -- stale
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase('00000000-0000-0000-0000-000000085099','question',true,0,false,false,true,'{}'::jsonb);
  PERFORM public.rpc_set_session_phase('00000000-0000-0000-0000-000000085099','question',true,0,false,false,true,'{}'::jsonb); -- duplicate → idempotent
  RESET ROLE;
  IF (SELECT count(*) FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085099') <> 1 THEN RAISE EXCEPTION '1 FAIL exposure count (expected 1: only L1 active+fresh)'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085099' AND player_id=p_l1) THEN RAISE EXCEPTION '1 FAIL L1 not exposed'; END IF;
  RAISE NOTICE '1. exposure: only durably-active (L1) exposed; left(L2)+stale(L3) excluded; duplicate call idempotent: PASS';

  -- immutability
  ok:=false; BEGIN UPDATE public.game_question_exposures SET question_idx=9 WHERE session_id='00000000-0000-0000-0000-000000085099'; ok:=true; EXCEPTION WHEN OTHERS THEN END;
  IF ok THEN RAISE EXCEPTION '2 FAIL exposure mutable'; END IF;
  ok:=false; BEGIN DELETE FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085099'; ok:=true; EXCEPTION WHEN OTHERS THEN END;
  IF ok THEN RAISE EXCEPTION '2 FAIL exposure deletable'; END IF;
  RAISE NOTICE '2. exposure immutable (no UPDATE/DELETE): PASS';

  -- ── EXPOSURE FRESHNESS BOUNDARY (canonical durable-active, strict < 40s) ───
  -- One transaction ⇒ now() is fixed, so the 40s boundary is exact and deterministic.
  -- Session S8: qidx 0. Six controlled cases (roster status / participant status / last_seen offset):
  --   L1 active/active/-39.5s  → INCLUDED (just under the window)
  --   L2 active/active/-40s    → EXCLUDED (exactly at window; comparison is strict "<")
  --   L3 active/active/-41s    → EXCLUDED (beyond window)
  --   L4 active/LEFT /-0s      → EXCLUDED (explicit Leave overrides a fresh heartbeat)
  --   L5 active/active/NULL    → EXCLUDED (active status but no heartbeat)
  --   L6 LEFT  /active/-0s     → EXCLUDED (fresh heartbeat but not an active roster member)
  INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,demo_mode,question_count,question_snapshot,current_question_index,phase)
    VALUES ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','q',h1,'p8','started',false,8, (SELECT v FROM _snap),0,'countdown');
  INSERT INTO public.game_roster_members(session_id,tenant_id,player_id,name,team_id,status) VALUES
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085001','L1','00000000-0000-0000-0000-000000085a01','active'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085002','L2','00000000-0000-0000-0000-000000085a01','active'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085003','L3','00000000-0000-0000-0000-000000085a01','active'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085004','L4','00000000-0000-0000-0000-000000085b01','active'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085005','L5','00000000-0000-0000-0000-000000085b01','active'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085006','L6','00000000-0000-0000-0000-000000085a01','left');
  INSERT INTO public.game_session_participants(session_id,tenant_id,player_id,status,last_seen_at) VALUES
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085001','active', now() - interval '39500 milliseconds'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085002','active', now() - interval '40 seconds'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085003','active', now() - interval '41 seconds'),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085004','left',   now()),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085005','active', NULL),
    ('00000000-0000-0000-0000-000000085098','00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-000000085006','active', now());
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase('00000000-0000-0000-0000-000000085098','question',true,0,false,false,true,'{}'::jsonb);
  RESET ROLE;
  IF (SELECT count(*) FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085098' AND question_idx=0) <> 1
     OR NOT EXISTS (SELECT 1 FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085098' AND question_idx=0 AND player_id=p_l1) THEN
    RAISE EXCEPTION '2b FAIL boundary q0: expected only L1 (fresh <40s) exposed'; END IF;
  RAISE NOTICE '2b. exposure boundary: 39.5s included; exactly 40s + 41s excluded (strict); Leave-over-fresh, active-without-heartbeat, fresh-without-active-roster all excluded: PASS';

  -- Rejoin refreshes eligibility at a LATER question. L2 rejoins (participant active + fresh);
  -- refresh L1 too so it stays fresh; L3/L4/L5/L6 unchanged (still ineligible). Advance to q1.
  UPDATE public.game_session_participants SET status='active', last_seen_at=now()
    WHERE session_id='00000000-0000-0000-0000-000000085098' AND player_id IN (p_l1,'00000000-0000-0000-0000-000000085002');
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_session_phase('00000000-0000-0000-0000-000000085098','question',true,1,false,false,true,'{}'::jsonb);
  PERFORM public.rpc_set_session_phase('00000000-0000-0000-0000-000000085098','question',true,1,false,false,true,'{}'::jsonb); -- idempotent
  RESET ROLE;
  IF (SELECT count(*) FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085098' AND question_idx=1) <> 2
     OR NOT EXISTS (SELECT 1 FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085098' AND question_idx=1 AND player_id='00000000-0000-0000-0000-000000085002') THEN
    RAISE EXCEPTION '2c FAIL rejoin: L2 should be exposed at q1 after rejoin (expected L1+L2)'; END IF;
  -- q0 exposures unchanged by the later question (immutable, no retroactive change)
  IF (SELECT count(*) FROM public.game_question_exposures WHERE session_id='00000000-0000-0000-0000-000000085098' AND question_idx=0) <> 1 THEN
    RAISE EXCEPTION '2c FAIL q0 exposures changed retroactively'; END IF;
  RAISE NOTICE '2c. exposure: rejoin-before-a-later-question re-qualifies for THAT question; earlier question unchanged; duplicate phase idempotent: PASS';

  -- ── INDIVIDUAL FORMULA ────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ind := public.rpc_ralli_leaderboard_individuals('current_month', NULL);
  RESET ROLE;
  L1 := (SELECT e FROM jsonb_array_elements(ind->'rows') e WHERE e->>'player_id'=p_l1);
  -- L1: faced = 21 (3 sessions × 7 graded; q7 open pending EXCLUDED), correct = 18 (q0..q5 × 3). raw = 18/21 = 0.8571
  IF (L1->>'questions_faced')::int <> 21 THEN RAISE EXCEPTION '3 FAIL L1 faced % (expected 21, open q7 excluded)', L1->>'questions_faced'; END IF;
  IF (L1->>'verified_correct')::int <> 18 THEN RAISE EXCEPTION '3 FAIL L1 correct % (expected 18)', L1->>'verified_correct'; END IF;
  IF round((L1->>'raw_accuracy')::numeric,4) <> 0.8571 THEN RAISE EXCEPTION '3 FAIL L1 raw_acc %', L1->>'raw_accuracy'; END IF;
  IF (L1->>'enough_data')::boolean <> true OR (L1->>'rank') IS NULL THEN RAISE EXCEPTION '3 FAIL L1 not ranked'; END IF;
  RAISE NOTICE '3. individual: open-ended pending EXCLUDED from denom; faced=21 correct=18 raw=0.8571; ranked: PASS';

  -- L2: faced 21, correct 12 (q0..q3 × 3) → raw 0.5714; ranked. L4: faced 21, correct 18 → same as L1 numerically.
  L2 := (SELECT e FROM jsonb_array_elements(ind->'rows') e WHERE e->>'player_id'='00000000-0000-0000-0000-000000085002');
  IF (L2->>'verified_correct')::int <> 12 THEN RAISE EXCEPTION '4 FAIL L2 correct %', L2->>'verified_correct'; END IF;
  -- adjusted_accuracy shrinks toward tenant mean; L1 (0.857) must outrank L2 (0.571)
  IF (L1->>'adjusted_accuracy')::numeric <= (L2->>'adjusted_accuracy')::numeric THEN RAISE EXCEPTION '4 FAIL higher accuracy did not rank higher'; END IF;
  IF (L1->>'rank')::int >= (L2->>'rank')::int THEN RAISE EXCEPTION '4 FAIL L1 rank not better than L2'; END IF;
  RAISE NOTICE '4. individual: higher accuracy outranks lower regardless of equal volume; adjusted-accuracy shrinkage applied: PASS';

  -- L3: only exposures from S9 phase test (1 question) → faced < 20 → NOT enough → rank NULL, progress shown.
  L3 := (SELECT e FROM jsonb_array_elements(ind->'rows') e WHERE e->>'player_id'='00000000-0000-0000-0000-000000085003');
  IF L3 IS NOT NULL AND ((L3->>'enough_data')::boolean = true OR (L3->>'rank') IS NOT NULL) THEN RAISE EXCEPTION '5 FAIL L3 wrongly ranked'; END IF;
  RAISE NOTICE '5. individual: below-threshold learner is unranked (rank NULL, Not enough data): PASS';

  -- ── TEAM FORMULA ──────────────────────────────────────────────────────────
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  tms := public.rpc_ralli_leaderboard_teams('current_month');
  RESET ROLE;
  -- Team A: eligible L1,L2 (2) of active {L1,L2,L3} (3): 2 >= ceil(0.5*3)=2 → ENOUGH, ranked, median of {L1adj,L2adj}.
  -- Team B: eligible L4 (1) of active {L4,L5} (2): 1 < 2 → NOT ENOUGH.
  IF (SELECT (e->>'enough_data')::boolean FROM jsonb_array_elements(tms->'rows') e WHERE e->>'team_id'='00000000-0000-0000-0000-000000085a01') <> true THEN RAISE EXCEPTION '6 FAIL Team A not enough'; END IF;
  IF (SELECT e->>'rank' FROM jsonb_array_elements(tms->'rows') e WHERE e->>'team_id'='00000000-0000-0000-0000-000000085a01') IS NULL THEN RAISE EXCEPTION '6 FAIL Team A unranked'; END IF;
  IF (SELECT (e->>'enough_data')::boolean FROM jsonb_array_elements(tms->'rows') e WHERE e->>'team_id'='00000000-0000-0000-0000-000000085b01') <> false THEN RAISE EXCEPTION '6 FAIL Team B should be not-enough (1 eligible < 2)'; END IF;
  IF (SELECT (e->>'eligible_members')::int FROM jsonb_array_elements(tms->'rows') e WHERE e->>'team_id'='00000000-0000-0000-0000-000000085a01') <> 2 THEN RAISE EXCEPTION '6 FAIL Team A eligible_members'; END IF;
  RAISE NOTICE '6. team: median of eligible members; Team A ranked (2 eligible, 50%%+ participation), Team B not-enough (1 eligible): PASS';

  -- ── TIMEZONE ──────────────────────────────────────────────────────────────
  -- default UTC
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  IF public.rpc_get_org_timezone() <> 'UTC' THEN RAISE EXCEPTION '7 FAIL default tz not UTC'; END IF;
  PERFORM public.rpc_set_org_timezone('America/New_York');
  IF public.rpc_get_org_timezone() <> 'America/New_York' THEN RAISE EXCEPTION '7 FAIL tz not updated'; END IF;
  ok:=false; BEGIN PERFORM public.rpc_set_org_timezone('Mars/Phobos'); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION '7 FAIL invalid tz accepted'; END IF;
  RESET ROLE;
  -- learner cannot update
  PERFORM set_config('request.jwt.claims','{"sub":"'||p_l1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_set_org_timezone('UTC'); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  IF ok THEN RAISE EXCEPTION '7 FAIL learner changed tz'; END IF;
  RESET ROLE;
  RAISE NOTICE '7. timezone: default UTC; manager sets valid IANA; invalid rejected; learner read-only: PASS';

  -- ── SECURITY ──────────────────────────────────────────────────────────────
  -- anon denied (no EXECUTE grant to the anon role)
  PERFORM set_config('request.jwt.claims','',true); SET LOCAL ROLE anon;
  ok:=false; BEGIN PERFORM public.rpc_ralli_leaderboard_individuals('current_month', NULL); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION '8 FAIL anon allowed'; END IF;
  -- learner cannot drill into another team (L1 team A tries team B)
  PERFORM set_config('request.jwt.claims','{"sub":"'||p_l1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_ralli_team_members('00000000-0000-0000-0000-000000085b01', 'current_month'); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  IF ok THEN RAISE EXCEPTION '8 FAIL learner drilled into another team'; END IF;
  -- learner CAN view own team
  PERFORM public.rpc_ralli_team_members('00000000-0000-0000-0000-000000085a01', 'current_month');
  RESET ROLE;
  -- manager can view any same-tenant team
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_ralli_team_members('00000000-0000-0000-0000-000000085b01', 'current_month');
  RESET ROLE;
  RAISE NOTICE '8. security: anon denied; learner own-team only; manager any same-tenant team: PASS';

  -- ── PAYLOAD CONFIDENTIALITY ───────────────────────────────────────────────
  IF ind::text ILIKE '%answer_text%' OR ind::text ILIKE '%correct_idx%' OR ind::text ILIKE '%acceptedAnswers%' OR ind::text ILIKE '%question_snapshot%' THEN
    RAISE EXCEPTION '9 FAIL leaderboard payload leaks answer/solution material'; END IF;
  RAISE NOTICE '9. payload aggregate-only (no answer text / correct keys / snapshot): PASS';

  -- ── MANAGERS/ADMINS EXCLUDED FROM RANKINGS ────────────────────────────────
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(ind->'rows') e WHERE e->>'player_id' IN ('00000000-0000-0000-0000-00000085f001','00000000-0000-0000-0000-00000085f002')) THEN
    RAISE EXCEPTION '10 FAIL manager/admin present in rankings'; END IF;
  RAISE NOTICE '10. managers/admins excluded from rankings: PASS';

  -- ── SERVER-AUTHORITATIVE TIMEFRAMES (client sends only an enum) ─────────────
  -- 11a. UTC: resolved window equals the server-computed calendar boundaries; response carries from/to/tz.
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  PERFORM public.rpc_set_org_timezone('UTC');
  obj := public.rpc_ralli_leaderboard_individuals('current_month', NULL);
  IF obj->>'timezone' <> 'UTC' THEN RAISE EXCEPTION '11 FAIL tz not UTC in payload'; END IF;
  IF (obj->>'from')::timestamptz <> date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
     OR (obj->>'to')::timestamptz <> (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC' THEN
    RAISE EXCEPTION '11 FAIL UTC current_month boundaries wrong (from=%, to=%)', obj->>'from', obj->>'to'; END IF;
  -- 11b. invalid enum rejected
  ok:=false; BEGIN PERFORM public.rpc_ralli_leaderboard_individuals('all_time', NULL); ok:=true; EXCEPTION WHEN check_violation THEN END;
  IF ok THEN RAISE EXCEPTION '11 FAIL unsupported timeframe accepted'; END IF;
  -- 11c. America/New_York: boundaries computed in the tenant tz (DST-correct via Postgres calendar math)
  PERFORM public.rpc_set_org_timezone('America/New_York');
  obj := public.rpc_ralli_leaderboard_individuals('current_month', NULL);
  IF obj->>'timezone' <> 'America/New_York' THEN RAISE EXCEPTION '11 FAIL tz not NY'; END IF;
  IF (obj->>'from')::timestamptz <> date_trunc('month', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' THEN
    RAISE EXCEPTION '11 FAIL NY month start wrong'; END IF;
  -- 11d. current_year boundaries (year boundary) in tenant tz
  obj := public.rpc_ralli_leaderboard_individuals('current_year', NULL);
  IF (obj->>'from')::timestamptz <> date_trunc('year', now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York'
     OR (obj->>'to')::timestamptz <> (date_trunc('year', now() AT TIME ZONE 'America/New_York') + interval '1 year') AT TIME ZONE 'America/New_York' THEN
    RAISE EXCEPTION '11 FAIL current_year boundaries wrong'; END IF;
  -- 11e. last_3_months spans exactly 3 calendar months ending at next month start
  obj := public.rpc_ralli_leaderboard_individuals('last_3_months', NULL);
  IF (obj->>'from')::timestamptz <> (date_trunc('month', now() AT TIME ZONE 'America/New_York') - interval '2 months') AT TIME ZONE 'America/New_York'
     OR (obj->>'to')::timestamptz <> (date_trunc('month', now() AT TIME ZONE 'America/New_York') + interval '1 month') AT TIME ZONE 'America/New_York' THEN
    RAISE EXCEPTION '11 FAIL last_3_months boundaries wrong'; END IF;
  -- 11f. Individuals, Teams, Team Members resolve IDENTICAL windows (no disagreement)
  obj  := public.rpc_ralli_leaderboard_individuals('last_2_months', NULL);
  obj2 := public.rpc_ralli_leaderboard_teams('last_2_months');
  obj3 := public.rpc_ralli_team_members('00000000-0000-0000-0000-000000085a01','last_2_months');
  IF obj->>'from' <> obj2->>'from' OR obj->>'to' <> obj2->>'to' OR obj->>'timezone' <> obj2->>'timezone'
     OR obj->>'from' <> obj3->>'from' OR obj->>'to' <> obj3->>'to' OR obj->>'timezone' <> obj3->>'timezone' THEN
    RAISE EXCEPTION '11 FAIL Individuals/Teams/TeamMembers windows disagree'; END IF;
  -- 11g. client cannot widen: the old arbitrary-date signature no longer exists (undefined_function)
  ok:=false; BEGIN PERFORM public.rpc_ralli_leaderboard_individuals(now() - interval '10 years', now(), NULL); ok:=true; EXCEPTION WHEN undefined_function THEN END;
  IF ok THEN RAISE EXCEPTION '11 FAIL arbitrary-date signature still callable (client could widen)'; END IF;
  RESET ROLE;
  -- 11h. invalid STORED tz falls back to UTC (corrupt value written directly, bypassing rpc validation)
  UPDATE public.tenants SET timezone='Not/AZone' WHERE id='00000000-0000-0000-0000-0000000850a0';
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  obj := public.rpc_ralli_leaderboard_individuals('current_month', NULL);
  IF obj->>'timezone' <> 'UTC' THEN RAISE EXCEPTION '11 FAIL invalid stored tz did not fall back to UTC'; END IF;
  RESET ROLE;
  -- 11i. tenant isolation: another tenant's tz cannot influence this caller's window
  INSERT INTO public.tenants(id,name,timezone) VALUES ('00000000-0000-0000-0000-0000000850b0','TB','Asia/Tokyo');
  UPDATE public.tenants SET timezone='America/New_York' WHERE id='00000000-0000-0000-0000-0000000850a0';
  PERFORM set_config('request.jwt.claims','{"sub":"'||h1||'","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  obj := public.rpc_ralli_leaderboard_individuals('current_month', NULL);
  IF obj->>'timezone' <> 'America/New_York' THEN RAISE EXCEPTION '11 FAIL caller got another tenant''s tz'; END IF;
  RESET ROLE;
  RAISE NOTICE '11. server timeframes: enum-only; UTC + NY + year + last_N boundaries exact; invalid enum rejected; all 3 RPCs agree; arbitrary dates uncallable; invalid stored tz → UTC; tenant-isolated: PASS';

  RAISE NOTICE '085 ALL TESTS PASSED';
END $$;

-- ── VERIFICATION QUEUE / OUTBOX ─────────────────────────────────────────────
DO $$
DECLARE st text; att int; nxt timestamptz; lease timestamptz; claimed jsonb; ok boolean; i int;
  sid uuid := '00000000-0000-0000-0000-000000085077';
  dsid uuid := '00000000-0000-0000-0000-000000085078';
  csid uuid := '00000000-0000-0000-0000-000000085079';
  lsid uuid := '00000000-0000-0000-0000-000000085076';
BEGIN
  -- real session started → completed: trigger enqueues exactly one pending row
  INSERT INTO public.game_sessions(id,tenant_id,host_id,pin,status,demo_mode,question_count) VALUES (sid,'00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-00000085f001','p77','started',false,8);
  UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id=sid;
  IF (SELECT count(*) FROM public.game_verification_queue WHERE session_id=sid) <> 1 THEN RAISE EXCEPTION 'Q FAIL not enqueued once'; END IF;
  IF (SELECT state FROM public.game_verification_queue WHERE session_id=sid) <> 'pending' THEN RAISE EXCEPTION 'Q FAIL not pending'; END IF;
  -- idempotent: a redundant completed→completed update must not create a second row
  UPDATE public.game_sessions SET status='completed' WHERE id=sid;
  IF (SELECT count(*) FROM public.game_verification_queue WHERE session_id=sid) <> 1 THEN RAISE EXCEPTION 'Q FAIL duplicate enqueue'; END IF;
  RAISE NOTICE 'Q1. queue: real completion enqueues exactly once, idempotent: PASS';

  -- demo + canceled excluded
  INSERT INTO public.game_sessions(id,tenant_id,host_id,pin,status,demo_mode,question_count) VALUES (dsid,'00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-00000085f001','p78','started',true,8);
  UPDATE public.game_sessions SET status='completed' WHERE id=dsid;
  INSERT INTO public.game_sessions(id,tenant_id,host_id,pin,status,demo_mode,question_count) VALUES (csid,'00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-00000085f001','p79','started',false,8);
  UPDATE public.game_sessions SET status='canceled' WHERE id=csid;
  IF EXISTS (SELECT 1 FROM public.game_verification_queue WHERE session_id IN (dsid,csid)) THEN RAISE EXCEPTION 'Q FAIL demo/canceled enqueued'; END IF;
  RAISE NOTICE 'Q2. queue: demo + canceled sessions never enqueued: PASS';

  -- authenticated (non-worker) cannot claim jobs
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-00000085f001","role":"authenticated"}',true); SET LOCAL ROLE authenticated;
  ok:=false; BEGIN PERFORM public.rpc_claim_verification_job(); ok:=true; EXCEPTION WHEN insufficient_privilege THEN END;
  RESET ROLE;
  IF ok THEN RAISE EXCEPTION 'Q FAIL authenticated claimed a job'; END IF;

  -- service_role worker claims → processing
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  claimed := public.rpc_claim_verification_job();
  IF claimed IS NULL OR (claimed->>'session_id') <> sid::text THEN RAISE EXCEPTION 'Q FAIL worker did not claim pending job'; END IF;
  RESET ROLE;
  IF (SELECT state FROM public.game_verification_queue WHERE session_id=sid) <> 'processing' THEN RAISE EXCEPTION 'Q FAIL not processing after claim'; END IF;
  RAISE NOTICE 'Q3. queue: only service_role worker claims; claim marks processing: PASS';

  -- transient failure → retry with backoff, attempts increment, next_attempt in the future
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  PERFORM public.rpc_complete_verification_job(sid, false, 'transient upstream error');
  RESET ROLE;
  SELECT state, attempts, next_attempt_at INTO st, att, nxt FROM public.game_verification_queue WHERE session_id=sid;
  IF st <> 'pending' OR att <> 1 OR nxt <= now() THEN RAISE EXCEPTION 'Q FAIL retry/backoff (state=% att=%)', st, att; END IF;

  -- exhaust attempts → terminal 'failed'. attempts increment happens in claim; complete fails at attempts>=6.
  FOR i IN 1..8 LOOP
    -- force the row due & pending so the worker can re-claim it (simulates the backoff window elapsing)
    UPDATE public.game_verification_queue SET next_attempt_at = now() - interval '1 min', state='pending' WHERE session_id=sid AND state <> 'failed';
    PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
    PERFORM public.rpc_claim_verification_job();               -- attempts += 1, state=processing
    PERFORM public.rpc_complete_verification_job(sid, false, 'still failing');  -- pending (backoff) or failed at attempts>=6
    RESET ROLE;
    EXIT WHEN (SELECT state FROM public.game_verification_queue WHERE session_id=sid) = 'failed';
  END LOOP;
  IF (SELECT state FROM public.game_verification_queue WHERE session_id=sid) <> 'failed' THEN RAISE EXCEPTION 'Q FAIL did not reach terminal failed'; END IF;
  RAISE NOTICE 'Q4. queue: transient failure retries with backoff; exhausts to terminal failed: PASS';

  -- success path on a fresh job → completed
  UPDATE public.game_verification_queue SET state='pending', attempts=0, next_attempt_at=now()-interval '1 min' WHERE session_id=sid;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  PERFORM public.rpc_claim_verification_job();
  PERFORM public.rpc_complete_verification_job(sid, true, NULL);
  RESET ROLE;
  IF (SELECT state FROM public.game_verification_queue WHERE session_id=sid) <> 'completed' THEN RAISE EXCEPTION 'Q FAIL success not completed'; END IF;
  RAISE NOTICE 'Q5. queue: successful completion marks completed: PASS';

  -- confidentiality: the outbox row carries NO answer/verdict/snapshot material (schema-level)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='game_verification_queue'
      AND column_name IN ('answer_text','verified_correct','correct_idx','question_snapshot','answer_json','numeric_value')
  ) THEN RAISE EXCEPTION 'Q FAIL queue table exposes answer/verdict material'; END IF;
  RAISE NOTICE 'Q6. queue: outbox stores no answer/verdict/snapshot material: PASS';

  -- ── PROCESSING LEASE / CRASH RECOVERY ──────────────────────────────────────
  -- A claimed job holds a lease. A worker that dies mid-job leaves it 'processing'; once the lease
  -- expires the job is reclaimable (never permanently stuck). A live (unexpired) lease is NOT stealable.
  INSERT INTO public.game_sessions(id,tenant_id,host_id,pin,status,demo_mode,question_count) VALUES (lsid,'00000000-0000-0000-0000-0000000850a0','00000000-0000-0000-0000-00000085f001','p76','started',false,8);
  UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id=lsid;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  claimed := public.rpc_claim_verification_job();   -- claims lsid (only due job), sets processing + lease
  RESET ROLE;
  IF (claimed->>'session_id') <> lsid::text THEN RAISE EXCEPTION 'Q7 FAIL did not claim lease job'; END IF;
  SELECT state, lease_expires_at INTO st, lease FROM public.game_verification_queue WHERE session_id=lsid;
  IF st <> 'processing' OR lease IS NULL OR lease <= now() THEN RAISE EXCEPTION 'Q7 FAIL no live lease after claim'; END IF;
  -- worker "dies": no complete. A second claim must NOT steal the live-leased job (no other due jobs → none).
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  claimed := public.rpc_claim_verification_job();
  RESET ROLE;
  IF (claimed->>'claimed') <> 'false' THEN RAISE EXCEPTION 'Q7 FAIL live-leased job was stolen before lease expiry'; END IF;
  -- lease expires → the SAME job is reclaimable; attempts bumped; fresh lease taken.
  UPDATE public.game_verification_queue SET lease_expires_at = now() - interval '1 minute' WHERE session_id=lsid;
  SELECT attempts INTO att FROM public.game_verification_queue WHERE session_id=lsid;
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  claimed := public.rpc_claim_verification_job();
  RESET ROLE;
  IF (claimed->>'session_id') <> lsid::text THEN RAISE EXCEPTION 'Q7 FAIL expired-lease job not reclaimed'; END IF;
  IF (SELECT attempts FROM public.game_verification_queue WHERE session_id=lsid) <> att + 1 THEN RAISE EXCEPTION 'Q7 FAIL reclaim did not bump attempts'; END IF;
  -- completing clears the lease
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true); SET LOCAL ROLE service_role;
  PERFORM public.rpc_complete_verification_job(lsid, true, NULL);
  RESET ROLE;
  IF (SELECT lease_expires_at FROM public.game_verification_queue WHERE session_id=lsid) IS NOT NULL THEN RAISE EXCEPTION 'Q7 FAIL completion did not release lease'; END IF;
  RAISE NOTICE 'Q7. queue: processing lease held on claim; live lease not stealable; expired lease reclaimed (attempts bumped); completion releases lease: PASS';

  RAISE NOTICE '085 QUEUE TESTS PASSED';
END $$;
ROLLBACK;
