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
-- This RPC returns ONLY the authenticated learner's OWN passed quizzes (including
-- archived), with SAFE metadata (id, name, status, passing_score, best_score,
-- last_passed_at). It NEVER returns questions or answer keys (those remain behind the
-- existing pass-gated get_quiz_review contract), never exposes another learner's rows,
-- and is HISTORY only — it does not make archived content startable or searchable and
-- does not weaken 065's active-catalog exclusion. Tenant + learner identity are enforced
-- server-side. Additive: creates one function; changes no table, policy, or other RPC.
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

  -- One row per quiz the CALLER has ever PASSED, in the caller's tenant. Safe metadata
  -- only — NO questions/answers. Archived quizzes are included (this is history), but
  -- the payload carries the real status so the UI shows an "Archived" badge and never
  -- offers Start/Retry. best_score/last_passed_at come from the caller's OWN attempts.
  SELECT COALESCE(jsonb_agg(item ORDER BY item->>'last_passed_at' DESC), '[]'::jsonb)
  INTO v_out
  FROM (
    SELECT jsonb_build_object(
             'id',             q.id,
             'name',           q.name,
             'status',         q.status,
             'passing_score',  q.passing_score,
             'best_score',     mine.best_score,
             'passed',         true,
             'last_passed_at', mine.last_passed_at
           ) AS item
    FROM public.tenant_quizzes q
    JOIN (
      SELECT qa.quiz_id,
             max(qa.score) AS best_score,
             max(qa.created_at) AS last_passed_at
      FROM public.quiz_attempts qa
      WHERE qa.user_id = v_uid AND qa.passed IS TRUE
      GROUP BY qa.quiz_id
    ) mine ON mine.quiz_id = q.id
    WHERE q.tenant_id = v_tenant
  ) s;

  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_my_completed_quiz_history() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_my_completed_quiz_history() TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
--   DROP FUNCTION IF EXISTS public.list_my_completed_quiz_history();
-- Never weakens 055/056/057 answer confidentiality or 065's active-catalog exclusion.
-- Tenant isolation unchanged.
