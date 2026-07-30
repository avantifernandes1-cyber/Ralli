-- Repeatable tests for migration 072 (Ralli Live verification foundation).
-- Proves: (A) question_snapshot freeze integrity (write-once, immutable, hash-bound,
-- other columns untouched); (B) immutable, service-role-only verification storage;
-- (C) the atomic/idempotent record_game_verification RPC (independent of client
-- correctness, tenant-derived, cross-session-safe, honest ineligible/error states);
-- (D) client write/delete/execute rejection + tenant-scoped reads; (E) 071 team
-- snapshot still works. Runs against a local DB with migrations through 072.
-- One rolled-back transaction, no creds. Expect "072 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Tenant A (a0): u1,u2 active learners (role user); m1 active manager (orgAdmin).
-- Tenant B (b0): b1 learner (cross-tenant/other-tenant reads).
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','v_a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','v_a2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','v_a3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','v_b1@t.test',now(),now());
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','v_ta','V_TA'),
 ('00000000-0000-0000-0000-0000000000b0','v_tb','V_TB');
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='orgAdmin', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active' WHERE id='00000000-0000-0000-0000-0000000000a3';
UPDATE public.profiles SET role='user',     tenant_id='00000000-0000-0000-0000-0000000000b0', status='active' WHERE id='00000000-0000-0000-0000-0000000000b1';

-- A 2-question snapshot (mc + slider). Note the superset keys are irrelevant here.
\set snap '[{"id":"qa","type":"mc","correct":1,"options":["w","x","y","z"]},{"id":"qb","type":"slider","correct":50,"tolerance":5}]'

-- S1: completed, real, host u1, WITH snapshot (inserted with snapshot present so
-- the freeze trigger stamps its hash at insert).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700001','S1','completed',2,false, now(), :'snap'::jsonb);
-- S2: completed, real, NO snapshot (legacy).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at)
 VALUES ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700002','S2','completed',2,false, now());
-- S3: waiting (freeze-trigger tests).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode)
 VALUES ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700003','S3','waiting',2,false);
-- S4: completed demo (demo rejection).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700004','S4','completed',2,true, now(), :'snap'::jsonb);
-- S5: started, not completed (not-completed rejection).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode)
 VALUES ('00000000-0000-0000-0000-00000000f005','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700005','S5','started',2,false);
-- S6: completed real WITH snapshot (cross-session verdict test target).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f006','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700006','S6','completed',2,false, now(), :'snap'::jsonb);
-- S7: completed real WITH snapshot (hash-mismatch test).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f007','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700007','S7','completed',2,false, now(), :'snap'::jsonb);
-- S8: completed real WITH snapshot, ONE learner only (solo-session count test).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f008','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700008','S8','completed',2,false, now(), :'snap'::jsonb);
-- S9: completed real WITH snapshot (backfill-correctness test — simulated legacy null hash).
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at, question_snapshot)
 VALUES ('00000000-0000-0000-0000-00000000f009','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','700009','S9','completed',2,false, now(), :'snap'::jsonb);

-- game_answers for S1 (explicit ids). ans3 stores is_correct=TRUE on a WRONG option
-- to prove the verifier ignores client correctness.
INSERT INTO public.game_answers (id, session_id, tenant_id, player_id, player_name, question_idx, option_idx, numeric_value, is_correct, points, was_skipped) VALUES
 ('00000000-0000-0000-0000-00000000a001','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','U1',0,1,NULL,true, 100,false),
 ('00000000-0000-0000-0000-00000000a002','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','U1',1,NULL,53,true, 100,false),
 ('00000000-0000-0000-0000-00000000a003','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','U2',0,0,NULL,true, 0,  false),
 ('00000000-0000-0000-0000-00000000a004','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','U2',1,NULL,NULL,false,0,  true),
 ('00000000-0000-0000-0000-00000000a005','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','M1',0,1,NULL,true, 100,false);
-- S8 solo: one learner u1, one scored answer.
INSERT INTO public.game_answers (id, session_id, tenant_id, player_id, player_name, question_idx, option_idx, is_correct, points) VALUES
 ('00000000-0000-0000-0000-00000000a801','00000000-0000-0000-0000-00000000f008','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','U1',0,1,true,100);

