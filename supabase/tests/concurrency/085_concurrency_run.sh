#!/usr/bin/env bash
# True two-connection concurrency test for migration 085 (Ralli Live leaderboard foundation),
# applying the EXACT committed migration after a minimal prelude. lock_timeout/statement_timeout
# make any deadlock/hang FAIL. Proves: concurrent question-start phase calls insert each durably-
# active learner's exposure EXACTLY ONCE (idempotent under race); concurrent completion transitions
# enqueue a session for verification EXACTLY ONCE (no duplicate outbox row).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
WT="$DIR/../../.."
MIG="$WT/supabase/migrations/085_ralli_live_leaderboard_foundation.sql"
PRELUDE="$DIR/085_leaderboard_prelude.sql"
CN=pg085c
S='00000000-0000-0000-0000-0000008500e1'; T='00000000-0000-0000-0000-0000000850a0'
M='00000000-0000-0000-0000-000000085001'; U1='00000000-0000-0000-0000-000000085002'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  exp[$3] got[$2]"; fi; }
q(){ docker exec -e PGPASSWORD=postgres -e PGOPTIONS='-c lock_timeout=15000 -c statement_timeout=30000' "$CN" psql -U postgres -d test -v ON_ERROR_STOP=0 -tA "$@"; }

docker rm -f "$CN" >/dev/null 2>&1
docker run -d --name "$CN" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test postgres:16-alpine >/dev/null
until [ "$(docker logs "$CN" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do :; done
until docker exec -e PGPASSWORD=postgres "$CN" pg_isready -U postgres -d test >/dev/null 2>&1; do :; done
docker cp "$PRELUDE" "$CN":/p.sql >/dev/null; docker cp "$MIG" "$CN":/m.sql >/dev/null
q -f /p.sql >/dev/null 2>&1; q -f /m.sql >/tmp/m085.out 2>&1
ok "085 applied (exposure table present)" "$(q -tAc "SELECT to_regclass('public.game_question_exposures') IS NOT NULL;")" "t"
ok "085 applied (individuals RPC present)" "$(q -tAc "SELECT to_regprocedure('public.rpc_ralli_leaderboard_individuals(timestamptz,timestamptz,uuid)') IS NOT NULL;")" "t"

seedq(){ q -c "
  TRUNCATE public.game_question_exposures; DELETE FROM public.game_verification_queue;
  DELETE FROM public.game_session_participants; DELETE FROM public.game_roster_members;
  DELETE FROM public.game_sessions; DELETE FROM public.profiles; DELETE FROM auth.users; DELETE FROM public.tenants;
  INSERT INTO public.tenants(id,name) VALUES ('$T','TA');
  INSERT INTO auth.users(id,aud,role,email) VALUES ('$M','authenticated','authenticated','m'),('$U1','authenticated','authenticated','u1');
  UPDATE public.profiles SET role='orgAdmin',tenant_id='$T',status='active',name='M' WHERE id='$M';
  UPDATE public.profiles SET role='user',tenant_id='$T',status='active',name='U1' WHERE id='$U1';
  INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,phase,current_question_index,demo_mode,question_snapshot,current_question_started_at)
    VALUES ('$S','$T','q','$M','850001','started','countdown',0,false,
            '[{\"id\":\"q0\",\"type\":\"mc\",\"options\":[\"a\",\"b\"],\"timeLimit\":600}]'::jsonb, now());
  INSERT INTO public.game_roster_members(session_id,tenant_id,player_id,name,status) VALUES ('$S','$T','$U1','U1','active');
  INSERT INTO public.game_session_participants(session_id,tenant_id,player_id,status,last_seen_at) VALUES ('$S','$T','$U1','active', now());
" >/dev/null; }
expcnt(){ q -tAc "SELECT count(*) FROM public.game_question_exposures WHERE session_id='$S';"; }
qcnt(){ q -tAc "SELECT count(*) FROM public.game_verification_queue WHERE session_id='$S';"; }

echo; echo "== CC1: concurrent question-start phase calls → each active learner exposed EXACTLY once =="
seedq
q -c "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$M\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_set_session_phase('$S','question',true,0,false,false,true,'{}'::jsonb); SELECT pg_sleep(3); COMMIT;" >/tmp/cc1.out 2>&1 &
q -c "SELECT pg_sleep(1); BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$M\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_set_session_phase('$S','question',true,0,false,false,true,'{}'::jsonb); COMMIT;" >/tmp/cc1b.out 2>&1; wait
ok "CC1 exactly one exposure row (idempotent under race)" "$(expcnt)" "1"

echo; echo "== CC2: concurrent completion transitions → session enqueued EXACTLY once =="
seedq
q -c "BEGIN; UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id='$S'; SELECT pg_sleep(3); COMMIT;" >/tmp/cc2.out 2>&1 &
q -c "SELECT pg_sleep(1); BEGIN; UPDATE public.game_sessions SET status='completed', ended_at=now() WHERE id='$S'; COMMIT;" >/tmp/cc2b.out 2>&1; wait
ok "CC2 exactly one verification-queue row" "$(qcnt)" "1"

echo; echo "== deadlock/timeout scan =="
dl=$(cat /tmp/cc1.out /tmp/cc1b.out /tmp/cc2.out /tmp/cc2b.out /tmp/m085.out 2>/dev/null | grep -i 'deadlock\|canceling statement' | head -1)
[ -z "$dl" ] && { PASS=$((PASS+1)); echo "PASS  no deadlock/timeout"; } || { FAIL=$((FAIL+1)); echo "FAIL  $dl"; }
docker rm -f "$CN" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "085 LEADERBOARD CONCURRENCY: ALL PASSED" || echo "085 LEADERBOARD CONCURRENCY: FAILURES"
