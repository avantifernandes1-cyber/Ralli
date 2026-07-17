-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 031: Add last_seen_assignments_at to profiles
--
-- Tracks when a learner last viewed their HomeScreen assignment section.
-- Used to show "NEW" badges on content assigned after their last visit.
-- Enables the "Learn" nav badge count for unread assignments.
--
-- Run in: Supabase Dashboard → SQL Editor → New Query → paste → Run
-- Safe to re-run — uses ADD COLUMN IF NOT EXISTS.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS last_seen_assignments_at TIMESTAMPTZ;

-- Verify
-- SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_schema = 'public' AND table_name = 'profiles' AND column_name = 'last_seen_assignments_at';
