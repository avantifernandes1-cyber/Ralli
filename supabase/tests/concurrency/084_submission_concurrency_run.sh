#!/usr/bin/env bash
# True two-connection concurrency test for migration 084 (durable answer submission),
# applying the EXACT committed migration after a minimal prelude. lock_timeout/statement_timeout
# make any deadlock/hang FAIL. Proves: concurrent identical submit → one row; concurrent conflicting
# submit → one wins; submit-vs-reveal deterministic (reveal lock closes submissions).
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
WT="$DIR/../../.."
MIG="$WT/supabase/migrations/084_ralli_canonical_roster_durable_answers.sql"
PRELUDE="/private/tmp/claude-501/-Users-avantifernandes-Documents/77f65a63-082f-49ce-889e-826cba7f149b/scratchpad/084_preflight/prelude.sql"
CN=pg084c
S='00000000-0000-0000-0000-0000008400e1'; T='00000000-0000-0000-0000-0000000840a0'
M='00000000-0000-0000-0000-000000084001'; U1='00000000-0000-0000-0000-000000084002'
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  exp[$3] got[$2]"; fi; }
has(){ if echo "$2" | grep -qi "$3"; then PASS=$((PASS+1)); echo "PASS  $1"; else FAIL=$((FAIL+1)); echo "FAIL  $1  ('$3' not in: $(echo "$2"|tr '\n' ' ')) "; fi; }
q(){ docker exec -e PGPASSWORD=postgres -e PGOPTIONS='-c lock_timeout=15000 -c statement_timeout=30000' "$CN" psql -U postgres -d test -v ON_ERROR_STOP=0 -tA "$@"; }

docker rm -f "$CN" >/dev/null 2>&1
docker run -d --name "$CN" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test postgres:16-alpine >/dev/null
until [ "$(docker logs "$CN" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do :; done
until docker exec -e PGPASSWORD=postgres "$CN" pg_isready -U postgres -d test >/dev/null 2>&1; do :; done
docker cp "$PRELUDE" "$CN":/p.sql >/dev/null; docker cp "$MIG" "$CN":/m.sql >/dev/null
q -f /p.sql >/dev/null 2>&1; q -f /m.sql >/tmp/m.out 2>&1
ok "084 applied (submit fn present)" "$(q -tAc "SELECT to_regprocedure('public.rpc_submit_game_answer(uuid,integer,jsonb)') IS NOT NULL;")" "t"

seed(){ q -c "
  TRUNCATE public.game_answer_submissions; TRUNCATE public.game_roster_members;
  DELETE FROM public.game_sessions; DELETE FROM public.profiles; DELETE FROM auth.users; DELETE FROM public.tenants; DELETE FROM public.tenant_quizzes;
  INSERT INTO public.tenants(id,name) VALUES ('$T','TA');
  INSERT INTO auth.users(id,aud,role,email) VALUES ('$M','authenticated','authenticated','m'),('$U1','authenticated','authenticated','u1');
  UPDATE public.profiles SET role='orgAdmin',tenant_id='$T',status='active',name='M' WHERE id='$M';
  UPDATE public.profiles SET role='user',tenant_id='$T',status='active',name='U1' WHERE id='$U1';
  INSERT INTO public.tenant_quizzes(id,tenant_id,status) VALUES ('00000000-0000-0000-0000-0000008400a1','$T','active');
  INSERT INTO public.game_sessions(id,tenant_id,quiz_id,host_id,pin,status,phase,current_question_index,demo_mode,question_snapshot,current_question_started_at)
    VALUES ('$S','$T','00000000-0000-0000-0000-0000008400a1','$M','840001','started','question',0,false,
            '[{\"id\":\"q0\",\"type\":\"mc\",\"options\":[\"a\",\"b\"],\"timeLimit\":600}]'::jsonb, now());
  INSERT INTO public.game_roster_members(session_id,tenant_id,player_id,name,status) VALUES ('$S','$T','$U1','U1','active');
" >/dev/null; }
subs(){ q -tAc "SELECT count(*) FROM public.game_answer_submissions WHERE session_id='$S';"; }

echo; echo "== C1: concurrent IDENTICAL submit → exactly ONE row =="
seed
q -c "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$U1\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_submit_game_answer('$S',0,'{\"option_idx\":1}'::jsonb); SELECT pg_sleep(3); COMMIT;" >/tmp/c1.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT set_config('request.jwt.claims','{\"sub\":\"$U1\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT (rpc_submit_game_answer('$S',0,'{\"option_idx\":1}'::jsonb))->>'idempotent';" 2>&1); wait
ok  "C1 exactly one submission row" "$(subs)" "1"
has "C1 second identical call idempotent" "$o2" "true"

echo; echo "== C2: concurrent CONFLICTING submit → one wins, one row =="
seed
q -c "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$U1\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_submit_game_answer('$S',0,'{\"option_idx\":1}'::jsonb); SELECT pg_sleep(3); COMMIT;" >/tmp/c2.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT set_config('request.jwt.claims','{\"sub\":\"$U1\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_submit_game_answer('$S',0,'{\"option_idx\":0}'::jsonb);" 2>&1); wait
ok  "C2 exactly one submission row" "$(subs)" "1"
has "C2 conflicting loser rejected" "$o2" "already locked"

echo; echo "== C3: submit vs reveal → reveal closes; late submit rejected as stale =="
seed
q -c "BEGIN; SELECT set_config('request.jwt.claims','{\"sub\":\"$M\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_begin_question_reveal('$S',0); SELECT pg_sleep(3); COMMIT;" >/tmp/c3.out 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT set_config('request.jwt.claims','{\"sub\":\"$U1\",\"role\":\"authenticated\"}',true); SET LOCAL ROLE authenticated; SELECT rpc_submit_game_answer('$S',0,'{\"option_idx\":1}'::jsonb);" 2>&1); wait
ok  "C3 phase is reveal after both commit" "$(q -tAc "SELECT phase FROM public.game_sessions WHERE id='$S';")" "reveal"
ok  "C3 no submission survived (closed by reveal)" "$(subs)" "0"
has "C3 late submit rejected as stale" "$o2" "answerable phase"

echo; echo "== deadlock/timeout scan =="
dl=$(cat /tmp/c1.out /tmp/c2.out /tmp/c3.out /tmp/m.out 2>/dev/null | grep -i 'deadlock\|canceling statement' | head -1)
[ -z "$dl" ] && { PASS=$((PASS+1)); echo "PASS  no deadlock/timeout"; } || { FAIL=$((FAIL+1)); echo "FAIL  $dl"; }
docker rm -f "$CN" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "084 SUBMISSION CONCURRENCY: ALL PASSED" || echo "084 SUBMISSION CONCURRENCY: FAILURES"
