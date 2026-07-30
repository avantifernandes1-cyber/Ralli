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

DO $$
DECLARE v_n int;
BEGIN
  -- Helper semantics = supabase.update({phase:'reveal',live_question}).eq(id).eq(current_question_index,expected)
  --                    .not(status,in,(completed,canceled)).neq(phase,'ended')

  -- 1. Matching current question (expected=1) → 1 row updated (reveal set).
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND status NOT IN ('completed','canceled') AND phase <> 'ended';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: current-question reveal did not apply (%)', v_n; END IF;
  IF (SELECT phase FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> 'reveal' THEN RAISE EXCEPTION 'T1 FAIL: phase not reveal'; END IF;
  RAISE NOTICE '1. reveal for the CURRENT question applies (phase=reveal): PASS';

  -- 2. Idempotent re-publish for the SAME question (still index 1) → applies again (1 row), same payload.
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND status NOT IN ('completed','canceled') AND phase <> 'ended';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: idempotent re-publish should still match'; END IF;
  RAISE NOTICE '2. idempotent re-publish of the same reveal matches (1 row): PASS';

  -- Advance the game to question index 2 (host moved to the next question).
  UPDATE public.game_sessions SET phase='question', current_question_index=2,
         live_question='{"qIdx":2}'::jsonb WHERE id='00000000-0000-0000-0000-0000000face1';

  -- 3. A DELAYED reveal for the OLD question (expected=1) must NOT apply (0 rows) — never overwrite the newer question.
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":1,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=1
     AND status NOT IN ('completed','canceled') AND phase <> 'ended';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: stale reveal for an old question overwrote a newer one (%)', v_n; END IF;
  IF (SELECT live_question->>'qIdx' FROM public.game_sessions WHERE id='00000000-0000-0000-0000-0000000face1') <> '2'
     THEN RAISE EXCEPTION 'T3 FAIL: newer question payload was clobbered'; END IF;
  RAISE NOTICE '3. delayed old-question reveal is rejected; newer live_question intact: PASS';

  -- 4. Terminal session (completed) → reveal for its current question is rejected (0 rows).
  UPDATE public.game_sessions SET status='completed' WHERE id='00000000-0000-0000-0000-0000000face1';
  UPDATE public.game_sessions SET phase='reveal', live_question='{"qIdx":2,"reveal":{"correctIdx":1}}'::jsonb
   WHERE id='00000000-0000-0000-0000-0000000face1' AND current_question_index=2
     AND status NOT IN ('completed','canceled') AND phase <> 'ended';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: reveal applied to a completed session'; END IF;
  RAISE NOTICE '4. reveal on a terminal (completed/canceled) session is rejected: PASS';

  RAISE NOTICE 'REVEAL STALE-GUARD ALL TESTS PASSED';
END $$;

ROLLBACK;
