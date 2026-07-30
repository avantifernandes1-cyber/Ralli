-- Repeatable test for the REVEAL publication stale-guard (the conditional durable
-- write publishRevealDurable() performs from the host). Proves the exact WHERE
-- conditions accept a reveal only for the CURRENT question of a live session and
-- reject stale/terminal writes so a delayed reveal can never overwrite a newer
-- question. No migration object — this validates the SQL semantics the client uses.
-- Expect "REVEAL STALE-GUARD ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, phase, current_question_index)
 VALUES ('00000000-0000-0000-0000-0000000face1','00000000-0000-0000-0000-0000000face0','q','h','740001','R','live',3,false,'question',1);

-- Exact FIRST-PUBLICATION guard used by publishRevealDurable():
--   .eq(id).eq(current_question_index, expected)
--   .in(phase, [question, open-review]).in(status, [waiting,started,live,active,paused])
-- (idempotent/conflict for phase='reveal' are classified client-side, not by this UPDATE)
DO $$
DECLARE v_n int;
BEGIN
  -- 1. phase='question', matching qIdx, active status → applies (1 row → reveal).
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 OR (SELECT phase FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> 'reveal'
    THEN RAISE EXCEPTION 'T1 FAIL: reveal from phase=question did not apply (%)', v_n; END IF;
  RAISE NOTICE '1. reveal from phase=question (current qIdx, active) applies: PASS';

  -- 2. open-ended path: reveal transitions from phase='open-review'.
  UPDATE public.game_sessions SET phase='open-review' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"isOpen":true}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: open-ended reveal from open-review did not apply'; END IF;
  RAISE NOTICE '2. reveal from phase=open-review (open-ended) applies: PASS';

  -- 3. THE FIX — phase='countdown' with the SAME qIdx must be rejected (0 rows),
  --    so a delayed reveal cannot overwrite the cleared live_question in countdown.
  UPDATE public.game_sessions SET phase='countdown', current_question_index=1, live_question=NULL WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: reveal overwrote a same-qIdx COUNTDOWN'; END IF;
  IF (SELECT live_question FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') IS NOT NULL
     THEN RAISE EXCEPTION 'T3 FAIL: cleared countdown live_question was clobbered'; END IF;
  RAISE NOTICE '3. delayed reveal during same-qIdx COUNTDOWN is rejected; cleared live_question intact: PASS';

  -- 4. phase='scoreboard' same qIdx → rejected.
  UPDATE public.game_sessions SET phase='scoreboard' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: reveal applied during scoreboard'; END IF;
  RAISE NOTICE '4. reveal during scoreboard is rejected: PASS';

  -- 5. newer qIdx → rejected (delayed old reveal cannot touch a newer question).
  UPDATE public.game_sessions SET phase='question', current_question_index=2, live_question='{"qIdx":2}'::jsonb WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 OR (SELECT live_question->>'qIdx' FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> '2'
    THEN RAISE EXCEPTION 'T5 FAIL: stale old-qIdx reveal overwrote a newer question'; END IF;
  RAISE NOTICE '5. delayed old-qIdx reveal is rejected; newer question intact: PASS';

  -- 6. terminal status (completed/canceled — exact spellings) → rejected.
  UPDATE public.game_sessions SET phase='question', current_question_index=2, status='completed' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":2,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=2
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: reveal applied to a completed session'; END IF;
  UPDATE public.game_sessions SET status='canceled' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":2}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=2
     AND phase IN ('question','open-review') AND status IN ('waiting','started','live','active','paused');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: reveal applied to a canceled session'; END IF;
  RAISE NOTICE '6. reveal on terminal (completed / canceled) sessions is rejected: PASS';

  RAISE NOTICE 'REVEAL STALE-GUARD ALL TESTS PASSED';
END $$;

ROLLBACK;
