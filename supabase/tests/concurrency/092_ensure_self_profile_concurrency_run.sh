#!/usr/bin/env bash
# Two-connection concurrency test for the 092 ensure_self_profile correction. Runs against the local Supabase
# DB with 091 AND 092 applied. Proves: two simultaneous ensure_self_profile calls for the SAME new user create
# EXACTLY ONE profile, return an HONEST created result (exactly one true, one false), and never error/deadlock.
set -u
DB=supabase_db_wt-learn
q(){ docker exec -e PGOPTIONS='-c lock_timeout=8000 -c statement_timeout=20000' "$DB" psql -U postgres -d postgres -v ON_ERROR_STOP=0 -tA "$@"; }
PASS=0; FAIL=0
ok(){ if [ "$2" = "$3" ]; then PASS=$((PASS+1)); echo "PASS  $1  ($2)"; else FAIL=$((FAIL+1)); echo "FAIL  $1  exp[$3] got[$2]"; fi; }
no_deadlock(){ if grep -qiE '40P01|deadlock' "$1"; then FAIL=$((FAIL+1)); echo "FAIL  $2  (deadlock)"; else PASS=$((PASS+1)); echo "PASS  $2  (no deadlock)"; fi; }

NU='00000000-0000-0000-0000-0000092ce001'

seed(){
 q -c "
  DELETE FROM public.readiness_scores_current WHERE user_id='$NU';
  DELETE FROM public.profiles WHERE id='$NU';
  DELETE FROM auth.users WHERE id='$NU';
  INSERT INTO auth.users(id,aud,role,email,created_at,updated_at) VALUES ('$NU','authenticated','authenticated','nu@t.test',now(),now());
  -- handle_new_user auto-created a profile on that insert; delete it so the ensure_self_profile INSERT must run
  DELETE FROM public.profiles WHERE id='$NU';" >/dev/null 2>&1
}
# call ensure_self_profile as $NU, with a pre-insert sleep to widen the concurrency window; print created flag
call(){ q -tAc "
  BEGIN;
  SELECT set_config('request.jwt.claims', json_build_object('sub','$NU')::text, true);
  SELECT pg_sleep($1);
  SELECT (public.ensure_self_profile('Racer')->>'created');
  COMMIT;" ; }

echo "== CC: two simultaneous ensure_self_profile for the same new user =="
seed
call 1 >/tmp/esp_a.out 2>&1 &
call 1 >/tmp/esp_b.out 2>&1 &
wait
no_deadlock /tmp/esp_a.out "conn A no deadlock"; no_deadlock /tmp/esp_b.out "conn B no deadlock"
RA=$(grep -E '^(true|false)$' /tmp/esp_a.out | tail -1); RB=$(grep -E '^(true|false)$' /tmp/esp_b.out | tail -1)
echo "conn A created=$RA ; conn B created=$RB"
ok "exactly ONE profile row created" "$(q -tAc "SELECT count(*) FROM public.profiles WHERE id='$NU';")" "1"
ok "exactly ONE call reported created=true (honest result)" "$(printf '%s\n%s\n' "$RA" "$RB" | grep -c '^true$')" "1"
ok "the other call reported created=false" "$(printf '%s\n%s\n' "$RA" "$RB" | grep -c '^false$')" "1"
# the created row is user/active/no-org
ok "created profile is user/active/no-tenant" "$(q -tAc "SELECT (role='user' AND status='active' AND tenant_id IS NULL) FROM public.profiles WHERE id='$NU';")" "t"

# cleanup
q -c "DELETE FROM public.profiles WHERE id='$NU'; DELETE FROM auth.users WHERE id='$NU';" >/dev/null 2>&1

echo; echo "── 092 ensure_self_profile CONCURRENCY: PASS=$PASS FAIL=$FAIL ──"
[ "$FAIL" = "0" ] && echo "092 ESP CONCURRENCY ALL TESTS PASSED" || echo "092 ESP CONCURRENCY FAILURES"
