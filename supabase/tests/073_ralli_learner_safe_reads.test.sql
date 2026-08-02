-- Repeatable tests for migration 073 (Ralli Live learner-safe read RPCs).
-- Proves the RPCs never expose question_snapshot or another player's answers to a
-- learner, enforce participant/completed for review, and stay tenant-scoped.
-- Runs against a local DB with migrations through 073. Expect "073 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000073a1','authenticated','authenticated','r73_host@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000073a2','authenticated','authenticated','r73_other@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000073a3','authenticated','authenticated','r73_nonpart@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000073b1','authenticated','authenticated','r73_btenant@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000073a0','r73_ta','R73_TA'),
 ('00000000-0000-0000-0000-0000000073b0','r73_tb','R73_TB');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000073a0', status='active' WHERE id='00000000-0000-0000-0000-0000000073a1';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000073a0', status='active' WHERE id='00000000-0000-0000-0000-0000000073a2';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000073a0', status='active' WHERE id='00000000-0000-0000-0000-0000000073a3';  -- same tenant, NOT a participant
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000073b0', status='active' WHERE id='00000000-0000-0000-0000-0000000073b1';
-- Completed session in tenant A, host a1 played it; a2 did NOT participate.
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-000000073f01','00000000-0000-0000-0000-0000000073a0','q','00000000-0000-0000-0000-0000000073a1','730001','R','completed',1,false,now(),
   '[{"id":"qa","type":"mc","correct":1,"options":["w","x"]}]'::jsonb);
INSERT INTO public.game_answers (session_id, tenant_id, player_id, question_idx, option_idx, is_correct, points) VALUES
 ('00000000-0000-0000-0000-000000073f01','00000000-0000-0000-0000-0000000073a0','00000000-0000-0000-0000-0000000073a1',0,1,true,100),
 ('00000000-0000-0000-0000-000000073f01','00000000-0000-0000-0000-0000000073a0','00000000-0000-0000-0000-0000000073a2',0,0,false,0);
INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank) VALUES
 ('00000000-0000-0000-0000-000000073f01','00000000-0000-0000-0000-0000000073a0','00000000-0000-0000-0000-0000000073a1','Host',100,1);

DO $$
DECLARE v jsonb; v_b bool;
BEGIN
  -- ── player_restore: HOST (a1) gets OWN answer only, NEVER question_snapshot ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073a1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v := public.rpc_player_session_restore('00000000-0000-0000-0000-000000073f01');
  IF v ? 'question_snapshot' OR (v->'session') ? 'question_snapshot' THEN RAISE EXCEPTION 'T1 FAIL: restore leaked question_snapshot'; END IF;
  IF jsonb_array_length(v->'my_answers') <> 1 THEN RAISE EXCEPTION 'T1 FAIL: host restore should return exactly its own 1 answer, got %', v->'my_answers'; END IF;
  IF (v->'my_answers'->0->>'question_idx') <> '0' THEN RAISE EXCEPTION 'T1 FAIL: wrong own answer'; END IF;
  RAISE NOTICE '1. player_restore: own answer only, no question_snapshot: PASS';
  RESET ROLE;

  -- ── player_restore: a2 (same tenant) sees ONLY its own answer, not a1''s ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073a2","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v := public.rpc_player_session_restore('00000000-0000-0000-0000-000000073f01');
  IF jsonb_array_length(v->'my_answers') <> 1 THEN RAISE EXCEPTION 'T2 FAIL: a2 should see only its own 1 answer'; END IF;
  -- a2's own answer is the wrong one (is_correct false); must never see a1's row
  IF (v->'my_answers'->0->>'is_correct') <> 'false' THEN RAISE EXCEPTION 'T2 FAIL: a2 got someone else''s answer'; END IF;
  RAISE NOTICE '2. player_restore: a learner sees only their OWN answer (no cross-player): PASS';
  RESET ROLE;

  -- ── player_restore: same-tenant NON-participant (a3) denied ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073a3","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_player_session_restore('00000000-0000-0000-0000-000000073f01'); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'T2b FAIL: same-tenant non-participant was allowed to restore'; END IF;
  RAISE NOTICE '2b. player_restore: same-tenant NON-participant denied: PASS';
  RESET ROLE;

  -- ── player_restore: cross-tenant (b1) denied ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073b1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_player_session_restore('00000000-0000-0000-0000-000000073f01'); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'T3 FAIL: cross-tenant restore allowed'; END IF;
  RAISE NOTICE '3. player_restore: cross-tenant denied: PASS';
  RESET ROLE;

  -- ── completed_review: participant (a1) gets snapshot + own answers ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073a1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v := public.rpc_my_completed_session_review('00000000-0000-0000-0000-000000073f01');
  IF (v->'snapshot') IS NULL OR jsonb_typeof(v->'snapshot') <> 'array' THEN RAISE EXCEPTION 'T4 FAIL: participant review missing snapshot'; END IF;
  IF jsonb_array_length(v->'my_answers') <> 1 THEN RAISE EXCEPTION 'T4 FAIL: review should return own 1 answer'; END IF;
  RAISE NOTICE '4. completed_review: participant gets snapshot + own answers (post-completion): PASS';
  RESET ROLE;

  -- ── completed_review: non-participant (b1) denied ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073b1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN v := public.rpc_my_completed_session_review('00000000-0000-0000-0000-000000073f01'); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'T5 FAIL: non-participant got completed review'; END IF;
  RAISE NOTICE '5. completed_review: non-participant denied: PASS';
  RESET ROLE;

  -- ── list_my_game_history: a1 sees own row; b1 sees none ──
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073a1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v := public.rpc_list_my_game_history(20);
  IF jsonb_array_length(v) <> 1 THEN RAISE EXCEPTION 'T6 FAIL: a1 own history should be 1 row'; END IF;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims','{"sub":"00000000-0000-0000-0000-0000000073b1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v := public.rpc_list_my_game_history(20);
  IF jsonb_array_length(v) <> 0 THEN RAISE EXCEPTION 'T6 FAIL: b1 should see no history, got %', v; END IF;
  RAISE NOTICE '6. list_my_game_history: own rows only (cross-user isolation): PASS';
  RESET ROLE;

  RAISE NOTICE '073 ALL TESTS PASSED';
END $$;

ROLLBACK;
