#!/usr/bin/env bash
# True two-connection concurrency test for migration 083 v3 (quiz-row locking + triggers).
# Two INDEPENDENT psql connections interleave via server-side pg_sleep barriers. No app, no prod.
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
CN=pgconc
Q='00000000-0000-0000-0000-0000000000c1'   # quiz id
T='00000000-0000-0000-0000-0000000000aa'   # tenant id
S='00000000-0000-0000-0000-000000000501'   # seeded waiting session id
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  expected[$3] got[$2]"; fi; }
has(){ if echo "$2" | grep -qi "$3"; then PASS=$((PASS+1)); echo "PASS  $1  (saw '$3')"; else FAIL=$((FAIL+1)); echo "FAIL  $1  ('$3' not in: $(echo "$2"|tr '\n' ' '))"; fi; }

q(){ docker exec -e PGPASSWORD=postgres "$CN" psql -U postgres -d test -v ON_ERROR_STOP=0 -tA "$@"; }

echo "== boot postgres container =="
docker rm -f "$CN" >/dev/null 2>&1
docker run -d --name "$CN" -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=test postgres:16-alpine >/dev/null
# The postgres image boots a THROWAWAY init server (1st "ready to accept connections") then
# RESTARTS the real one (2nd). Anything loaded during the 1st is lost — wait for the 2nd.
n=0; until [ "$(docker logs "$CN" 2>&1 | grep -c 'ready to accept connections')" -ge 2 ]; do n=$((n+1)); [ $n -gt 100000 ] && { echo "db never ready"; exit 1; }; done
n=0; until docker exec -e PGPASSWORD=postgres "$CN" pg_isready -U postgres -d test >/dev/null 2>&1; do n=$((n+1)); [ $n -gt 100000 ] && { echo "db never ready"; exit 1; }; done
docker cp "$DIR/083_concurrency_schema.sql" "$CN":/schema.sql >/dev/null
# Load, then verify the schema actually persisted on the real server (retry if not).
n=0
until [ "$(q -tAc "SELECT to_regclass('public.game_sessions') IS NOT NULL;" 2>/dev/null)" = "t" ]; do
  q -f /schema.sql >/tmp/load.out 2>&1
  n=$((n+1)); [ $n -gt 60 ] && { echo "schema load failed:"; cat /tmp/load.out; exit 1; }
done
echo "schema loaded + verified"

reset_quiz(){ q -c "TRUNCATE public.game_sessions; DELETE FROM public.tenant_quizzes; INSERT INTO public.tenant_quizzes(id,tenant_id,status) VALUES ('$Q','$T','active');" >/dev/null; }
reset_sess(){ reset_quiz; q -c "INSERT INTO public.game_sessions(id,tenant_id,quiz_id,pin,name,status,demo_mode,question_snapshot,live_question) VALUES ('$S','$T','$Q','111111','S','waiting',false,'[{\"q\":1}]'::jsonb,'{\"live\":1}'::jsonb);" >/dev/null; }
sess_status(){ q -c "SELECT status FROM public.game_sessions WHERE id='$S';"; }
sess_count(){ q -c "SELECT count(*) FROM public.game_sessions;"; }
quiz_count(){ q -c "SELECT count(*) FROM public.tenant_quizzes;"; }
first_status(){ q -c "SELECT status FROM public.game_sessions ORDER BY created_at LIMIT 1;"; }

echo; echo "== S1: Create wins first, then Archive → session created then canceled by trigger =="
reset_quiz
q -c "BEGIN; SELECT create_game_session_atomic('$T','h','$Q','S',1,false); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o1=$(q -c "SELECT pg_sleep(1); UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q';" 2>&1)
wait
ok "S1 one session exists"       "$(sess_count)"  "1"
ok "S1 session canceled by trigger" "$(first_status)" "canceled"
[ -z "$(echo "$o1"|grep -i 'deadlock')" ] && { PASS=$((PASS+1)); echo "PASS  S1 no deadlock"; } || { FAIL=$((FAIL+1)); echo "FAIL  S1 deadlock: $o1"; }

echo; echo "== S2: Archive wins first, then Create → create waits, rechecks, rejects (0 rows) =="
reset_quiz
q -c "BEGIN; UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q'; SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o2=$(q -c "SELECT pg_sleep(1); SELECT create_game_session_atomic('$T','h','$Q','S',1,false);" 2>&1)
wait
has "S2 create rejected quiz_unavailable" "$o2" "quiz_unavailable"
ok  "S2 zero sessions created"            "$(sess_count)" "0"

