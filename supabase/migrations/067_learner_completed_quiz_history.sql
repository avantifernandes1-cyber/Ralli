-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 067 — Learner-safe completed-quiz HISTORY source (ADDITIVE forward)
--
-- WHY THIS IS REQUIRED (live QA): after a manager archives a quiz, migration 065
-- correctly excludes it from the learner-safe ACTIVE catalog (list_quizzes_for_learner
-- filters status <> 'archived'), and 057 forbids a learner from SELECTing tenant_quizzes
-- directly. Migration 066 keeps a learner's COMPLETED assignment to that quiz active
-- (uncancelled) so it stays Completed — but the learner's browser then has NO safe way
-- to obtain the archived quiz's TITLE/metadata to render its Completed-history card, so
-- the completed row lost its content and vanished from Completed/All. Lessons/courses
-- don't need this (tenant_lessons/tenant_courses SELECT RLS already lets an in-tenant
-- learner read archived rows); ONLY quizzes are RLS-locked, so ONLY quizzes need a
-- dedicated learner-safe history source. Existing safe sources are insufficient:
-- list_quizzes_for_learner (excludes archived by design), list_my_quiz_attempts_safe
-- (no name/title), get_quiz_review (per-attempt, pass-gated, not a list).
--
-- This RPC returns ONLY safe CATALOG METADATA (id, name, status, passing_score) for the
-- quizzes the authenticated caller has PASSED, in the caller's tenant — INCLUDING archived
-- ones. It is a title/status LOOKUP, nothing more. It deliberately does NOT return any
-- per-attempt score or date: an assignment-instance's score/completion date is NOT a
-- lifetime-per-quiz aggregate (a quiz can be reassigned and passed again at a different
-- score/date), so those MUST come from the existing instance-scoped safe attempt source
-- (list_my_quiz_attempts_safe / the client's own quiz_attempts, filtered to attempts
-- created on/after THAT assignment's assigned_at). Returning aggregates here would invite
-- misattribution, so they are omitted. `name` is CURRENT catalog metadata (a manager may
-- rename a quiz), not an immutable historical title; immutable historical questions/answers
-- remain solely in the pass-gated get_quiz_review snapshot contract. NEVER returns
-- questions/answer keys, never another learner's rows, never makes archived content
-- startable/searchable, never weakens 065's active-catalog exclusion. Tenant + learner
-- enforced server-side. Additive: one function; changes no table, policy, or other RPC.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.list_my_completed_quiz_history()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  -- Server-authoritative tenant from the caller's own profile (never trusted from client).
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;

  -- One row per quiz the CALLER has EVER passed, in the caller's tenant. SAFE catalog
  -- metadata ONLY (id, name, status, passing_score) — NO questions/answers, NO per-attempt
  -- score or date (those are instance facts, resolved client-side from scoped attempts).
  -- Archived quizzes are included so their title/status resolves for Completed history.
  SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
           'id',            q.id,
           'name',          q.name,
           'status',        q.status,
           'passing_score', q.passing_score
         )), '[]'::jsonb)
  INTO v_out
  FROM public.tenant_quizzes q
  WHERE q.tenant_id = v_tenant
    AND EXISTS (
      SELECT 1 FROM public.quiz_attempts qa
      WHERE qa.quiz_id = q.id AND qa.user_id = v_uid AND qa.passed IS TRUE
    );

  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_my_completed_quiz_history() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_my_completed_quiz_history() TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
--   DROP FUNCTION IF EXISTS public.list_my_completed_quiz_history();
-- Never weakens 055/056/057 answer confidentiality or 065's active-catalog exclusion.
-- Tenant isolation unchanged.
