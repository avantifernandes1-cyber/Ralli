-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 040: Explicitly revoke submit_quiz_attempt_atomic() from anon.
-- Run after 039_atomic_quiz_completion.sql.
--
-- 039 revoked EXECUTE FROM PUBLIC and granted it TO authenticated, mirroring
-- 034_atomic_assignment_engine.sql's own grant statements exactly. A live
-- check after applying 039 found `anon` still holds EXECUTE on the function
-- (confirmed the same is true of create_assignments_atomic — this is a
-- project-wide default: Supabase's default privileges grant EXECUTE on new
-- functions directly to anon/authenticated/service_role, not via PUBLIC, so
-- `REVOKE ... FROM PUBLIC` never touches it).
--
-- The function's own `auth.uid() IS NULL` check already rejects any anon
-- (unauthenticated) call, so this was not an exploitable gap — but relying
-- on that alone is one layer, not two. This migration closes it explicitly
-- at the grant level as well, so authorization doesn't depend solely on the
-- function body's internal check.
--
-- Scope: only submit_quiz_attempt_atomic (Task 15's new function). The same
-- gap exists on create_assignments_atomic (034) — left untouched here as
-- out of scope; that function predates this task and wasn't flagged.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic(uuid, uuid, uuid, integer, boolean, jsonb, uuid) TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT grantee, privilege_type FROM information_schema.role_routine_grants
--   WHERE routine_name = 'submit_quiz_attempt_atomic';
-- -- Expect: authenticated, service_role, postgres — no anon, no PUBLIC.
-- ─────────────────────────────────────────────────────────────────────────────
