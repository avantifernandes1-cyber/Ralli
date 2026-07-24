-- ─────────────────────────────────────────────────────────────────────────────
-- Answer confidentiality — Stage A (ADDITIVE, RPC-only). Learner-safe review +
-- learner-safe insight sources. NO RLS / table-policy changes here (those are a
-- SEPARATE later migration 057, applied only after the learner-safe app is live
-- in production). This migration is safe to apply on its own: it does not alter
-- any table's readability and has no production caller today.
--
-- Closes the get_quiz_review canonical-answer leak (pre-055 server_v2 + all
-- legacy attempts still carry `correct` inside quiz_attempts.answers; the RPC
-- returned them verbatim before an official pass) by projecting every returned
-- answer to a strict learner-safe whitelist. Reveal of the answer key continues
-- to come ONLY from the immutable per-attempt snapshot after an official pass.
--
-- Also adds list_quiz_tags_for_learner() so the learner Home/Insights "Knowledge
-- by Topic" aggregation can be sourced without a direct tenant_quizzes SELECT
-- (the attempts aggregate already has a learner-safe source in 055's
-- list_my_quiz_attempts_safe). Together with 055's RPCs, every learner-facing
-- quiz read has a SECURITY DEFINER path — the prerequisite for 057's RLS lockdown.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Strict learner-safe answer projection ─────────────────────────────────
-- Whitelist: questionId, selected, isCorrect, timeSpent. By building a NEW object
-- from only these keys, NO canonical field (correct/correctX/correctY/
-- acceptedAnswers/tolerance/pairs/explanation) can ever pass through, regardless
-- of the stored answer shape (054-era server_v2, learner-safe 055 rows, or legacy
-- client rows). `selected` is preserved verbatim (mc/tf index incl. 0, slider 0,
-- type/open text, matching [{leftIdx,rightText}]). Missing keys become null.
CREATE OR REPLACE FUNCTION public._quiz_answers_learner_safe(p_answers jsonb)
RETURNS jsonb
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'questionId', a->>'questionId',
           'selected',   a->'selected',
           'isCorrect',  CASE WHEN a ? 'isCorrect' THEN a->'isCorrect' ELSE 'null'::jsonb END,
           'timeSpent',  CASE WHEN a ? 'timeSpent' THEN a->'timeSpent' ELSE 'null'::jsonb END
         )), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_answers) = 'array' THEN p_answers ELSE '[]'::jsonb END) a;
$$;
REVOKE ALL ON FUNCTION public._quiz_answers_learner_safe(jsonb) FROM PUBLIC, anon, authenticated;

-- ── 2. get_quiz_review — sanitize returned answers (close the leak) ───────────
-- Identical to 055 EXCEPT `answers` is now projected through
-- _quiz_answers_learner_safe. Reveal still comes only from the immutable snapshot
-- (solutionsByAttempt) after an official pass (passed AND server_v2). The current
-- mutable quiz is never used to reconstruct history.
CREATE OR REPLACE FUNCTION public.get_quiz_review(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_is_mgr boolean;
  v_official_pass boolean;
  v_attempts jsonb;
  v_solutions jsonb := '{}'::jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  v_is_mgr := public.is_ralli_admin() OR public.get_my_role() = 'orgAdmin';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'attempt_id',  qa.id,
           'attempt_num', qa.attempt_num,
           'score',       qa.score,
           'passed',      qa.passed,
           'created_at',  qa.created_at,
           'provenance',  qa.grading_provenance,
           'answers',     public._quiz_answers_learner_safe(qa.answers)   -- STRIP canonical keys
         ) ORDER BY qa.created_at DESC), '[]'::jsonb)
  INTO v_attempts
  FROM public.quiz_attempts qa
  WHERE qa.user_id = v_uid AND qa.quiz_id = p_quiz_id;   -- caller's OWN attempts only

  SELECT EXISTS (SELECT 1 FROM public.quiz_attempts
                 WHERE user_id = v_uid AND quiz_id = p_quiz_id
                   AND passed AND grading_provenance = 'server_v2')
  INTO v_official_pass;

  IF v_is_mgr OR v_official_pass THEN
    SELECT COALESCE(jsonb_object_agg(s.attempt_id::text, s.solution), '{}'::jsonb)
    INTO v_solutions
    FROM public.quiz_attempt_solutions s
    WHERE s.user_id = v_uid AND s.quiz_id = p_quiz_id;   -- immutable historical solutions
  END IF;

  RETURN jsonb_build_object(
    'attempts',           v_attempts,
    'revealAvailable',    (v_is_mgr OR v_official_pass),
    'solutionsByAttempt', v_solutions);   -- empty for attempts without a snapshot -> honest degrade
END $$;
REVOKE ALL ON FUNCTION public.get_quiz_review(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_quiz_review(uuid) TO authenticated;

-- ── 3. list_quiz_tags_for_learner() — learner-safe topic source ──────────────
-- Returns ONLY {id, tags} (stable quiz id + tags — NEVER questions/answers/keys)
-- for quizzes in the caller's tenant that are EITHER:
--   (1) currently accessible to the caller via the eligibility rules, OR
--   (2) referenced by the caller's OWN quiz-attempt history.
-- Clause (2) is what keeps "Knowledge by Topic" from losing legitimate historical
-- performance once an assignment is completed / resolved / removed / inactive —
-- the learner's past attempts stay attributable to their quiz tags. auth.uid +
-- tenant scope enforced; another learner's attempts can never widen the set
-- (the history EXISTS is bound to qa.user_id = v_uid). Tags are returned as
-- stored (null/[] passes through — no invented tags).
CREATE OR REPLACE FUNCTION public.list_quiz_tags_for_learner()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', tq.id, 'tags', tq.tags)), '[]'::jsonb)
  INTO v_out
  FROM public.tenant_quizzes tq
  WHERE tq.tenant_id = v_tenant
    AND (
      public._quiz_learner_can_access(v_uid, tq.id)                 -- (1) currently eligible
      OR EXISTS (SELECT 1 FROM public.quiz_attempts qa              -- (2) OWN attempt history
                   WHERE qa.quiz_id = tq.id AND qa.user_id = v_uid) --     (never another learner's)
    );
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_quiz_tags_for_learner() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_quiz_tags_for_learner() TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- IMPORTANT: rollback must NEVER restore the leaking get_quiz_review body. A
-- corrective migration may DROP list_quiz_tags_for_learner and, if ever needed,
-- adjust the answer whitelist — but the sanitized get_quiz_review (no canonical
-- keys) is PERMANENT. To undo only the additive tag RPC:
--   DROP FUNCTION IF EXISTS public.list_quiz_tags_for_learner();
-- (Leave _quiz_answers_learner_safe and the sanitized get_quiz_review in place.)
