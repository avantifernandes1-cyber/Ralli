#!/usr/bin/env bash
# Genuine two-session (two-connection) concurrency proof for the migration 065
# content-assignability guard, against the LOCAL supabase DB with committed
# fixtures so two independent psql connections truly interleave.
#
# DETERMINISTIC ORDERING (no timing guesses): session A acquires its CONTENT-row
# lock, then takes advisory lock 999 as a "ready" flag, then sleeps holding both.
# Session B spins until it sees advisory 999 held — at which point A provably
# already holds the content lock — then runs and we MEASURE whether B blocks.
#
# Proves:
#   S1 archive-first  → assign waits, then FAILS (sees archived).
#   S2 assign-first   → archive waits, then CANCELS the raced-in assignment.
#   S3 restore-first  → assign waits, then SUCCEEDS (sees active).
#   S4 two assigns    → do NOT block each other (FOR SHARE compatible), both insert.
# Local only. Self-cleaning.
set -uo pipefail
DB=(docker exec -i supabase_db_wt-learn psql -U postgres -d postgres -qtAX)
CT=00000000-0000-0000-0000-0000000000c0
MG=00000000-0000-0000-0000-0000000000c9
LN=00000000-0000-0000-0000-0000000000c1
LN2=00000000-0000-0000-0000-0000000000c2
Q1=00000000-0000-0000-0000-0000000fc001
Q2=00000000-0000-0000-0000-0000000fc002
Q3=00000000-0000-0000-0000-0000000fc003
JWT_MG='{"sub":"'"$MG"'","role":"authenticated"}'
FAIL=0
elapsed(){ awk "BEGIN{print $2-$1}"; }
q(){ "${DB[@]}" <<<"$1"; }
# A takes pg_advisory_lock(999) → pg_locks shows classid=0, objid=999, objsubid=1.
wait_ready(){ until [ "$(q "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=999 AND objsubid=1;")" = "1" ]; do sleep 0.05; done; }

echo "── setup (committed fixtures) ──"
"${DB[@]}" >/dev/null <<SQL
INSERT INTO auth.users (id,aud,role,email,created_at,updated_at) VALUES
 ('$MG','authenticated','authenticated','cmg@t.test',now(),now()),
 ('$LN','authenticated','authenticated','cln@t.test',now(),now()),
 ('$LN2','authenticated','authenticated','cln2@t.test',now(),now()) ON CONFLICT DO NOTHING;
INSERT INTO public.tenants (id,slug,name) VALUES ('$CT','cta','CTA') ON CONFLICT DO NOTHING;
UPDATE public.profiles SET role='manager',tenant_id='$CT',status='active',name='CMG' WHERE id='$MG';
UPDATE public.profiles SET role='user',tenant_id='$CT',status='active',name='CLN' WHERE id='$LN';
UPDATE public.profiles SET role='user',tenant_id='$CT',status='active',name='CLN2' WHERE id='$LN2';
INSERT INTO public.tenant_quizzes (id,tenant_id,name,status) VALUES
 ('$Q1','$CT','CQ1','active'),('$Q2','$CT','CQ2','active'),('$Q3','$CT','CQ3','archived') ON CONFLICT DO NOTHING;
SQL

ins_active_assignment(){ # $1=quiz $2=user  → raw active insert (fires guard)
  "${DB[@]}" 2>&1 <<SQL
INSERT INTO public.tenant_assignments (tenant_id,content_type,content_id,assigned_to,assigned_at)
 VALUES ('$CT','quiz','$1','{"type":"individual","userId":"$2","userName":"U"}'::jsonb, now());
SQL
}

# ── S1 archive-first → assign waits then fails ───────────────────────────────
echo "── S1 archive-first ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.archive_quiz('$Q1'); SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S1OUT=$(ins_active_assignment "$Q1" "$LN"); t1=$(date +%s.%N); wait
S1EL=$(elapsed "$t0" "$t1")
S1CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q1' AND cancelled_at IS NULL;")
echo "   assign elapsed=${S1EL}s active_rows=$S1CNT"
{ awk "BEGIN{exit !($S1EL>1.0)}" && echo "$S1OUT" | grep -q "assignment blocked" && [ "$S1CNT" = "0" ]; } \
  && echo "   S1 PASS: assign blocked ${S1EL}s then rejected; no active row on archived quiz" || { echo "   S1 FAIL [$S1OUT]"; FAIL=1; }

