-- Migration 027: user_point_events — idempotency for non-repeatable events
--
-- Problem: awardPoints() does a plain INSERT with no uniqueness constraint.
-- Network retries or duplicate completion calls can insert two rows for the same
-- lesson or course completion, inflating leaderboard scores and XP totals.
--
-- Why not a full-table UNIQUE:
--   Quiz retakes legitimately produce multiple rows for the same (user, quiz_id).
--   Game and bonus rows may also repeat intentionally.
--   A full unique constraint would block valid quiz retake awards.
--
-- Solution: partial unique index scoped to source_type IN ('lesson', 'course').
--   - Lesson completions:  one row per (tenant, user, lesson_id, reason).
--   - Course completions:  one row per (tenant, user, course_id, reason).
--   - Quiz / game / bonus: unconstrained — repeatable events unaffected.
--
-- The reason column is included so the base award ("Lesson completed") and the
-- early-bonus award ("Completed before due date") are tracked as separate rows
-- without being blocked by the index.
--
-- awardPoints() is updated to catch unique_violation (23505) and return
-- { error: null } so idempotent calls never surface an error to the caller.

CREATE UNIQUE INDEX IF NOT EXISTS idx_upe_lesson_course_dedup
  ON public.user_point_events (tenant_id, user_id, source_type, source_id, reason)
  WHERE source_type IN ('lesson', 'course');

COMMENT ON INDEX idx_upe_lesson_course_dedup
  IS 'Prevents duplicate XP awards for lesson and course completions. Quiz retakes are unaffected (partial index).';
