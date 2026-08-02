-- Repeatable tests for migration 071 (Ralli Live team-at-game-time snapshot).
-- Proves the UPDATE trigger freezes ONLY team_id/team_name and lets every other
-- game_players column change (no whole-row freeze). Runs against a local DB with
-- migrations through 071. One rolled-back transaction, no creds.
-- Expect "071 ALL TESTS PASSED".
\set ON_ERROR_STOP on
BEGIN;

-- ── Fixtures ─────────────────────────────────────────────────────────────────
-- Tenant A: two teams + reps a1 (Team Alpha), a2 (Team Beta), a3 (no team).
-- Tenant B: rep b1 (cross-tenant).
INSERT INTO auth.users (id, aud, role, email, created_at, updated_at) VALUES
 ('00000000-0000-0000-0000-0000000000a1','authenticated','authenticated','g_a1@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a2','authenticated','authenticated','g_a2@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000a3','authenticated','authenticated','g_a3@t.test',now(),now()),
 ('00000000-0000-0000-0000-0000000000b1','authenticated','authenticated','g_b1@t.test',now(),now());
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

INSERT INTO public.game_sessions (id, tenant_id, quiz_id, host_id, pin, name, status, question_count, demo_mode, ended_at)
 VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','q1','00000000-0000-0000-0000-0000000000a1','111111','G','completed',5,false, now());

