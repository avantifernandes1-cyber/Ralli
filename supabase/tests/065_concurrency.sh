#!/usr/bin/env bash
# Genuine two-session concurrency proof for migration 065, against the LOCAL
# supabase DB with committed fixtures so two independent psql connections truly
# interleave. The assign path is the CANONICAL create_assignments_atomic RPC
# (raw client INSERT is closed by 065 §8), so these prove the real production path.
#
# DETERMINISTIC ORDERING: session A acquires its lock (archive/restore row lock,
# or the RPC's content advisory lock), then takes advisory 999 as a "ready" flag,
# then sleeps holding everything. Session B spins until advisory 999 is held —
# A provably holds its lock by then — then runs; we MEASURE whether B blocks.
#
# Proves:
#   S1 archive-first        → RPC assign waits, then FAILS (guard sees archived).
#   S2 assign-first (RPC)   → archive waits, then CANCELS the raced-in assignment.
#   S3 restore-first        → RPC assign waits, then SUCCEEDS (guard sees active).
#   S5 same learner+content → two concurrent RPC ⇒ exactly ONE active, loser skipped.
#   S6 diff learners+content→ two concurrent RPC ⇒ BOTH succeed (separate rows).
# Local only. Self-cleaning.
set -uo pipefail
DB=(docker exec -i supabase_db_wt-learn psql -U postgres -d postgres -qtAX)
CT=00000000-0000-0000-0000-0000000000c0
MG=00000000-0000-0000-0000-0000000000c9
LN=00000000-0000-0000-0000-0000000000c1
LN2=00000000-0000-0000-0000-0000000000c2
Q1=00000000-0000-0000-0000-0000000fc001   # active → archived in S1
Q2=00000000-0000-0000-0000-0000000fc002   # active (assign-first)
Q3=00000000-0000-0000-0000-0000000fc003   # archived → restored in S3
Q5=00000000-0000-0000-0000-0000000fc005   # active (dup-active scenarios)
JWT_MG='{"sub":"'"$MG"'","role":"authenticated"}'
FAIL=0
elapsed(){ awk "BEGIN{print $2-$1}"; }
q(){ "${DB[@]}" <<<"$1"; }
wait_ready(){ until [ "$(q "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=0 AND objid=999 AND objsubid=1;")" = "1" ]; do sleep 0.05; done; }
# Foreground canonical assign via RPC (may block). Echoes 'ok:<json>' or 'err:<msg>'.
assign_rpc(){ # $1=quiz $2=user
  "${DB[@]}" 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT 'ok:'||public.create_assignments_atomic('$CT','quiz','$1',
  '[{"userId":"$2","userName":"U"}]'::jsonb,'Open',false,'$MG','individual',NULL,NULL)::text;
COMMIT;
SQL
}

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
 ('$Q1','$CT','CQ1','active'),('$Q2','$CT','CQ2','active'),
 ('$Q3','$CT','CQ3','archived'),('$Q5','$CT','CQ5','active') ON CONFLICT DO NOTHING;
SQL

# ── S1 archive-first → RPC assign waits then fails ───────────────────────────
echo "── S1 archive-first (assign via RPC) ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.archive_quiz('$Q1'); SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S1OUT=$(assign_rpc "$Q1" "$LN"); t1=$(date +%s.%N); wait
S1EL=$(elapsed "$t0" "$t1")
S1CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q1' AND cancelled_at IS NULL;")
echo "   assign elapsed=${S1EL}s out=[${S1OUT//$'\n'/ }] active_rows=$S1CNT"
{ awk "BEGIN{exit !($S1EL>1.0)}" && echo "$S1OUT" | grep -q "assignment blocked" && [ "$S1CNT" = "0" ]; } \
  && echo "   S1 PASS: RPC assign blocked ${S1EL}s then rejected; no active row" || { echo "   S1 FAIL"; FAIL=1; }

# ── S2 assign-first (RPC) → archive waits then cancels the raced-in row ───────
echo "── S2 assign-first (RPC) ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.create_assignments_atomic('$CT','quiz','$Q2','[{"userId":"$LN","userName":"U"}]'::jsonb,'Open',false,'$MG','individual',NULL,NULL);
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
S2ROW=$(q "SELECT COALESCE(cancelled_reason,'(active)') FROM public.tenant_assignments WHERE content_id='$Q2' AND (assigned_to->>'userId')='$LN' ORDER BY assigned_at DESC LIMIT 1;")
echo "   archive elapsed=${S2EL}s assignment_state=[$S2ROW]"
{ awk "BEGIN{exit !($S2EL>1.0)}" && [ "$S2ROW" = "content_archived" ]; } \
  && echo "   S2 PASS: archive waited ${S2EL}s then cancelled the raced-in RPC assignment" || { echo "   S2 FAIL"; FAIL=1; }

