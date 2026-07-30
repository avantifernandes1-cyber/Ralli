-- Repeatable test for the REVEAL publication state guard (the conditional durable
-- write publishRevealDurable() performs from the host). Proves the exact WHERE
-- conditions accept a reveal ONLY for the current question of a RUNNING, UNPAUSED
-- game and reject every other state, so a delayed reveal can never overwrite a
-- newer question, a countdown/scoreboard, a waiting lobby, a paused game, or a
-- terminal session. No migration object — validates the SQL semantics the client uses.
-- Expect "REVEAL STALE-GUARD ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- Running, unpaused game on question index 1.
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index, paused)
 VALUES ('00000000-0000-0000-0000-0000000face1','00000000-0000-0000-0000-0000000face0','q','h','740001','R','started',3,false,'question',1,false);

-- FIRST-PUBLICATION guard used by publishRevealDurable():
--   .eq(id).eq(current_question_index, expected)
--   .in(phase, [question, open-review]).in(status, [started]).eq(paused, false)
DO $$
DECLARE v_n int;
BEGIN
  -- 1. running(started) + unpaused + phase=question + matching qIdx → applies.
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 OR (SELECT phase FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> 'reveal'
    THEN RAISE EXCEPTION 'T1 FAIL: reveal from running/unpaused/question did not apply (%)', v_n; END IF;
  RAISE NOTICE '1. reveal from started+unpaused+question applies: PASS';

  -- 2. open-ended: reveal from phase='open-review' (still started, unpaused) applies.
  UPDATE public.game_sessions SET phase='open-review' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"isOpen":true}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: open-ended reveal from open-review did not apply'; END IF;
  RAISE NOTICE '2. reveal from started+unpaused+open-review (open-ended) applies: PASS';

  -- 3. WAITING lobby (same qIdx, phase=question) → rejected.
  UPDATE public.game_sessions SET phase='question', status='waiting', paused=false WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: reveal applied on a WAITING lobby session'; END IF;
  RAISE NOTICE '3. reveal on a WAITING session is rejected: PASS';

  -- 4. PAUSED running game (started, phase=question, paused=true) → rejected.
  UPDATE public.game_sessions SET status='started', phase='question', paused=true WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: reveal applied while PAUSED'; END IF;
  -- ...but once explicitly resumed (paused=false), the reveal applies:
  UPDATE public.game_sessions SET paused=false WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: reveal did not apply after resume'; END IF;
  RAISE NOTICE '4. reveal is rejected while paused, and applies only after resume: PASS';

  -- 5. same-qIdx COUNTDOWN (cleared live_question) → rejected; cleared payload intact.
  UPDATE public.game_sessions SET phase='countdown', status='started', paused=false, current_question_index=1, live_question=NULL WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 OR (SELECT live_question FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') IS NOT NULL
    THEN RAISE EXCEPTION 'T5 FAIL: reveal overwrote a same-qIdx countdown'; END IF;
  RAISE NOTICE '5. delayed reveal during same-qIdx COUNTDOWN is rejected; cleared payload intact: PASS';

  -- 6. SCOREBOARD same qIdx → rejected.
  UPDATE public.game_sessions SET phase='scoreboard' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: reveal applied during scoreboard'; END IF;
  RAISE NOTICE '6. reveal during scoreboard is rejected: PASS';

  -- 7. newer qIdx → rejected; newer question intact (delayed old reveal).
  UPDATE public.game_sessions SET phase='question', status='started', paused=false, current_question_index=2, live_question='{"qIdx":2}'::jsonb WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 OR (SELECT live_question->>'qIdx' FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> '2'
    THEN RAISE EXCEPTION 'T7 FAIL: stale old-qIdx reveal overwrote a newer question'; END IF;
  RAISE NOTICE '7. delayed old-qIdx reveal is rejected; newer question intact: PASS';

  -- 8. terminal statuses (completed / canceled — exact spellings) → rejected.
  UPDATE public.game_sessions SET phase='question', current_question_index=2, status='completed', paused=false WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":2}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=2
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T8 FAIL: reveal applied to a completed session'; END IF;
  UPDATE public.game_sessions SET status='canceled' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":2}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=2
     AND phase IN ('question','open-review') AND status IN ('started') AND paused=false;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T8 FAIL: reveal applied to a canceled session'; END IF;
  RAISE NOTICE '8. reveal on terminal (completed / canceled) sessions is rejected: PASS';

  RAISE NOTICE 'REVEAL STALE-GUARD ALL TESTS PASSED';
END $$;

ROLLBACK;