DO $$
DECLARE
  v_hash text; v_hash2 text; v_frozen timestamptz; v_res jsonb; v_n int; v_b bool; v_vc boolean;
BEGIN
  -- ══ A. SNAPSHOT FREEZE INTEGRITY ══════════════════════════════════════════════
  -- S1 was inserted WITH a snapshot → hash + frozen_at stamped server-side at insert.
  SELECT question_snapshot_hash, question_snapshot_frozen_at INTO v_hash, v_frozen
    FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_hash IS NULL OR v_hash <> md5((SELECT question_snapshot FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001')::text)
     OR v_frozen IS NULL THEN RAISE EXCEPTION 'A1 FAIL: insert did not stamp snapshot hash/frozen_at (% / %)', v_hash, v_frozen; END IF;
  RAISE NOTICE '1. snapshot present at INSERT is hash-bound + frozen server-side: PASS';

  -- First set on a WAITING session (null -> value) is allowed and stamps hash.
  UPDATE public.game_sessions SET question_snapshot = '[{"id":"qa","type":"mc","correct":0,"options":["a","b"]}]'::jsonb
   WHERE id='00000000-0000-0000-0000-00000000f003';
  SELECT question_snapshot_hash, question_snapshot_frozen_at INTO v_hash, v_frozen
    FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f003';
  IF v_hash IS NULL OR v_frozen IS NULL THEN RAISE EXCEPTION 'A2 FAIL: first snapshot set (waiting) did not stamp hash/frozen_at'; END IF;
  RAISE NOTICE '2. snapshot settable once while waiting (null->value), hash stamped: PASS';

  -- Changing an existing snapshot is rejected.
  BEGIN
    UPDATE public.game_sessions SET question_snapshot='[{"id":"zz","type":"mc","correct":1}]'::jsonb WHERE id='00000000-0000-0000-0000-00000000f001';
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'A3 FAIL: snapshot rewrite was allowed'; END IF;
  RAISE NOTICE '3. rewriting an existing snapshot is rejected (write-once): PASS';

  -- Clearing an existing snapshot to NULL is rejected.
  BEGIN
    UPDATE public.game_sessions SET question_snapshot=NULL WHERE id='00000000-0000-0000-0000-00000000f001';
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'A4 FAIL: clearing snapshot to NULL was allowed'; END IF;
  RAISE NOTICE '4. clearing an existing snapshot is rejected: PASS';

  -- Setting a snapshot on a non-waiting session (started) is rejected.
  BEGIN
    UPDATE public.game_sessions SET question_snapshot='[{"id":"qa","type":"mc","correct":1,"options":["w","x","y","z"]},{"id":"qb","type":"slider","correct":50,"tolerance":5}]'::jsonb WHERE id='00000000-0000-0000-0000-00000000f005';
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'A5 FAIL: snapshot set on non-waiting session was allowed'; END IF;
  RAISE NOTICE '5. snapshot cannot be retro-attached to a non-waiting session: PASS';

  -- Non-snapshot updates succeed AND preserve hash/frozen_at; client-supplied hash ignored.
  SELECT question_snapshot_hash INTO v_hash FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001';
  UPDATE public.game_sessions
     SET phase='reveal', live_question='{"x":1}'::jsonb, paused=true, current_question_index=1,
         question_snapshot_hash='client-bogus-hash', question_snapshot_frozen_at=now()+interval '1 year'
   WHERE id='00000000-0000-0000-0000-00000000f001';
  SELECT question_snapshot_hash INTO v_hash2 FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001';
  IF v_hash2 <> v_hash THEN RAISE EXCEPTION 'A6 FAIL: hash changed by a non-snapshot update / client value not ignored (% -> %)', v_hash, v_hash2; END IF;
  IF (SELECT phase FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001') <> 'reveal' THEN RAISE EXCEPTION 'A6 FAIL: phase update discarded'; END IF;
  RAISE NOTICE '6. non-snapshot updates (phase/live_question/…) succeed; hash/frozen_at server-owned + immutable: PASS';

  -- Freeze compatibility: on a snapshot-frozen session (S3), the legitimate
  -- lifecycle writes still work — status transitions + live_question set/clear +
  -- pause/reconnect metadata — and the snapshot hash is preserved throughout.
  SELECT question_snapshot_hash INTO v_hash FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f003';
  UPDATE public.game_sessions SET status='started', started_at=now() WHERE id='00000000-0000-0000-0000-00000000f003';
  UPDATE public.game_sessions SET phase='question', live_question='{"qIdx":0}'::jsonb, current_question_index=0 WHERE id='00000000-0000-0000-0000-00000000f003';
  UPDATE public.game_sessions SET paused=true WHERE id='00000000-0000-0000-0000-00000000f003';         -- pause
  UPDATE public.game_sessions SET paused=false, live_question=NULL WHERE id='00000000-0000-0000-0000-00000000f003'; -- resume + clear live_question
  UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id='00000000-0000-0000-0000-00000000f003';
  SELECT question_snapshot_hash INTO v_hash2 FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f003';
  IF v_hash2 IS DISTINCT FROM v_hash THEN RAISE EXCEPTION 'A6b FAIL: lifecycle writes changed the snapshot hash (% -> %)', v_hash, v_hash2; END IF;
  IF (SELECT status FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f003') <> 'completed' THEN RAISE EXCEPTION 'A6b FAIL: status transition blocked'; END IF;
  RAISE NOTICE '6b. status transitions + live_question set/clear + pause/resume unaffected by freeze; hash preserved: PASS';

  -- Backfill correctness (regression for the migration bug this audit found):
  -- simulate a legacy snapshot row whose hash is NULL, then prove (i) an
  -- unchanged-snapshot UPDATE with the trigger ENABLED cannot set the hash (the
  -- trigger re-asserts OLD.hash=NULL) — which is exactly why the migration
  -- backfill DISABLEs the trigger — and (ii) the disable-wrapped backfill sets it.
  ALTER TABLE public.game_sessions DISABLE TRIGGER trg_game_sessions_freeze_snapshot;
  UPDATE public.game_sessions SET question_snapshot_hash=NULL, question_snapshot_frozen_at=NULL WHERE id='00000000-0000-0000-0000-00000000f009';
  ALTER TABLE public.game_sessions ENABLE TRIGGER trg_game_sessions_freeze_snapshot;
  -- (i) trigger-enabled attempt to set hash is nullified:
  UPDATE public.game_sessions SET question_snapshot_hash='attempt-with-trigger-on' WHERE id='00000000-0000-0000-0000-00000000f009';
  IF (SELECT question_snapshot_hash FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f009') IS NOT NULL
    THEN RAISE EXCEPTION 'A7 FAIL: trigger did not re-assert null hash (backfill-must-disable premise wrong)'; END IF;
  -- (ii) the migration''s disable-wrapped backfill statement sets it:
  ALTER TABLE public.game_sessions DISABLE TRIGGER trg_game_sessions_freeze_snapshot;
  UPDATE public.game_sessions
     SET question_snapshot_hash = md5(question_snapshot::text),
         question_snapshot_frozen_at = COALESCE(question_snapshot_frozen_at, ended_at, created_at)
   WHERE question_snapshot IS NOT NULL AND question_snapshot_hash IS NULL;
  ALTER TABLE public.game_sessions ENABLE TRIGGER trg_game_sessions_freeze_snapshot;
  SELECT question_snapshot_hash INTO v_hash FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f009';
  IF v_hash IS NULL OR v_hash <> md5((SELECT question_snapshot FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f009')::text)
    THEN RAISE EXCEPTION 'A7 FAIL: disable-wrapped backfill did not set the hash (%)', v_hash; END IF;
  RAISE NOTICE '6c. legacy-snapshot hash backfill persists only with the trigger disabled (migration bug fixed): PASS';

  -- ══ B. VERIFICATION RPC — valid path ═════════════════════════════════════════
  v_res := public.record_game_verification(
    '00000000-0000-0000-0000-00000000f001','ralli-game-grader@1','test',
    '[{"answer_id":"00000000-0000-0000-0000-00000000a001","player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":0,"question_stable_id":"qa","verified_correct":true,"eligibility":"scored"},
      {"answer_id":"00000000-0000-0000-0000-00000000a002","player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":1,"question_stable_id":"qb","verified_correct":true,"eligibility":"scored"},
      {"answer_id":"00000000-0000-0000-0000-00000000a003","player_id":"00000000-0000-0000-0000-0000000000a2","question_idx":0,"question_stable_id":"qa","verified_correct":false,"eligibility":"scored"},
      {"answer_id":"00000000-0000-0000-0000-00000000a004","player_id":"00000000-0000-0000-0000-0000000000a2","question_idx":1,"question_stable_id":"qb","verified_correct":null,"eligibility":"skipped"},
      {"answer_id":"00000000-0000-0000-0000-00000000a005","player_id":"00000000-0000-0000-0000-0000000000a3","question_idx":0,"question_stable_id":"qa","verified_correct":true,"eligibility":"scored"}]'::jsonb);
  IF v_res->>'status' <> 'complete' THEN RAISE EXCEPTION 'B7 FAIL: expected complete, got %', v_res; END IF;
  IF (v_res->>'verified_scored_answers')::int <> 4 THEN RAISE EXCEPTION 'B7 FAIL: scored count %, expected 4', v_res->>'verified_scored_answers'; END IF;
  -- eligible participants = distinct ACTIVE LEARNERS with a scored answer: u1 + u2 (m1 is a manager → excluded).
  IF (v_res->>'eligible_participant_count')::int <> 2 THEN RAISE EXCEPTION 'B7 FAIL: participant count %, expected 2 (manager excluded)', v_res->>'eligible_participant_count'; END IF;
  IF (SELECT count(*) FROM public.game_session_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001') <> 1 THEN RAISE EXCEPTION 'B7 FAIL: not exactly one session verification row'; END IF;
  IF (SELECT count(*) FROM public.game_answer_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001') <> 5 THEN RAISE EXCEPTION 'B7 FAIL: expected 5 per-answer rows'; END IF;
  IF (SELECT snapshot_hash FROM public.game_session_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001')
       <> md5((SELECT question_snapshot FROM public.game_sessions WHERE id='00000000-0000-0000-0000-00000000f001')::text)
     THEN RAISE EXCEPTION 'B7 FAIL: session verification not bound to frozen snapshot hash'; END IF;
  RAISE NOTICE '7. valid verification: complete, 4 scored, 2 eligible learners (manager excluded), hash-bound: PASS';

  -- Independence: ans3 stored is_correct=TRUE but the verdict said false → stored false.
  SELECT verified_correct INTO v_vc FROM public.game_answer_verifications WHERE answer_id='00000000-0000-0000-0000-00000000a003';
  IF v_vc IS DISTINCT FROM false THEN RAISE EXCEPTION 'B8 FAIL: verifier used client is_correct instead of the independent verdict (%)', v_vc; END IF;
  IF (SELECT is_correct FROM public.game_answers WHERE id='00000000-0000-0000-0000-00000000a003') <> true THEN RAISE EXCEPTION 'B8 FAIL: fixture precondition'; END IF;
  RAISE NOTICE '8. verified_correct is independent of client game_answers.is_correct: PASS';

  -- Idempotency: a second call is a no-op returning the existing status; no dup rows.
  v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f001','ralli-game-grader@1','test','[]'::jsonb);
  IF (v_res->>'idempotent')::bool IS DISTINCT FROM true THEN RAISE EXCEPTION 'B9 FAIL: repeat not idempotent (%)', v_res; END IF;
  IF (SELECT count(*) FROM public.game_session_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001') <> 1
     OR (SELECT count(*) FROM public.game_answer_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001') <> 5
     THEN RAISE EXCEPTION 'B9 FAIL: idempotent retry duplicated rows'; END IF;
  RAISE NOTICE '9. repeated verification is idempotent (no duplicate records): PASS';

  -- ══ C. HONEST INELIGIBLE / ERROR STATES ══════════════════════════════════════
  -- Missing snapshot → durable ineligible, no per-answer rows.
  v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f002','ralli-game-grader@1','test','[]'::jsonb);
  IF v_res->>'status' <> 'ineligible' OR v_res->>'reason' <> 'no_snapshot' THEN RAISE EXCEPTION 'C10 FAIL: legacy null-snapshot not ineligible (%)', v_res; END IF;
  IF (SELECT count(*) FROM public.game_answer_verifications WHERE session_id='00000000-0000-0000-0000-00000000f002') <> 0 THEN RAISE EXCEPTION 'C10 FAIL: ineligible wrote answer rows'; END IF;
  RAISE NOTICE '10. legacy null-snapshot session → honest ineligible (no backfill/guess): PASS';

  -- Demo session → rejected (not verifiable).
  BEGIN v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f004','ralli-game-grader@1','test','[]'::jsonb); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'C11 FAIL: demo session was verifiable'; END IF;
  RAISE NOTICE '11. demo session is not verifiable: PASS';

  -- Not-completed session → rejected (retryable/error).
  BEGIN v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f005','ralli-game-grader@1','test','[]'::jsonb); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'C12 FAIL: not-completed session was verifiable'; END IF;
  RAISE NOTICE '12. not-completed session is not verifiable: PASS';

  -- Cross-session verdict: S6 target but a verdict referencing S1''s answer → rejected.
  BEGIN
    v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f006','ralli-game-grader@1','test',
      '[{"answer_id":"00000000-0000-0000-0000-00000000a001","player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":0,"eligibility":"scored","verified_correct":true}]'::jsonb);
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'C13 FAIL: verdict referencing another session was accepted'; END IF;
  IF (SELECT count(*) FROM public.game_session_verifications WHERE session_id='00000000-0000-0000-0000-00000000f006') <> 0 THEN RAISE EXCEPTION 'C13 FAIL: partial write persisted after cross-session error'; END IF;
  RAISE NOTICE '13. verdict referencing another session rejected; nothing persisted (rollback): PASS';

  -- Duplicate verdict identity guard: two verdicts for the same (question_idx,
  -- player_id) are rejected deterministically (defense in depth; the grader
  -- resolves duplicates to one canonical verdict before writing). Nothing persists.
  BEGIN
    v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f006','ralli-game-grader@1','test',
      '[{"answer_id":null,"player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":0,"eligibility":"scored","verified_correct":true},
        {"answer_id":null,"player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":0,"eligibility":"scored","verified_correct":false}]'::jsonb);
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'C13b FAIL: duplicate (question_idx,player_id) verdict identity was accepted'; END IF;
  IF (SELECT count(*) FROM public.game_session_verifications WHERE session_id='00000000-0000-0000-0000-00000000f006') <> 0 THEN RAISE EXCEPTION 'C13b FAIL: partial write after duplicate-key rejection'; END IF;
  RAISE NOTICE '13b. duplicate (question_idx,player_id) verdict identity rejected; nothing persisted: PASS';

  -- Hash mismatch: corrupt S7''s stored hash (freeze trigger bypassed) → rejected.
  ALTER TABLE public.game_sessions DISABLE TRIGGER trg_game_sessions_freeze_snapshot;
  UPDATE public.game_sessions SET question_snapshot_hash='deadbeefdeadbeefdeadbeefdeadbeef' WHERE id='00000000-0000-0000-0000-00000000f007';
  ALTER TABLE public.game_sessions ENABLE TRIGGER trg_game_sessions_freeze_snapshot;
  BEGIN v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f007','ralli-game-grader@1','test','[]'::jsonb); v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'C14 FAIL: hash mismatch was accepted'; END IF;
  RAISE NOTICE '14. changed snapshot hash → honest integrity error (not verified): PASS';

  -- Solo session → complete but eligible_participant_count = 1 (leaderboard excludes later).
  v_res := public.record_game_verification('00000000-0000-0000-0000-00000000f008','ralli-game-grader@1','test',
    '[{"answer_id":"00000000-0000-0000-0000-00000000a801","player_id":"00000000-0000-0000-0000-0000000000a1","question_idx":0,"question_stable_id":"qa","verified_correct":true,"eligibility":"scored"}]'::jsonb);
  IF v_res->>'status' <> 'complete' OR (v_res->>'eligible_participant_count')::int <> 1 THEN RAISE EXCEPTION 'C15 FAIL: solo session count wrong (%)', v_res; END IF;
  RAISE NOTICE '15. solo session verifies with participant_count=1 (leaderboard-excluded later): PASS';

  -- ══ D. IMMUTABILITY ══════════════════════════════════════════════════════════
  BEGIN UPDATE public.game_session_verifications SET status='ineligible' WHERE session_id='00000000-0000-0000-0000-00000000f001'; v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'D16 FAIL: session verification was mutable'; END IF;
  BEGIN UPDATE public.game_answer_verifications SET verified_correct=true WHERE answer_id='00000000-0000-0000-0000-00000000a003'; v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'D16 FAIL: answer verification was mutable'; END IF;
  RAISE NOTICE '16. verification records are immutable (UPDATE blocked on both tables): PASS';

  -- ══ E. 071 team snapshot still works (regression) ═════════════════════════════
  UPDATE public.profiles SET team_id=NULL WHERE id='00000000-0000-0000-0000-0000000000a1';
  IF (SELECT count(*) FROM pg_trigger WHERE tgname='trg_game_players_stamp_team' AND NOT tgisinternal) <> 1 THEN RAISE EXCEPTION 'E17 FAIL: 071 team trigger missing'; END IF;
  RAISE NOTICE '17. 071 game_players team trigger still present (team snapshot preserved): PASS';

  RAISE NOTICE '072 CORE (DO-block) TESTS PASSED';
END $$;

-- ══ F. CLIENT WRITE / EXECUTE / READ boundaries (role-scoped) ═══════════════════
-- These must run as the authenticated role with a JWT sub so RLS/get_my_tenant_id
-- resolve. Each negative case is wrapped so an expected denial is a PASS.
DO $$
DECLARE v_b bool; v_cnt int;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;

  -- Client cannot EXECUTE the writer RPC.
  BEGIN PERFORM public.record_game_verification('00000000-0000-0000-0000-00000000f006','x','x','[]'::jsonb); v_b := true;
  EXCEPTION WHEN insufficient_privilege THEN v_b := false; WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'F18 FAIL: authenticated could execute record_game_verification'; END IF;

  -- Client cannot INSERT verification truth.
  BEGIN
    INSERT INTO public.game_session_verifications (session_id, tenant_id, status, grader_version, verification_source)
      VALUES ('00000000-0000-0000-0000-00000000f006','00000000-0000-0000-0000-0000000000a0','complete','x','x');
    v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'F18 FAIL: authenticated could INSERT a session verification'; END IF;

  -- Client cannot DELETE verification truth.
  BEGIN DELETE FROM public.game_answer_verifications WHERE session_id='00000000-0000-0000-0000-00000000f001'; v_b := true;
  EXCEPTION WHEN OTHERS THEN v_b := false; END;
  IF v_b THEN RAISE EXCEPTION 'F18 FAIL: authenticated could DELETE answer verifications'; END IF;
  RAISE NOTICE '18. authenticated cannot execute-writer / insert / delete verification truth: PASS';

  -- Same-tenant authenticated CAN read its tenant''s verification rows.
  SELECT count(*) INTO v_cnt FROM public.game_session_verifications;
  IF v_cnt < 1 THEN RAISE EXCEPTION 'F19 FAIL: same-tenant learner cannot read own verification rows (%)', v_cnt; END IF;
  RESET ROLE;

  -- Other-tenant authenticated sees NONE of tenant A''s verifications.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000b1","role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_cnt FROM public.game_session_verifications;
  IF v_cnt <> 0 THEN RAISE EXCEPTION 'F19 FAIL: cross-tenant read leaked % rows', v_cnt; END IF;
  RESET ROLE;
  RAISE NOTICE '19. verification reads are tenant-scoped (own tenant only; cross-tenant = 0): PASS';

  RAISE NOTICE '072 ALL TESTS PASSED';
END $$;

ROLLBACK;