# ── S3 restore-first → RPC assign waits then succeeds ────────────────────────
echo "── S3 restore-first (assign via RPC) ──"
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.restore_quiz('$Q3'); SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S3OUT=$(assign_rpc "$Q3" "$LN"); t1=$(date +%s.%N); wait
S3EL=$(elapsed "$t0" "$t1")
S3CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q3' AND cancelled_at IS NULL;")
echo "   assign elapsed=${S3EL}s active_rows=$S3CNT out=[${S3OUT//$'\n'/ }]"
{ awk "BEGIN{exit !($S3EL>1.0)}" && echo "$S3OUT" | grep -q "assignedCount.*1" && [ "$S3CNT" = "1" ]; } \
  && echo "   S3 PASS: RPC assign blocked ${S3EL}s then succeeded after restore" || { echo "   S3 FAIL"; FAIL=1; }

# ── S5 same learner + same content: two concurrent RPC ⇒ exactly ONE active ──
echo "── S5 same learner + same content (duplicate-active protection) ──"
q "DELETE FROM public.tenant_assignments WHERE content_id='$Q5';" >/dev/null
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.create_assignments_atomic('$CT','quiz','$Q5','[{"userId":"$LN","userName":"U"}]'::jsonb,'Open',false,'$MG','individual',NULL,NULL);
SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S5OUT=$(assign_rpc "$Q5" "$LN"); t1=$(date +%s.%N); wait
S5EL=$(elapsed "$t0" "$t1")
S5CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q5' AND (assigned_to->>'userId')='$LN' AND cancelled_at IS NULL;")
echo "   loser elapsed=${S5EL}s out=[${S5OUT//$'\n'/ }] active_rows=$S5CNT"
{ awk "BEGIN{exit !($S5EL>1.0)}" && echo "$S5OUT" | grep -q "skippedCount.*1" && echo "$S5OUT" | grep -q "assignedCount.*0" && [ "$S5CNT" = "1" ]; } \
  && echo "   S5 PASS: loser blocked ${S5EL}s on advisory lock, re-evaluated → skipped; exactly ONE active row" || { echo "   S5 FAIL"; FAIL=1; }

# ── S6 different learners + same content: two concurrent RPC ⇒ BOTH succeed ───
echo "── S6 different learners + same content ──"
q "DELETE FROM public.tenant_assignments WHERE content_id='$Q5';" >/dev/null
( "${DB[@]}" >/dev/null 2>&1 <<SQL
BEGIN; SELECT set_config('request.jwt.claims','$JWT_MG',true);
SELECT public.create_assignments_atomic('$CT','quiz','$Q5','[{"userId":"$LN","userName":"U"}]'::jsonb,'Open',false,'$MG','individual',NULL,NULL);
SELECT pg_advisory_lock(999); SELECT pg_sleep(2); COMMIT;
SQL
) &
wait_ready
t0=$(date +%s.%N); S6OUT=$(assign_rpc "$Q5" "$LN2"); t1=$(date +%s.%N); wait
S6EL=$(elapsed "$t0" "$t1")
S6CNT=$(q "SELECT count(*) FROM public.tenant_assignments WHERE content_id='$Q5' AND cancelled_at IS NULL;")
echo "   second-learner elapsed=${S6EL}s out=[${S6OUT//$'\n'/ }] active_rows=$S6CNT"
{ awk "BEGIN{exit !($S6EL>1.0)}" && echo "$S6OUT" | grep -q "assignedCount.*1" && [ "$S6CNT" = "2" ]; } \
  && echo "   S6 PASS: second learner blocked ${S6EL}s on advisory lock, then inserted; TWO active rows" || { echo "   S6 FAIL"; FAIL=1; }

echo "── teardown ──"
"${DB[@]}" >/dev/null <<SQL
DELETE FROM public.tenant_assignments WHERE tenant_id='$CT';
DELETE FROM public.quiz_attempts WHERE tenant_id='$CT';
DELETE FROM public.tenant_quizzes WHERE tenant_id='$CT';
DELETE FROM public.profiles WHERE tenant_id='$CT';
DELETE FROM auth.users WHERE id IN ('$MG','$LN','$LN2');
DELETE FROM public.tenants WHERE id='$CT';
SQL
[ "$FAIL" = "0" ] && echo "065 CONCURRENCY: ALL SCENARIOS PASSED" || echo "065 CONCURRENCY: FAILURES PRESENT"
exit $FAIL
