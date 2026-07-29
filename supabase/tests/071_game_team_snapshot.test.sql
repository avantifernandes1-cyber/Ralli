-- Repeatable tests for migration 071 (Ralli Live team-at-game-time snapshot).
-- Runs against a local DB with migrations through 071 applied. One rolled-back
-- transaction, no creds. Expect "071 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Tenant A with two teams + two reps; Tenant B (cross-tenant) with one rep.
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','g_a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','g_a2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','g_a3@t.test',now(),now()),  -- no team
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','g_b1@t.test',now(),now());  -- tenant B
INSERT INTO public.tenants (id, slug, name) VALUES
 ('00000000-0000-0000-0000-0000000000a0','g_ta','G_TA'),
 ('00000000-0000-0000-0000-0000000000b0','g_tb','G_TB');
INSERT INTO public.tenant_teams (id, tenant_id, name) VALUES
 ('00000000-0000-0000-0000-000000007ea1','00000000-0000-0000-0000-0000000000a0','Team Alpha'),
 ('00000000-0000-0000-0000-000000007ea2','00000000-0000-0000-0000-0000000000a0','Team Beta'),
 ('00000000-0000-0000-0000-000000007eb1','00000000-0000-0000-0000-0000000000b0','Team B-only');
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', team_id='00000000-0000-0000-0000-000000007ea1' WHERE id='00000000-0000-0000-0000-0000000000a1';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', team_id='00000000-0000-0000-0000-000000007ea2' WHERE id='00000000-0000-0000-0000-0000000000a2';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000a0', status='active', team_id=NULL WHERE id='00000000-0000-0000-0000-0000000000a3';
UPDATE public.profiles SET role='user', tenant_id='00000000-0000-0000-0000-0000000000b0', status='active', team_id='00000000-0000-0000-0000-000000007eb1' WHERE id='00000000-0000-0000-0000-0000000000b1';

-- A completed real session in tenant A
INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at)
 VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','111111','G','completed',5,false, now());

DO $$
DECLARE v_tid uuid; v_tname text; v_tid2 uuid;
BEGIN
  -- T1: authenticated same-tenant player WITH a team → stamped id + name
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','A1',100,1);
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE session_id='00000000-0000-0000-0000-0000000ffff1' AND player_id='00000000-0000-0000-0000-0000000000a1';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea1' OR v_tname <> 'Team Alpha' THEN RAISE EXCEPTION 'T1 FAIL: team not stamped (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '1. authenticated same-tenant player stamped with team id + name snapshot: PASS';

  -- T2: authenticated player with NO team → null/null
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','A3',80,2);
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a3';
  IF v_tid IS NOT NULL OR v_tname IS NOT NULL THEN RAISE EXCEPTION 'T2 FAIL: no-team player got a team (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '2. player with no team → null snapshot (never guessed): PASS';

  -- T3: guest / name-based player_id (no profile) → null
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','Guest Dave',70,3,3);
  SELECT team_id INTO v_tid FROM public.game_players WHERE player_id='Guest Dave';
  IF v_tid IS NOT NULL THEN RAISE EXCEPTION 'T3 FAIL: guest got a team'; END IF;
  RAISE NOTICE '3. guest / name-based player_id → null (excluded from team identity): PASS';

  -- T4: cross-tenant player_id (profile exists but in tenant B) → null
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000b1','B1',60,4);
  SELECT team_id INTO v_tid FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000b1';
  IF v_tid IS NOT NULL THEN RAISE EXCEPTION 'T4 FAIL: cross-tenant profile stamped a team'; END IF;
  RAISE NOTICE '4. cross-tenant player_id → null (tenant-validated): PASS';

  -- T5: client-supplied team_id on INSERT is ignored (server stamps from profile)
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank, team_id, team_name)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','A2',90,5,
            '00000000-0000-0000-0000-000000007ea1','SPOOFED');  -- lies: a2 is on Team Beta
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a2';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea2' OR v_tname <> 'Team Beta' THEN RAISE EXCEPTION 'T5 FAIL: client team value not overridden (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '5. client-supplied team_id/name ignored; server stamps from profile: PASS';

  -- T6: immutability — an UPDATE cannot change the snapshot
  UPDATE public.game_players SET final_score=999, team_id='00000000-0000-0000-0000-000000007ea2', team_name='HACK'
    WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea1' OR v_tname <> 'Team Alpha' THEN RAISE EXCEPTION 'T6 FAIL: snapshot mutated on update (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '6. snapshot immutable on UPDATE (score edit / tamper cannot change it): PASS';

  -- T7: team transfer AFTER the game does NOT rewrite the historical row
  UPDATE public.profiles SET team_id='00000000-0000-0000-0000-000000007ea2' WHERE id='00000000-0000-0000-0000-0000000000a1';  -- a1 moves Alpha → Beta
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea1' OR v_tname <> 'Team Alpha' THEN RAISE EXCEPTION 'T7 FAIL: transfer rewrote history (% / %)', v_tid, v_tname; END IF;
  -- a NEW game after the transfer captures the NEW team
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','A1-again',100,1);
  SELECT team_id INTO v_tid2 FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1' AND name='A1-again';
  IF v_tid2 <> '00000000-0000-0000-0000-000000007ea2' THEN RAISE EXCEPTION 'T7 FAIL: post-transfer game did not capture new team (%)', v_tid2; END IF;
  RAISE NOTICE '7. team transfer preserves historical snapshot; new game captures new team: PASS';

  -- T8: additive / no backfill — a row inserted with the trigger DISABLED (legacy
  -- simulation) stays NULL and remains immutable-null under later updates.
  ALTER TABLE public.game_players DISABLE TRIGGER trg_game_players_stamp_team;
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','A2-legacy',50,6);
  ALTER TABLE public.game_players ENABLE TRIGGER trg_game_players_stamp_team;
  SELECT team_id INTO v_tid FROM public.game_players WHERE name='A2-legacy';
  IF v_tid IS NOT NULL THEN RAISE EXCEPTION 'T8 FAIL: legacy row was backfilled'; END IF;
  UPDATE public.game_players SET final_score=51 WHERE name='A2-legacy';  -- update must not backfill
  SELECT team_id INTO v_tid FROM public.game_players WHERE name='A2-legacy';
  IF v_tid IS NOT NULL THEN RAISE EXCEPTION 'T8 FAIL: legacy row backfilled on update'; END IF;
  RAISE NOTICE '8. existing/legacy rows stay NULL (no historical backfill, even on update): PASS';

  RAISE NOTICE '071 ALL TESTS PASSED';
END $$;

ROLLBACK;
