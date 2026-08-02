#!/usr/bin/env bash
# True two-connection concurrency + idempotency test for migration 081 (scoreboard recovery),
# applying the EXACT committed migration file after a minimal prelude. lock_timeout/statement_timeout
# make any deadlock/hang FAIL. Two independent connections; server-side pg_sleep barriers.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
MIG="$DIR/../wt-leaderboard/supabase/migrations/081_ralli_live_scoreboard_recovery.sql"
CN=pgsb
S='00000000-0000-0000-0000-0000008100e1'; T='00000000-0000-0000-0000-0000000000aa'
P1='00000000-0000-0000-0000-000000081002'; P2='00000000-0000-0000-0000-000000081003'
SC="[{\"id\":\"$P1\",\"score\":100},{\"id\":\"$P2\",\"score\":80}]"
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  exp[$3] got[$2]"; fi; }
has(){ if echo "$2" | grep -qi "$3"; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1  ('$3' not in: $(echo "$2"|tr '\n' ' '))"; fi; }
q(){ docker exec -e PGPASSWORD=postgres -e PGOPTIONS='-c lock_timeout=15000 -c statement_timeout=30000' "$CN" psql -U postgres -d test -v ON_ERROR_STOP=0 -tA "$@"; }

echo "== boot =="; docker rm -f "$CN" >/dev/null 2>&1
docker run -d --name "$CN" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test postgres:16-alpine >/dev/null
n=0; until [ "$(docker logs "$CN" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do n=$((n+1)); [ $n -gt 100000 ] && { echo nodb; exit 1; }; done
n=0; until docker exec -e PGPASSWORD=postgres "$CN" pg_isready -U postgres -d test >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100000 ] && { echo nodb; exit 1; }; done
docker cp "$DIR/081_scoreboard_prelude.sql" "$CN":/p.sql >/dev/null
docker cp "$MIG" "$CN":/m081.sql >/dev/null
n=0; until [ "$(q -tAc "SELECT to_regclass('public.game_sessions') IS NOT NULL;" 2>/dev/null)" = "t" ]; do q -f /p.sql >/tmp/p.out 2>&1; n=$((n+1)); [ $n -gt 60 ] && { echo "prelude failed"; cat /tmp/p.out; exit 1; }; done
q -f /m081.sql >/tmp/m.out 2>&1
ok "migration 081 applied (publish fn present)" "$(q -tAc "SELECT to_regprocedure('public.rpc_publish_scoreboard(uuid,integer,jsonb,text)') IS NOT NULL;")" "t"
ok "publish fn locks session row (FOR UPDATE in body)" "$(q -tAc "SELECT pg_get_functiondef('public.rpc_publish_scoreboard(uuid,integer,jsonb,text)'::regprocedure) LIKE '%FOR UPDATE%';")" "t"

seed(){ q -c "TRUNCATE public.game_sessions; TRUNCATE public.game_session_participants;
  INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,phase,current_question_index,demo_mode,question_snapshot) VALUES ('$S','$T','q','h','111','started','reveal',0,false,'[{}]');
  INSERT INTO public.game_session_participants(session_id,player_id,tenant_id,name,emoji) VALUES ('$S','$P1','$T','Ann',NULL),('$S','$P2','$T','Bob','X');" >/dev/null; }
ver(){ q -c "SELECT scoreboard_version FROM public.game_sessions WHERE id='$S';"; }
phase(){ q -c "SELECT phase FROM public.game_sessions WHERE id='$S';"; }

echo; echo "== S1: same-key concurrent publish → ONE version increment; both get the same board =="
seed
q -c "BEGIN; SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'); SELECT pg_sleep(3); COMMIT;" >/tmp/t1.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT (rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'))->>'version';" 2>&1); wait
ok  "S1 final version = 1 (idempotent)" "$(ver)" "1"
has "S1 second call returned version 1"  "$o2" "^1$"

echo; echo "== S2: different-key concurrent publish → one wins; loser rejected; version stays 1 =="
seed
q -c "BEGIN; SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'); SELECT pg_sleep(3); COMMIT;" >/tmp/t1.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-2');" 2>&1); wait
ok  "S2 final version = 1 (loser did not overwrite)" "$(ver)" "1"
has "S2 different-key loser rejected"  "$o2" "already published"

echo; echo "== S3: lost-response retry — publish commits, same-key retry returns stored board, version unchanged =="
seed
v1=$(q -c "SELECT (rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'))->>'version';")
v2=$(q -c "SELECT (rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'))->>'version';")   # simulated retry after lost response
ok "S3 first publish version 1"    "$v1" "1"
ok "S3 same-key retry version 1 (idempotent, no bump)" "$v2" "1"
ok "S3 durable version still 1"    "$(ver)" "1"

echo; echo "== S4: failed publish (wrong phase) then retry same key after fix → succeeds once =="
seed
q -c "UPDATE public.game_sessions SET phase='countdown' WHERE id='$S';" >/dev/null
of=$(q -c "SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1');" 2>&1)
q -c "UPDATE public.game_sessions SET phase='reveal' WHERE id='$S';" >/dev/null
vr=$(q -c "SELECT (rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'))->>'version';")
has "S4 wrong-phase publish rejected" "$of" "publishable phase"
ok  "S4 retry after fix succeeds (version 1)" "$vr" "1"

echo; echo "== S5: publish vs next-question(countdown) — deterministic; countdown clears board =="
seed
q -c "BEGIN; SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'); SELECT pg_sleep(3); COMMIT;" >/tmp/t1.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT rpc_set_session_phase('$S','countdown',true,1,false,false,false,NULL);" 2>&1); wait
ok "S5 phase countdown after both commit" "$(phase)" "countdown"
ok "S5 board cleared by countdown" "$(q -c "SELECT live_scoreboard IS NULL FROM public.game_sessions WHERE id='$S';")" "t"

echo; echo "== S6: publish vs end — end wins terminal; no scoreboard survives =="
seed
q -c "BEGIN; SELECT rpc_publish_scoreboard('$S',0,'$SC'::jsonb,'EPISODE-KEY-1'); SELECT pg_sleep(3); COMMIT;" >/tmp/t1.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT rpc_end_session('$S');" 2>&1); wait
ok "S6 status completed" "$(q -c "SELECT status FROM public.game_sessions WHERE id='$S';")" "completed"
ok "S6 board cleared on end" "$(q -c "SELECT live_scoreboard IS NULL FROM public.game_sessions WHERE id='$S';")" "t"

echo; echo "== deadlock/timeout scan across all scenario outputs =="
dl=$(cat /tmp/t1.out /tmp/m.out 2>/dev/null | grep -i 'deadlock\|canceling statement' | head -1)
[ -z "$dl" ] && { PASS=$((PASS+1)); echo "PASS  no deadlock/timeout"; } || { FAIL=$((FAIL+1)); echo "FAIL  $dl"; }

docker rm -f "$CN" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "081 SCOREBOARD CONCURRENCY: ALL PASSED" || echo "081 SCOREBOARD CONCURRENCY: FAILURES"
