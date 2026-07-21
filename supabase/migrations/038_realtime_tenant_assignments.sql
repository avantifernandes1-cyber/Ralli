-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 038: Enable Realtime on tenant_assignments
-- Run after 037_assignment_aware_lesson_course_eligibility.sql
--
-- Sprint 3, Task 12 — assignment screens (HomeScreen, LearnScreen,
-- QuizzesScreen, manager tracking) currently fetch assignment data on mount
-- only, so a manager assigning content isn't reflected for the affected user
-- (or in manager tracking) until they navigate away and back. This migration
-- adds tenant_assignments to the supabase_realtime publication so the app
-- can subscribe to postgres_changes on it — same mechanism already used for
-- game_session_participants (015_game_lobby_participants.sql).
--
-- Tenant isolation for these events is enforced the same way SELECT already
-- is: the existing "tenant_assignments_select" RLS policy
-- (017_tenant_assignments.sql) restricts which rows a given client can
-- receive, regardless of the client-side `filter` used when subscribing.
-- No RLS or policy change is needed here — only publication membership.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER PUBLICATION supabase_realtime ADD TABLE tenant_assignments;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT * FROM pg_publication_tables
-- WHERE pubname = 'supabase_realtime' AND tablename = 'tenant_assignments';
