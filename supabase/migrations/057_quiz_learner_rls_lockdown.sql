-- ─────────────────────────────────────────────────────────────────────────────
-- Answer confidentiality — Stage B (RLS lockdown). Revoke learner DIRECT SELECT
-- on the answer-bearing quiz tables, so a learner can no longer bypass the
-- learner-safe SECURITY DEFINER RPCs by querying tables directly. Prerequisite
-- (satisfied): the learner-safe app is deployed to production (main @ 445bbef)
-- and every learner quiz read now goes through an RPC.
--
-- Changes ONLY the two learner-readable SELECT policies, replacing them with the
-- SAME manager-role pattern the tenant_quizzes write policies already use:
--   role ∈ {ralli_admin, orgAdmin, manager} AND (ralli_admin OR own tenant).
-- Learners (role 'user') fail the policy → no direct row access; SECURITY
-- DEFINER RPCs (list_quizzes_for_learner / get_quiz_for_attempt / get_quiz_review
-- / list_my_quiz_attempts_safe / list_quiz_tags_for_learner) bypass RLS and keep
-- working. NOTHING else changes:
--   • quiz_attempts_own_insert (INSERT) unchanged  → learners still submit.
--   • tenant_quizzes insert/update/delete unchanged → managers still author.
--   • quiz_attempt_solutions qas_select_manager unchanged → manager/admin-only,
--     no client write path (immutable).
--   • get_quiz_review sanitization (056) is NOT touched and stays permanent.
-- Tenant isolation is preserved in every clause (ralli_admin cross-tenant;
-- everyone else scoped to get_my_tenant_id()).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── tenant_quizzes: learners lose direct SELECT of answer-bearing questions ───
DROP POLICY IF EXISTS tenant_quizzes_select ON public.tenant_quizzes;
CREATE POLICY tenant_quizzes_select ON public.tenant_quizzes
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = ANY (ARRAY['ralli_admin','orgAdmin','manager'])
    AND (public.get_my_role() = 'ralli_admin' OR tenant_id = public.get_my_tenant_id())
  );

-- ── quiz_attempts: learners lose direct SELECT of raw attempts (own + others') ─
-- Managers/org admins keep tenant-wide reads for assignments/analytics/drilldowns.
DROP POLICY IF EXISTS quiz_attempts_tenant_read ON public.quiz_attempts;
CREATE POLICY quiz_attempts_tenant_read ON public.quiz_attempts
  FOR SELECT TO authenticated
  USING (
    public.get_my_role() = ANY (ARRAY['ralli_admin','orgAdmin','manager'])
    AND (public.get_my_role() = 'ralli_admin' OR tenant_id = public.get_my_tenant_id())
  );

-- (quiz_attempts_own_insert, tenant_quizzes_{insert,update,delete}, and
--  quiz_attempt_solutions.qas_select_manager are intentionally left unchanged.)

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- If a rollback is ever required, restore ONLY the minimum table-read policy
-- temporarily — NEVER weaken the 056 get_quiz_review sanitization. To restore the
-- prior (learner-readable) SELECT policies verbatim:
--   DROP POLICY IF EXISTS tenant_quizzes_select ON public.tenant_quizzes;
--   CREATE POLICY tenant_quizzes_select ON public.tenant_quizzes FOR SELECT TO authenticated
--     USING (public.get_my_role() = 'ralli_admin' OR tenant_id = public.get_my_tenant_id());
--   DROP POLICY IF EXISTS quiz_attempts_tenant_read ON public.quiz_attempts;
--   CREATE POLICY quiz_attempts_tenant_read ON public.quiz_attempts FOR SELECT TO authenticated
--     USING (tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));
