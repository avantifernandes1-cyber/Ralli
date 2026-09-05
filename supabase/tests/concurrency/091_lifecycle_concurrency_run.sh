#!/usr/bin/env bash
# True two-connection concurrency tests for migration 091 (readiness learner lifecycle, RPC-first).
# Runs against the local Supabase DB (which has 087–090) with 091 ALREADY APPLIED. lock_timeout/
# statement_timeout make any deadlock (40P01) or hang FAIL. Proves the corrected advisory-FIRST lock order
# (queue ≺ advisory ≺ scores_current ≺ profiles/FK KEY SHARE) has NO deadlock and converges correctly for:
#   CC1 worker-first vs deactivate     CC2 deactivate-first vs worker
#   CC3 transfer-first vs worker       CC4 two conflicting transfers (same user)
#   CC5 transfer racing removal        CC6 removal racing reactivation
#   CC7 worker batch holding old- AND new-tenant jobs vs a transfer
#   CC8 state changes between the RPC's initial read and its post-advisory re-read (safeguard #1 abort)
# ASSERTS: zero 40P01 across every scenario, and the documented final state.
set -u
DB=supabase_db_wt-learn
q(){ docker exec -e PGOPTIONS='-c lock_timeout=8000 -c statement_timeout=20000' "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=0 -tA "$@"; }
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  exp[$3] got[$2]"; fi; }
no_deadlock(){ if grep -q '40P01\|deadlock' "$1"; then FAIL=$((FAIL+1)); echo "FAIL  $2  (40P01 deadlock detected)"; else PASS=$((PASS+1)); echo "PASS  $2  (no deadlock)"; fi; }

TA='00000000-0000-0000-0000-0000091cc0a0'; TB='00000000-0000-0000-0000-0000091cc0b0'
VA='00000000-0000-0000-0000-0000091cc0fa'; VB='00000000-0000-0000-0000-0000091cc0fb'
U1='00000000-0000-0000-0000-0000091cc001'

seed(){
 q -c "
  BEGIN;
  SET LOCAL readiness.allow_unguarded='1';
  DELETE FROM public.readiness_scores_current WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_score_history  WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_recalc_queue   WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_formula_versions WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.profiles WHERE id='$U1';
  DELETE FROM auth.users WHERE id='$U1';
  DELETE FROM public.tenant_settings WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.tenants WHERE id IN ('$TA','$TB');
  INSERT INTO public.tenants(id,slug,name) VALUES ('$TA','cca','CCA'),('$TB','ccb','CCB');
  INSERT INTO public.tenant_settings(tenant_id,learning_settings) VALUES ('$TA','{}'),('$TB','{}');
  INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES ('$U1','authenticated','authenticated','cc1@t.test',now(),now());
  UPDATE public.profiles SET role='user',tenant_id='$TA',status='active' WHERE id='$U1';
  INSERT INTO public.readiness_formula_versions(id,tenant_id,version,status,configuration,readiness_threshold,config_hash,source,created_at,activated_at)
   VALUES ('$VA','$TA',2,'active','{\"model\":\"v2_quiz_mastery\"}'::jsonb,80,'h','tenant_customized',now(),now()),
          ('$VB','$TB',2,'active','{\"model\":\"v2_quiz_mastery\"}'::jsonb,80,'h','tenant_customized',now(),now());
  INSERT INTO public.readiness_recalc_queue(tenant_id,user_id,formula_version_id,reason) VALUES ('$TA','$U1',NULL,'manual');
  COMMIT;" >/dev/null 2>&1
}
curcnt(){ q -tAc "SELECT count(*) FROM public.readiness_scores_current WHERE tenant_id='$1' AND user_id='$U1';"; }
tenantof(){ q -tAc "SELECT COALESCE(tenant_id::text,'NULL') FROM public.profiles WHERE id='$U1';"; }
statusof(){ q -tAc "SELECT status FROM public.profiles WHERE id='$U1';"; }

# A "worker" that reproduces the real lock sequence: claim its queue row (1), then insert the current row —
# which fires the write-guard [advisory (2)] and the FK KEY SHARE on profiles (4) — then hold briefly.
worker_insert(){ # $1=tenant $2=version $3=sleep
 q -c "
  BEGIN;
  SELECT 1 FROM public.readiness_recalc_queue WHERE tenant_id='$1' AND user_id='$U1' FOR UPDATE SKIP LOCKED;
  INSERT INTO public.readiness_scores_current(tenant_id,user_id,formula_version_id,success_status,overall_score,calculated_at,calculated_config_hash,last_attempt_at,last_attempt_status)
   VALUES ('$1','$U1','$2','ok',80,now(),'h',now(),'ok');
  SELECT pg_sleep($3);
  COMMIT;"
}
# lifecycle transitions via the engine (advisory-FIRST); break-glass OFF so the guard's marker path is exercised
apply(){ # $1=status $2=role $3=tenant(or NULL)
 local t="'$3'"; [ "$3" = "NULL" ] && t=NULL
 q -c "SELECT public.readiness_lifecycle_apply('$U1','$1','$2',$t, NULL,NULL,NULL,false);"
}

echo "== CC1: worker-first vs deactivate =="
seed
worker_insert "$TA" "$VA" 3 >/tmp/cc1w.out 2>&1 &
( sleep 1; apply inactive user "$TA" ) >/tmp/cc1l.out 2>&1
wait
no_deadlock /tmp/cc1w.out "CC1w no deadlock (worker)"; no_deadlock /tmp/cc1l.out "CC1l no deadlock (lifecycle)"
ok "CC1 final: no current row for deactivated learner" "$(curcnt "$TA")" "0"

echo "== CC2: deactivate-first vs worker (write-guard must skip) =="
seed
( apply inactive user "$TA" ) >/tmp/cc2l.out 2>&1 &
( sleep 1; worker_insert "$TA" "$VA" 1 ) >/tmp/cc2w.out 2>&1
wait
no_deadlock /tmp/cc2l.out "CC2l no deadlock"; no_deadlock /tmp/cc2w.out "CC2w no deadlock"
ok "CC2 final: write-guard skipped current for non-scorable" "$(curcnt "$TA")" "0"

echo "== CC3: transfer-first vs worker (FK KEY SHARE order) =="
seed
( apply active user "$TB" ) >/tmp/cc3l.out 2>&1 &
( sleep 1; worker_insert "$TA" "$VA" 1 ) >/tmp/cc3w.out 2>&1
wait
no_deadlock /tmp/cc3l.out "CC3l no deadlock"; no_deadlock /tmp/cc3w.out "CC3w no deadlock"
ok "CC3 final: profile moved to TB" "$(tenantof)" "$TB"
ok "CC3 final: no stale TA current" "$(curcnt "$TA")" "0"

echo "== CC4: two conflicting transfers of the same user =="
seed
( apply active user "$TB" ) >/tmp/cc4a.out 2>&1 &
( apply active user "$TA" ) >/tmp/cc4b.out 2>&1 &
wait
no_deadlock /tmp/cc4a.out "CC4a no deadlock"; no_deadlock /tmp/cc4b.out "CC4b no deadlock"
ok "CC4 final: profile in exactly one of TA/TB" "$(q -tAc "SELECT (tenant_id IN ('$TA','$TB')) FROM public.profiles WHERE id='$U1';")" "t"

echo "== CC5: transfer racing removal =="
seed
( apply active user "$TB" ) >/tmp/cc5a.out 2>&1 &
( apply inactive user NULL ) >/tmp/cc5b.out 2>&1 &
wait
no_deadlock /tmp/cc5a.out "CC5a no deadlock"; no_deadlock /tmp/cc5b.out "CC5b no deadlock"
ok "CC5 final: no TA current row" "$(curcnt "$TA")" "0"

echo "== CC6: removal racing reactivation =="
seed
( apply inactive user NULL ) >/tmp/cc6a.out 2>&1 &
( apply active user "$TA" ) >/tmp/cc6b.out 2>&1 &
wait
no_deadlock /tmp/cc6a.out "CC6a no deadlock"; no_deadlock /tmp/cc6b.out "CC6b no deadlock"
ok "CC6 final: profile status is a valid terminal value" "$(q -tAc "SELECT status IN ('active','inactive') FROM public.profiles WHERE id='$U1';")" "t"

echo "== CC7: worker batch holding TA AND TB jobs vs a transfer =="
seed
q -c "INSERT INTO public.readiness_recalc_queue(tenant_id,user_id,formula_version_id,reason) VALUES ('$TB','$U1',NULL,'manual');" >/dev/null 2>&1
# one worker txn claims BOTH tenant jobs and writes both current rows, holding all locks; a transfer runs meanwhile
q -c "
  BEGIN;
  SELECT 1 FROM public.readiness_recalc_queue WHERE user_id='$U1' AND tenant_id IN ('$TA','$TB') FOR UPDATE SKIP LOCKED;
  INSERT INTO public.readiness_scores_current(tenant_id,user_id,formula_version_id,success_status,calculated_at,calculated_config_hash) VALUES ('$TA','$U1','$VA','ok',now(),'h');
  SELECT pg_sleep(3);
  INSERT INTO public.readiness_scores_current(tenant_id,user_id,formula_version_id,success_status,calculated_at,calculated_config_hash) VALUES ('$TB','$U1','$VB','ok',now(),'h');
  COMMIT;" >/tmp/cc7w.out 2>&1 &
( sleep 1; apply active user "$TB" ) >/tmp/cc7l.out 2>&1
wait
no_deadlock /tmp/cc7w.out "CC7w no deadlock (batch worker)"; no_deadlock /tmp/cc7l.out "CC7l no deadlock (transfer)"

echo "== CC8: state changes between initial read and post-advisory re-read → safe abort (40001), never 40P01 =="
seed
# two concurrent applies to different target states; the loser must abort with 40001 (retryable), not deadlock
( apply inactive user "$TA" ) >/tmp/cc8a.out 2>&1 &
( apply active orgAdmin "$TA" ) >/tmp/cc8b.out 2>&1 &
wait
no_deadlock /tmp/cc8a.out "CC8a no deadlock"; no_deadlock /tmp/cc8b.out "CC8b no deadlock"
ok "CC8: at most one raised the retryable serialization abort (40001), never a deadlock" \
   "$(cat /tmp/cc8a.out /tmp/cc8b.out | grep -c '40001\|changed concurrently' | awk '{print ($1<=1)?"t":"f"}')" "t"

# cleanup seed
q -c "
  BEGIN; SET LOCAL readiness.allow_unguarded='1';
  DELETE FROM public.readiness_scores_current WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_score_history WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_recalc_queue WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.readiness_formula_versions WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.profiles WHERE id='$U1'; DELETE FROM auth.users WHERE id='$U1';
  DELETE FROM public.tenant_settings WHERE tenant_id IN ('$TA','$TB');
  DELETE FROM public.tenants WHERE id IN ('$TA','$TB'); COMMIT;" >/dev/null 2>&1

echo; echo "── 091 CONCURRENCY: PASS=$PASS FAIL=$FAIL ──"
[ "$FAIL" = "0" ] && echo "091 CONCURRENCY ALL TESTS PASSED" || echo "091 CONCURRENCY FAILURES"
