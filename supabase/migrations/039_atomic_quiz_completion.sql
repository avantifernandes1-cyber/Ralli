-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 039: Atomic quiz completion — submit_quiz_attempt_atomic()
-- Run after 038_realtime_tenant_assignments.sql.
--
-- Problem being fixed (Sprint 3, Task 15):
--   QuizzesScreen's onComplete() (rankd-app.jsx) currently fires two
--   independent, un-awaited client writes for every quiz submission:
--     awardQuizPoints(...)   -> inserts into user_point_events (scoringService.js)
--     saveQuizAttempt(...)   -> inserts into quiz_attempts       (contentService.js)
--   Neither write waits on the other, neither rolls back if the other fails,
--   and neither has any duplicate-submission protection:
--     - awardQuizPoints can succeed with no matching quiz_attempts row (or
--       vice versa) if either request fails independently.
--     - attempt_num is computed client-side from a locally-cached attempt
--       list (userQuizAttempts[activeId].length + 1), not a live DB count —
--       two near-simultaneous submissions (double-click, two tabs, a network
--       retry) can compute the SAME attempt_num and both insert.
--     - user_point_events has no dedup for source_type = 'quiz' at all
--       (idx_upe_lesson_course_dedup, migration 027, explicitly excludes
--       quiz because retakes must legitimately produce new point rows) — so
--       a retried or double-clicked submission awards XP twice with nothing
--       to stop it.
--
-- Fix:
--   submit_quiz_attempt_atomic() does the attempt INSERT and every XP award
--   INSERT for that attempt inside ONE transaction, serialized per
--   (tenant_id, user_id, quiz_id) via pg_advisory_xact_lock — the same
--   pattern 034_atomic_assignment_engine.sql already established for
--   assignment creation. attempt_num is computed server-side, under the
--   lock, from a live COUNT(*) — never trusts a client-supplied number.
--
--   Idempotency: the client generates one UUID per quiz-taking session
--   (QuizTakingView, created once via useRef, reused across any retry of
--   the SAME submission — a fresh mount, e.g. an actual retake, gets its
--   own new UUID) and passes it as p_idempotency_key. If a row with that
--   key already exists, the function returns it as-is and skips every
--   insert — no duplicate attempt row, no duplicate XP, whether the retry
--   is a network retry, a double-click before the UI disables the submit
--   button, or two browser tabs. This does NOT rely on a unique index on
--   user_point_events (which 027 correctly avoids for quiz), because dedup
--   happens one level up: if the attempt row itself is deduplicated, the
--   points inserts tied to it never run a second time.
--
-- Scope decision — readiness_scores is NOT part of this transaction:
--   computeAndSaveReadinessScore() (insightsService.js) is a pure
--   recompute-and-upsert keyed on (tenant_id, user_id) — calling it any
--   number of times, including redundantly, converges to the same derived
--   state and never double-credits anything (it recomputes from
--   quiz_attempts/lesson_completions/user_point_events fresh every time,
--   it doesn't accumulate). Sprint 3's own task text allows readiness to
--   "remain a follow-up if safely recomputable" — this qualifies, so it
--   stays a fire-and-forget client call (triggerReadinessUpdate) made
--   AFTER this RPC resolves, exactly as today. Folding it into the same
--   transaction would only add latency to the user-facing results screen
--   for a value that's cheap to recompute later and carries no correctness
--   risk if it briefly lags.
--
-- Security model — SECURITY DEFINER, mirroring 034's rationale:
--   quiz_attempts_own_insert (022_ai_insights.sql) already requires
--   `user_id = auth.uid() AND tenant_id IN (SELECT tenant_id FROM profiles
--   WHERE id = auth.uid())` for a direct insert. This function is
--   SECURITY DEFINER (so it can also write user_point_events, which has
--   its own separate self-insert policy, in the same transaction) and
--   manually replicates that exact same check before doing anything else —
--   no new capability is granted beyond what the two existing INSERT
--   policies already allow a user to do to their own rows.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Idempotency key column ────────────────────────────────────────────────────
-- Nullable — existing rows and any future direct insert (e.g. saveQuizAttempt(),
-- kept in place for other callers) are unaffected. Only rows written through
-- submit_quiz_attempt_atomic() populate it.
ALTER TABLE public.quiz_attempts
  ADD COLUMN IF NOT EXISTS idempotency_key UUID;

-- Globally unique when present. A client-generated UUID has no realistic
-- collision risk across different users/quizzes, so a single global partial
-- index is simpler than a composite one and gives the same guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS idx_qa_idempotency_key
  ON public.quiz_attempts (idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN public.quiz_attempts.idempotency_key IS
  'Client-generated UUID, one per quiz-taking session — lets submit_quiz_attempt_atomic() detect and safely no-op a retried/double-clicked submission instead of inserting a duplicate row.';

-- ── Main entry point ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_quiz_attempt_atomic(
  p_tenant_id        UUID,
  p_user_id          UUID,
  p_quiz_id          UUID,
  p_score            INTEGER,
  p_passed           BOOLEAN,
  p_answers          JSONB,
  p_idempotency_key  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_key       BIGINT;
  v_existing       public.quiz_attempts%ROWTYPE;
  v_attempt        public.quiz_attempts%ROWTYPE;
  v_attempt_num    INTEGER;
  v_is_retake      BOOLEAN;
  v_points_total   INTEGER := 0;
  v_pts            INTEGER;
  -- Mirrors src/lib/scoringService.js SCORING.quiz — keep both in sync if
  -- the rubric ever changes. Hardcoded here (rather than passed in as a
  -- parameter) deliberately: this function is SECURITY DEFINER and bypasses
  -- user_point_events' own RLS, so the point VALUES it writes must not be
  -- caller-controlled — only the outcome (score/passed) is caller-supplied,
  -- exactly like a client-side award call already could/can shape today.
  c_pts_completed    CONSTANT INTEGER := 25;
  c_pts_passed       CONSTANT INTEGER := 75;
  c_pts_retake_pass  CONSTANT INTEGER := 40;
  c_pts_perfect      CONSTANT INTEGER := 25;
BEGIN
  -- Manual authorization — replicates quiz_attempts_own_insert's WITH CHECK
  -- exactly (022_ai_insights.sql), since SECURITY DEFINER bypasses it.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic: must be authenticated';
  END IF;

  IF p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic: caller may only submit their own attempts';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.profiles WHERE id = auth.uid() AND tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic: tenant mismatch — caller does not belong to tenant %', p_tenant_id;
  END IF;

  IF p_score IS NULL OR p_score < 0 OR p_score > 100 THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic: invalid score %', p_score;
  END IF;

  -- Serialize every concurrent submission for this exact user+quiz.
  -- Transaction-scoped: released automatically at commit/rollback.
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_user_id::text || ':' || p_quiz_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Idempotency short-circuit: a retried/double-clicked call with the same
  -- key returns the already-recorded attempt untouched — no new attempt
  -- row, no new XP. Safe under the lock: a truly concurrent double-click
  -- blocks here until the first call's INSERT (below) commits, then finds
  -- it and takes this branch instead of inserting a second time.
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
    FROM public.quiz_attempts
    WHERE idempotency_key = p_idempotency_key;

    IF FOUND THEN
      RETURN jsonb_build_object(
        'attempt',         to_jsonb(v_existing),
        'pointsAwarded',   0,
        'alreadyRecorded', true
      );
    END IF;
  END IF;

  -- attempt_num from a live count under the lock — never client-supplied,
  -- so two near-simultaneous submissions can never collide on the same number.
  SELECT COUNT(*) INTO v_attempt_num
  FROM public.quiz_attempts
  WHERE tenant_id = p_tenant_id AND user_id = p_user_id AND quiz_id = p_quiz_id;
  v_is_retake   := v_attempt_num > 0;
  v_attempt_num := v_attempt_num + 1;

  INSERT INTO public.quiz_attempts (
    tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key
  ) VALUES (
    p_tenant_id, p_user_id, p_quiz_id, p_score, COALESCE(p_passed, false), v_attempt_num,
    COALESCE(p_answers, '[]'::jsonb), p_idempotency_key
  )
  RETURNING * INTO v_attempt;

  -- Base completion award — always, pass or fail.
  INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
  VALUES (p_tenant_id, p_user_id, 'quiz', p_quiz_id::text, c_pts_completed, 'Quiz completed');
  v_points_total := v_points_total + c_pts_completed;

  IF COALESCE(p_passed, false) THEN
    v_pts := CASE WHEN v_is_retake THEN c_pts_retake_pass ELSE c_pts_passed END;
    INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
    VALUES (
      p_tenant_id, p_user_id, 'quiz', p_quiz_id::text, v_pts,
      CASE WHEN v_is_retake THEN 'Quiz passed on retake' ELSE 'Quiz passed' END
    );
    v_points_total := v_points_total + v_pts;

    IF p_score = 100 THEN
      INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
      VALUES (p_tenant_id, p_user_id, 'bonus', p_quiz_id::text, c_pts_perfect, 'Perfect score');
      v_points_total := v_points_total + c_pts_perfect;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'attempt',         to_jsonb(v_attempt),
    'pointsAwarded',   v_points_total,
    'alreadyRecorded', false
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT proname, prosecdef FROM pg_proc WHERE proname = 'submit_quiz_attempt_atomic';
-- -- prosecdef should be TRUE.
--
-- SELECT grantee, privilege_type FROM information_schema.role_routine_grants
--   WHERE routine_name = 'submit_quiz_attempt_atomic';
-- -- Expect: only 'authenticated', no PUBLIC grant.
--
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'quiz_attempts' AND indexname = 'idx_qa_idempotency_key';
--
-- Manual idempotency test (same key twice):
-- SELECT submit_quiz_attempt_atomic('<tenant>','<user>','<quiz>', 80, false, '[]'::jsonb, '11111111-1111-1111-1111-111111111111');
-- SELECT submit_quiz_attempt_atomic('<tenant>','<user>','<quiz>', 80, false, '[]'::jsonb, '11111111-1111-1111-1111-111111111111');
-- -- Expect: second call returns alreadyRecorded=true, pointsAwarded=0; only ONE quiz_attempts row and ONE set of
-- -- user_point_events rows exists for that key/attempt.
--
-- Manual retake test (different key):
-- SELECT submit_quiz_attempt_atomic('<tenant>','<user>','<quiz>', 95, true, '[]'::jsonb, '22222222-2222-2222-2222-222222222222');
-- -- Expect: attempt_num = 2 (if a prior attempt exists), reason 'Quiz passed on retake', pointsAwarded = 25 + 40 (+25 if score=100).
-- ─────────────────────────────────────────────────────────────────────────────
