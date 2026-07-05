-- Migration 021: Add lesson_schedule to tenant_courses
--
-- Stores per-lesson availability timing as a JSONB map:
-- { "<lesson_uuid>": { "available_after_days": 0 } }
--
-- available_after_days:
--   0 = immediately available when course is assigned
--   N = available N days after the course assignment date
--
-- This column is additive and backward-compatible.
-- Existing courses load with an empty object (default), meaning all lessons
-- are immediately available — unchanged behaviour.

ALTER TABLE public.tenant_courses
  ADD COLUMN IF NOT EXISTS lesson_schedule JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.tenant_courses.lesson_schedule IS
  'Per-lesson availability map. Keys are lesson UUIDs. '
  'Value: { available_after_days: number }. '
  '0 means immediately; N means N days after assignment date.';
