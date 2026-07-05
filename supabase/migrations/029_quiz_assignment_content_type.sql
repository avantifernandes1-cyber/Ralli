-- Migration 029: Allow 'quiz' as a content_type in tenant_assignments
--
-- The original migration (017) created a CHECK constraint restricting
-- content_type to ('course', 'lesson'). Quiz assignments via the
-- QuizzesScreen assign flow fail with a constraint violation.
-- This migration drops the old constraint and recreates it with 'quiz' added.

ALTER TABLE public.tenant_assignments
  DROP CONSTRAINT IF EXISTS tenant_assignments_content_type_check;

ALTER TABLE public.tenant_assignments
  ADD CONSTRAINT tenant_assignments_content_type_check
  CHECK (content_type IN ('course', 'lesson', 'quiz'));