DO $$
DECLARE v_tid uuid; v_tname text; v_score int; v_rank int; v_acc int; v_name text; v_emoji text; v_color text;
BEGIN
  -- INSERT stamps (setup for the mutability tests)
  -- a1 → Team Alpha
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, emoji, color, final_score, final_rank, accuracy)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','A1','🐙','#111',100,1,90);
  -- guest (name-based id, no profile) → null team
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank, accuracy)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','Guest Dave','Guest Dave',70,3,50);

  -- ══ 1 + 2 + 3 + 4 + 5 + 6: one UPDATE changes team + all other fields; only team is frozen ══
  UPDATE public.game_players
     SET team_id='00000000-0000-0000-0000-000000007ea2', team_name='HACK',        -- attempt to change snapshot
         final_score=999, final_rank=7, accuracy=42, name='A1-renamed', emoji='🦊', color='#999'
   WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  SELECT team_id, team_name, final_score, final_rank, accuracy, name, emoji, color
    INTO v_tid, v_tname, v_score, v_rank, v_acc, v_name, v_emoji, v_color
    FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  IF v_tid   <> '00000000-0000-0000-0000-000000007ea1' THEN RAISE EXCEPTION 'T1 FAIL: team_id changed on UPDATE (%)', v_tid; END IF;
  IF v_tname <> 'Team Alpha'                            THEN RAISE EXCEPTION 'T2 FAIL: team_name changed on UPDATE (%)', v_tname; END IF;
  RAISE NOTICE '1. UPDATE cannot change team_id (frozen): PASS';
  RAISE NOTICE '2. UPDATE cannot change team_name (frozen): PASS';
  IF v_score <> 999          THEN RAISE EXCEPTION 'T3 FAIL: final_score NOT updated (%) — whole-row freeze!', v_score; END IF;
  RAISE NOTICE '3. UPDATE CAN change final_score: PASS';
  IF v_rank  <> 7            THEN RAISE EXCEPTION 'T4 FAIL: final_rank NOT updated (%)', v_rank; END IF;
  RAISE NOTICE '4. UPDATE CAN change final_rank: PASS';
  IF v_acc   <> 42           THEN RAISE EXCEPTION 'T5 FAIL: accuracy NOT updated (%)', v_acc; END IF;
  RAISE NOTICE '5. UPDATE CAN change accuracy: PASS';
  IF v_name <> 'A1-renamed' OR v_emoji <> '🦊' OR v_color <> '#999' THEN RAISE EXCEPTION 'T6 FAIL: name/emoji/color NOT updated (% / % / %)', v_name, v_emoji, v_color; END IF;
  RAISE NOTICE '6. UPDATE CAN change name/emoji/color: PASS';

  -- ══ 7: updating a guest/null-team row succeeds; team stays null ══
  UPDATE public.game_players SET final_score=71, accuracy=55, team_id='00000000-0000-0000-0000-000000007ea1', team_name='SPOOF'
   WHERE player_id='Guest Dave';
  SELECT team_id, team_name, final_score, accuracy INTO v_tid, v_tname, v_score, v_acc
    FROM public.game_players WHERE player_id='Guest Dave';
  IF v_tid IS NOT NULL OR v_tname IS NOT NULL THEN RAISE EXCEPTION 'T7 FAIL: guest null-team became attributed (% / %)', v_tid, v_tname; END IF;
  IF v_score <> 71 OR v_acc <> 55 THEN RAISE EXCEPTION 'T7 FAIL: guest non-team fields not updated (% / %)', v_score, v_acc; END IF;
  RAISE NOTICE '7. non-team update on guest/null-team row succeeds; team stays null: PASS';

  -- ══ 8: team transfer AFTER insertion does not rewrite the snapshot ══
  UPDATE public.profiles SET team_id='00000000-0000-0000-0000-000000007ea2' WHERE id='00000000-0000-0000-0000-0000000000a1';  -- Alpha → Beta
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea1' OR v_tname <> 'Team Alpha' THEN RAISE EXCEPTION 'T8 FAIL: transfer rewrote snapshot (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '8. team transfer after insertion does not rewrite the snapshot: PASS';

  -- ══ 9: a NEW later game captures the transferred (new) team ══
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a1','A1-later',100,1);
  SELECT team_id INTO v_tid FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a1' AND name='A1-later';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea2' THEN RAISE EXCEPTION 'T9 FAIL: new game did not capture transferred team (%)', v_tid; END IF;
  RAISE NOTICE '9. a new later game captures the transferred team: PASS';

  -- ══ 10: client-supplied team values on INSERT are ignored (server stamps from profile) ══
  -- a2 is on Team Beta; the client lies "Team Alpha / SPOOFED"
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank, team_id, team_name)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','A2',90,2,
            '00000000-0000-0000-0000-000000007ea1','SPOOFED');
  SELECT team_id, team_name INTO v_tid, v_tname FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a2';
  IF v_tid <> '00000000-0000-0000-0000-000000007ea2' OR v_tname <> 'Team Beta' THEN RAISE EXCEPTION 'T10 FAIL: client team value not overridden (% / %)', v_tid, v_tname; END IF;
  RAISE NOTICE '10. client-supplied team values on INSERT ignored; server stamps from profile: PASS';

  -- also confirm cross-tenant + no-team INSERT paths → null (identity/tenant validation)
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000b1','B1',60,4);   -- cross-tenant
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a3','A3',55,5);   -- no team
  IF (SELECT team_id FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000b1') IS NOT NULL THEN RAISE EXCEPTION 'T10b FAIL: cross-tenant stamped a team'; END IF;
  IF (SELECT team_id FROM public.game_players WHERE player_id='00000000-0000-0000-0000-0000000000a3') IS NOT NULL THEN RAISE EXCEPTION 'T10c FAIL: no-team player stamped a team'; END IF;
  RAISE NOTICE '    cross-tenant identity → null; no-team player → null (tenant/identity validated): PASS';

  -- ══ 11: no historical backfill — a row inserted with the trigger DISABLED stays
  --        null AND stays null through a later non-team UPDATE ══
  ALTER TABLE public.game_players DISABLE TRIGGER trg_game_players_stamp_team;
  INSERT INTO public.game_players (session_id, tenant_id, player_id, name, final_score, final_rank)
    VALUES ('00000000-0000-0000-0000-0000000ffff1','00000000-0000-0000-0000-0000000000a0','00000000-0000-0000-0000-0000000000a2','A2-legacy',50,6);
  ALTER TABLE public.game_players ENABLE TRIGGER trg_game_players_stamp_team;
  IF (SELECT team_id FROM public.game_players WHERE name='A2-legacy') IS NOT NULL THEN RAISE EXCEPTION 'T11 FAIL: legacy row backfilled on insert'; END IF;
  UPDATE public.game_players SET final_score=51 WHERE name='A2-legacy';   -- non-team update must NOT backfill
  SELECT team_id, final_score INTO v_tid, v_score FROM public.game_players WHERE name='A2-legacy';
  IF v_tid IS NOT NULL THEN RAISE EXCEPTION 'T11 FAIL: legacy row team backfilled on update'; END IF;
  IF v_score <> 51 THEN RAISE EXCEPTION 'T11 FAIL: legacy row non-team update discarded (%)', v_score; END IF;
  RAISE NOTICE '11. no historical backfill (legacy row stays null on insert + non-team update; the update still applies): PASS';

  -- ══ 12: basic Ralli Live persistence still works (insert + read a normal result row) ══
  IF (SELECT count(*) FROM public.game_players WHERE session_id='00000000-0000-0000-0000-0000000ffff1') < 6 THEN RAISE EXCEPTION 'T12 FAIL: game_players persistence broken'; END IF;
  RAISE NOTICE '12. game_players persistence intact (broader Ralli Live regressions run separately): PASS';

  RAISE NOTICE '071 ALL TESTS PASSED';
END $$;

ROLLBACK;