# ── S2 assign-first → archive waits then cancels the raced-in row ─────────────
echo "── S2 assign-first ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN;
INSERT INTO public.tenant_assignments (id,tenant_id,content_type,content_id,assigned_to,assigned_at)
 VALUES ('00000000-0000-0000-0000-0000000fb2a0','$CT','quiz','$Q2','{"type":"individual","userId":"$LN","userName":"U"}'::jsonb, now());
SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N)
"${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true); SELECT public.archive_quiz('$Q2'); COMMIT;
SQL
t1=$(date +%s.%N); wait
S2EL=$(elapsed "$t0" "$t1")
S2ROW=$(q "SELECT COALESCE(cancelled_reason,'(active)') FROM public.tenant_assignments WHERE id='00000000-0000-0000-0000-0000000fb2a0';")
echo "   archive elapsed=${S2EL}s assignment_state=[$S2ROW]"
{ awk "BEGIN{exit !($S2EL>1.0)}" && [ "$S2ROW" = "content_archived" ]; } \
  && echo "   S2 PASS: archive waited ${S2EL}s then cancelled the raced-in assignment" || { echo "   S2 FAIL"; FAIL=1; }

# ── S3 restore-first → assign waits then succeeds ────────────────────────────
echo "── S3 restore-first ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.restore_quiz('$Q3'); SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S3OUT=$(ins_active_assignment "$Q3" "$LN"); t1=$(date +%s.%N); wait
S3EL=$(elapsed "$t0" "$t1")
S3CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q3' AND cancelled_at IS NULL;")
echo "   assign elapsed=${S3EL}s out=[${S3OUT:-ok}] active_rows=$S3CNT"
{ awk "BEGIN{exit !($S3EL>1.0)}" && [ -z "$S3OUT" ] && [ "$S3CNT" = "1" ]; } \
  && echo "   S3 PASS: assign waited ${S3EL}s then succeeded after restore" || { echo "   S3 FAIL"; FAIL=1; }

# ── S4 two concurrent assigns to an active quiz → no mutual block ─────────────
echo "── S4 two concurrent assigns (FOR SHARE compatible) ──"
"${DB[@]}" >/dev/null <<SQL
UPDATE public.tenant_quizzes SET status='active' WHERE id='$Q1';
DELETE FROM public.tenant_assignments WHERE content_id='$Q1';
SQL
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN;
INSERT INTO public.tenant_assignments (tenant_id,content_type,content_id,assigned_to,assigned_at)
 VALUES ('$CT','quiz','$Q1','{"type":"individual","userId":"$LN","userName":"U"}'::jsonb, now());
SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); ins_active_assignment "$Q1" "$LN2" >/dev/null 2>&1; t1=$(date +%s.%N); wait
S4EL=$(elapsed "$t0" "$t1")
S4CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q1' AND cancelled_at IS NULL;")
echo "   second-assign elapsed=${S4EL}s active_rows=$S4CNT"
{ awk "BEGIN{exit !($S4EL<1.0)}" && [ "$S4CNT" = "2" ]; } \
  && echo "   S4 PASS: two FOR SHARE assigns did NOT block (${S4EL}s), both inserted" || { echo "   S4 FAIL"; FAIL=1; }

echo "── teardown ──"
"${DB[@]}" >/dev/null <<SQL
DELETE FROM public.tenant_assignments WHERE tenant_id='$CT';
DELETE FROM public.tenant_quizzes WHERE tenant_id='$CT';
DELETE FROM public.profiles WHERE tenant_id='$CT';
DELETE FROM auth.users WHERE id IN ('$MG','$LN','$LN2');
DELETE FROM public.tenants WHERE id='$CT';
SQL
[ "$FAIL" = "0" ] && echo "065 CONCURRENCY: ALL SCENARIOS PASSED" || echo "065 CONCURRENCY: FAILURES PRESENT"
exit $FAIL
