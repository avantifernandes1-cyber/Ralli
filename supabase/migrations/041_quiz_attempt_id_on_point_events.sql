-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 041: Stable quiz_attempt_id on user_point_events.
-- Run after 040_quiz_attempt_rpc_grants.sql.
--
-- Problem being fixed (Sprint 3, Task 18):
--   "Recent Activity" (PersonalDashboardScreen, rankd-app.jsx) opens a quiz
--   attempt's review modal by matching a user_point_events row back to a
--   quiz_attempts row via quiz_id + CLOSEST created_at timestamp
--   (findAttemptForEvent(), rankd-app.jsx). That's a heuristic, not an
--   identity — it can open the wrong attempt for rapid retakes, two tabs
--   submitting near-simultaneously, or plain clock/timestamp precision.
--
--   Task 15 (039_atomic_quiz_completion.sql) already made quiz_attempts and
--   its point-event rows part of one atomic transaction — the saved
--   attempt's real id is available in that same transaction, it just was
--   never carried onto the point-event rows it produced.
--
-- Fix:
--   Add a nullable quiz_attempt_id column to user_point_events, and have
--   submit_quiz_attempt_atomic() stamp it on all three quiz-related rows it
--   writes (base completion, pass/retake-pass, perfect bonus) using
--   v_attempt.id — the exact row it just inserted in the same transaction.
--   The client then looks up the attempt by that id directly (an exact
--   match, not a nearest-timestamp guess) and only falls back to the old
--   timestamp heuristic for events written before this migration, which
--   have no quiz_attempt_id to key off of.
--
-- Nullable / no backfill:
--   Existing rows (lesson/course/game/bonus, and any quiz rows written
--   before this migration) keep quiz_attempt_id = NULL. This is intentional
--   — the column only applies to quiz-sourced rows going forward, and
--   backfilling old rows via nearest-timestamp guessing would reintroduce
--   the exact ambiguity this migration removes. The client's fallback path
--   handles NULL rows exactly as it always has.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.user_point_events
  ADD COLUMN IF NOT EXISTS quiz_attempt_id UUID REFERENCES public.quiz_attempts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_upe_quiz_attempt_id
  ON public.user_point_events (quiz_attempt_id)
  WHERE quiz_attempt_id IS NOT NULL;

COMMENT ON COLUMN public.user_point_events.quiz_attempt_id IS
  'Stable FK to the quiz_attempts row this event was earned from — set only for source_type=quiz/bonus rows written by submit_quiz_attempt_atomic(). NULL for lesson/course/game rows and for quiz rows predating this column (those fall back to nearest-timestamp matching client-side). ON DELETE SET NULL: a deleted attempt should not delete the XP history that was already earned from it.';

-- ── submit_quiz_attempt_atomic(): stamp quiz_attempt_id on every point-event
-- row it writes. Everything else (auth checks, advisory lock, idempotency
-- short-circuit, server-computed attempt_num, hardcoded point amounts) is
-- unchanged from 039 — only the three INSERT INTO user_point_events
-- statements gain a column.
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
  c_pts_completed    CONSTANT INTEGER := 25;
  c_pts_passed       CONSTANT INTEGER := 75;
  c_pts_retake_pass  CONSTANT INTEGER := 40;
  c_pts_perfect      CONSTANT INTEGER := 25;
BEGIN
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

  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_user_id::text || ':' || p_quiz_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

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

  -- Base completion award — always, pass or fail. Now stamped with the
  -- attempt's own id so it can be opened exactly, not guessed at.
  INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason, quiz_attempt_id)
  VALUES (p_tenant_id, p_user_id, 'quiz', p_quiz_id::text, c_pts_completed, 'Quiz completed', v_attempt.id);
  v_points_total := v_points_total + c_pts_completed;

  IF COALESCE(p_passed, false) THEN
    v_pts := CASE WHEN v_is_retake THEN c_pts_retake_pass ELSE c_pts_passed END;
    INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason, quiz_attempt_id)
    VALUES (
      p_tenant_id, p_user_id, 'quiz', p_quiz_id::text, v_pts,
      CASE WHEN v_is_retake THEN 'Quiz passed on retake' ELSE 'Quiz passed' END,
      v_attempt.id
    );
    v_points_total := v_points_total + v_pts;

    IF p_score = 100 THEN
      INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason, quiz_attempt_id)
      VALUES (p_tenant_id, p_user_id, 'bonus', p_quiz_id::text, c_pts_perfect, 'Perfect score', v_attempt.id);
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

REVOKE EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'user_point_events' AND column_name = 'quiz_attempt_id';
--
-- SELECT grantee, privilege_type FROM information_schema.role_routine_grants
--   WHERE routine_name = 'submit_quiz_attempt_atomic';
-- -- Expect: authenticated, service_role, postgres — no anon, no PUBLIC.
--
-- Manual test — submit a quiz attempt, then confirm every quiz/bonus event
-- it produced carries the same quiz_attempt_id as the returned attempt's id:
-- SELECT quiz_attempt_id, source_type, reason, points FROM user_point_events
--   WHERE quiz_attempt_id = '<attempt id from the RPC result>';
-- ─────────────────────────────────────────────────────────────────────────────