echo; echo "== S3: Start wins first, then Archive → started game NOT terminated by later archive =="
reset_sess
q -c "BEGIN; SELECT rpc_start_session('$S'); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o3=$(q -c "SELECT pg_sleep(1); UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q';" 2>&1)
wait
ok "S3 session stays started" "$(sess_status)" "started"

echo; echo "== S4: Archive wins first, then Start → cannot revive; returns quiz_unavailable =="
reset_sess
q -c "BEGIN; UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q'; SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o4=$(q -c "SELECT pg_sleep(1); SELECT rpc_start_session('$S');" 2>&1)
wait
ok  "S4 session stays canceled (no revive)" "$(sess_status)" "canceled"
has "S4 start returned quiz_unavailable"    "$o4" "quiz_unavailable"

echo; echo "== S5: Delete wins first, then Start → BEFORE-DELETE trigger canceled it; no revive =="
reset_sess
q -c "BEGIN; DELETE FROM public.tenant_quizzes WHERE id='$Q'; SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o5=$(q -c "SELECT pg_sleep(1); SELECT rpc_start_session('$S');" 2>&1)
wait
ok "S5 session canceled (before delete)" "$(sess_status)" "canceled"
ok "S5 quiz hard-deleted"                "$(quiz_count)"  "0"

echo; echo "== S6: Create wins first, then Delete → created session canceled by BEFORE-DELETE trigger =="
reset_quiz
q -c "BEGIN; SELECT create_game_session_atomic('$T','h','$Q','S',1,false); SELECT pg_sleep(3); COMMIT;" >/dev/null 2>&1 &
o6=$(q -c "SELECT pg_sleep(1); DELETE FROM public.tenant_quizzes WHERE id='$Q';" 2>&1)
wait
ok "S6 created session canceled" "$(first_status)" "canceled"
ok "S6 quiz hard-deleted"        "$(quiz_count)"  "0"

echo; echo "== S7: concurrent burst (no barriers) → no deadlock, no orphan waiting-on-inactive =="
reset_quiz
burst=""
for i in 1 2 3 4 5 6; do
  q -c "SELECT create_game_session_atomic('$T','h','$Q','S$i',1,false);" >/tmp/c$i.out 2>&1 &
  q -c "UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q' AND status='active'; UPDATE public.tenant_quizzes SET status='active' WHERE id='$Q' AND status='archived';" >/tmp/a$i.out 2>&1 &
done
wait
dl=$(cat /tmp/c*.out /tmp/a*.out | grep -i 'deadlock' | head -1)
[ -z "$dl" ] && { PASS=$((PASS+1)); echo "PASS  S7 no deadlock across burst"; } || { FAIL=$((FAIL+1)); echo "FAIL  S7 deadlock: $dl"; }
# invariant: no non-demo waiting session whose quiz is not active-same-tenant
orph=$(q -c "SELECT count(*) FROM public.game_sessions s WHERE s.demo_mode=false AND s.status='waiting' AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=s.quiz_id AND q.tenant_id::text=s.tenant_id AND q.status='active');")
# NOTE: final quiz status is 'active' (even # of flips), so active-quiz waiting sessions are allowed;
# the invariant we assert is that IF the quiz ended inactive there are no waiting orphans. Assert by
# forcing a final archive and confirming all waiting sessions cancel.
q -c "UPDATE public.tenant_quizzes SET status='archived' WHERE id='$Q' AND status='active';" >/dev/null 2>&1
orph2=$(q -c "SELECT count(*) FROM public.game_sessions s WHERE s.demo_mode=false AND s.status='waiting' AND NOT EXISTS (SELECT 1 FROM public.tenant_quizzes q WHERE q.id::text=s.quiz_id AND q.tenant_id::text=s.tenant_id AND q.status='active');")
ok "S7 zero waiting orphans after final archive" "$orph2" "0"

echo; echo "== cleanup =="
docker rm -f "$CN" >/dev/null 2>&1
echo; echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] && echo "083 CONCURRENCY: ALL PASSED" || echo "083 CONCURRENCY: FAILURES"
