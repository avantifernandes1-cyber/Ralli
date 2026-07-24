-- ─────────────────────────────────────────────────────────────────────────────
-- Answer confidentiality — Stage 1 (ADDITIVE). Learner-safe quiz access.
--
-- Adds, without changing grading/XP/tolerance/idempotency or restricting any
-- existing SELECT (that restriction is a SEPARATE later migration, 056):
--   1. quiz_attempt_solutions — immutable per-attempt canonical grading snapshot
--      (manager/admin-readable; learners only via the pass-gated review RPC).
--   2. _quiz_sanitize_for_attempt() — strips answer-bearing keys; Matching
--      returns decoupled leftItems + independently shuffled rightChoices.
--   3. list_quizzes_for_learner() / get_quiz_for_attempt() / get_quiz_review()
--      — the only learner-facing read contracts (identity/tenant/assignment/
--      pass-state enforced), reusing the existing eligibility + role helpers.
--   4. submit_quiz_attempt_atomic_v2 — grades exactly as before, but stores
--      learner-safe answers, atomically writes the solution snapshot, and
--      returns ONLY a learner-safe object (never to_jsonb(v_attempt)).
--
-- Legacy direct reads remain available in this migration (rollout Stage 1).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Immutable per-attempt canonical solution snapshot ──────────────────────
CREATE TABLE IF NOT EXISTS public.quiz_attempt_solutions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id        uuid NOT NULL UNIQUE REFERENCES public.quiz_attempts(id) ON DELETE CASCADE,
  tenant_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  quiz_id           uuid NOT NULL,
  attempt_num       integer NOT NULL,
  verified_revision text NOT NULL,
  solution          jsonb NOT NULL,      -- exact canonical questions/solutions used for grading
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qas_user_quiz ON public.quiz_attempt_solutions (user_id, quiz_id);
CREATE INDEX IF NOT EXISTS idx_qas_tenant ON public.quiz_attempt_solutions (tenant_id);

ALTER TABLE public.quiz_attempt_solutions ENABLE ROW LEVEL SECURITY;
-- Managers/admins may read their tenant's snapshots directly. Learners get them
-- ONLY through get_quiz_review (pass-gated). No client write path (server-only,
-- via the SECURITY DEFINER submit RPC) and no UPDATE/DELETE — immutable history.
CREATE POLICY qas_select_manager ON public.quiz_attempt_solutions
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = public.get_my_tenant_id() AND public.get_my_role() = 'orgAdmin'));
-- (No INSERT/UPDATE/DELETE policies: writes happen as the table owner inside the
--  SECURITY DEFINER submit RPC; the row is never mutated after creation.)

-- ── 2. Sanitizer: strip answer keys; make Matching playable without the map ───
-- Whitelist per type (never leak a new answer key by omission). Matching returns
-- left prompts in order + right texts INDEPENDENTLY SHUFFLED and decoupled, so
-- the payload preserves neither pair order nor mapping. Ambiguous canonical
-- matching data (duplicate left/right text) is REJECTED rather than graded
-- unpredictably. VOLATILE because of the per-call shuffle.
CREATE OR REPLACE FUNCTION public._quiz_sanitize_for_attempt(p_questions jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE
SET search_path = ''
AS $$
DECLARE
  q      jsonb;
  t      text;
  base   jsonb;
  pairs  jsonb;
  lefts  jsonb;
  rights jsonb;
  out    jsonb := '[]'::jsonb;
BEGIN
  FOR q IN SELECT * FROM jsonb_array_elements(COALESCE(p_questions, '[]'::jsonb)) LOOP
    t := q->>'type';
    base := jsonb_strip_nulls(jsonb_build_object(
      'id',       q->>'id',
      'type',     t,
      'text',     COALESCE(q->>'text', q->>'q'),
      'imageUrl', q->'imageUrl',
      'timeLimit',q->'timeLimit'));

    IF t IN ('mc','tf') THEN
      base := base || jsonb_build_object('options', COALESCE(q->'options', '[]'::jsonb));
    ELSIF t = 'slider' THEN
      base := base || jsonb_strip_nulls(jsonb_build_object(
        'min', q->'min', 'max', q->'max',
        'minLabel', q->'minLabel', 'maxLabel', q->'maxLabel', 'step', q->'step'));
    ELSIF t = 'match' THEN
      pairs := COALESCE(q->'pairs', '[]'::jsonb);
      IF (SELECT count(*) FROM jsonb_array_elements(pairs)) <>
         (SELECT count(DISTINCT p->>'right') FROM jsonb_array_elements(pairs) p)
       OR (SELECT count(*) FROM jsonb_array_elements(pairs)) <>
         (SELECT count(DISTINCT p->>'left')  FROM jsonb_array_elements(pairs) p) THEN
        RAISE EXCEPTION 'ambiguous matching data in question %: duplicate left/right text', q->>'id';
      END IF;
      lefts  := (SELECT jsonb_agg(e.p->>'left' ORDER BY e.ord)
                 FROM jsonb_array_elements(pairs) WITH ORDINALITY AS e(p, ord));
      rights := (SELECT jsonb_agg(e.p->>'right' ORDER BY random())
                 FROM jsonb_array_elements(pairs) AS e(p));
      base := base || jsonb_build_object(
        'leftItems',    COALESCE(lefts, '[]'::jsonb),
        'rightChoices', COALESCE(rights, '[]'::jsonb));
    END IF;
    -- 'type' (Type Answer) and 'open' (Open Ended): base only, no solution.
    out := out || jsonb_build_array(base);
  END LOOP;
  RETURN out;
END $$;
REVOKE ALL ON FUNCTION public._quiz_sanitize_for_attempt(jsonb) FROM PUBLIC, anon, authenticated;

-- ── Shared eligibility: is the caller (a rep) assigned this quiz in-tenant? ────
-- Reuses the canonical assignment targeting (_assignment_target_user_ids), the
-- same expansion the assignment engine and SQL enforce. "Assigned" = targeted
-- by ANY assignment row for the quiz (active or resolved — so a completed/failed
-- assignment still permits review/retake, matching current product behavior).
CREATE OR REPLACE FUNCTION public._quiz_learner_can_access(p_user uuid, p_quiz_id uuid)
RETURNS boolean
LANGUAGE sql STABLE
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_quizzes tq
    JOIN public.profiles pr ON pr.id = p_user AND pr.tenant_id = tq.tenant_id
    JOIN public.tenant_assignments ta
      ON ta.tenant_id = tq.tenant_id AND ta.content_type = 'quiz' AND ta.content_id = tq.id::text
    JOIN LATERAL public._assignment_target_user_ids(tq.tenant_id, ta.assigned_to) AS tgt(uid) ON tgt.uid = p_user
    WHERE tq.id = p_quiz_id
  );
$$;
REVOKE ALL ON FUNCTION public._quiz_learner_can_access(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- ── 3a. list_quizzes_for_learner() — sanitized library/assignment metadata ────
-- ONE call returns every quiz the caller can access (no per-quiz round trip),
-- with NO answer-bearing question bodies (question_count only).
CREATE OR REPLACE FUNCTION public.list_quizzes_for_learner()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', tq.id, 'name', tq.name, 'status', tq.status,
           'tags', tq.tags, 'passing_score', tq.passing_score,
           'question_count', jsonb_array_length(COALESCE(tq.questions,'[]'::jsonb)),
           'question_revision', tq.question_revision
         ) ORDER BY tq.created_at DESC), '[]'::jsonb)
  INTO v_out
  FROM public.tenant_quizzes tq
  WHERE tq.tenant_id = v_tenant
    AND public._quiz_learner_can_access(v_uid, tq.id);
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_quizzes_for_learner() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_quizzes_for_learner() TO authenticated;

-- ── 3b. get_quiz_for_attempt(p_quiz_id) — playable sanitized quiz + revision ──
CREATE OR REPLACE FUNCTION public.get_quiz_for_attempt(p_quiz_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_quiz public.tenant_quizzes%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT * INTO v_quiz FROM public.tenant_quizzes WHERE id = p_quiz_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'quiz not found'; END IF;
  -- Active rep of this exact tenant, assigned this quiz.
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid AND tenant_id = v_quiz.tenant_id
                   AND COALESCE(status,'active') <> 'inactive') THEN
    RAISE EXCEPTION 'not a member of this tenant';
  END IF;
  IF NOT public._quiz_learner_can_access(v_uid, p_quiz_id) THEN
    RAISE EXCEPTION 'quiz not assigned to caller';
  END IF;
  RETURN jsonb_build_object(
    'id',                v_quiz.id,
    'name',              v_quiz.name,
    'passing_score',     v_quiz.passing_score,
    'question_revision', v_quiz.question_revision,
    'questions',         public._quiz_sanitize_for_attempt(v_quiz.questions));
END $$;
REVOKE ALL ON FUNCTION public.get_quiz_for_attempt(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_quiz_for_attempt(uuid) TO authenticated;

-- ── 3c. get_quiz_review(p_quiz_id) — caller's own history; pass-gated reveal ──
-- Always: the caller's OWN attempts (score/pass/submission/isCorrect, learner-safe).
-- Reveal (canonical answers) ONLY if the caller is a manager/admin OR holds an
-- OFFICIAL pass (passed AND grading_provenance='server_v2'). Reveal reads the
-- IMMUTABLE per-attempt SNAPSHOT (not the quiz's current mutable questions);
-- attempts without a snapshot (legacy) degrade honestly (absent -> "unavailable").
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
           'answers',     qa.answers        -- learner-safe (selected + isCorrect) for server_v2 rows
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

-- ── 3d. list_my_quiz_attempts_safe() — caller's own attempt SUMMARIES ─────────
-- Home, To-Do, assignment-status resolution, and history LISTS need only summary
-- fields to resolve status and render rows — never the answers JSON (legacy
-- rows carry canonical 'correct' inside answers). Returns the caller's OWN
-- attempts with NO answers, NO solution snapshot, and NO other users' rows.
-- Detailed per-question review remains a separate, pass-gated call
-- (get_quiz_review). This is what learner screens fetch instead of the raw
-- quiz_attempts SELECT (getUserQuizAttempts), so an answer-bearing row never
-- reaches a learner's browser even though the UI wouldn't render those fields.
CREATE OR REPLACE FUNCTION public.list_my_quiz_attempts_safe()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id',                 qa.id,
           'quiz_id',            qa.quiz_id,
           'attempt_num',        qa.attempt_num,
           'score',              qa.score,
           'passed',             qa.passed,
           'created_at',         qa.created_at,
           'grading_provenance', qa.grading_provenance
         ) ORDER BY qa.created_at DESC), '[]'::jsonb)
  INTO v_out
  FROM public.quiz_attempts qa
  WHERE qa.user_id = v_uid;   -- caller's OWN attempts only; NO answers column
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_my_quiz_attempts_safe() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_my_quiz_attempts_safe() TO authenticated;

-- ── 4/5/6. submit_quiz_attempt_atomic_v2 — learner-safe answers + snapshot ────
-- Grading, XP, score, pass, attempt numbering, revision guard, tolerance, and
-- idempotency are UNCHANGED from 054. Changes: store learner-safe answers (no
-- canonical 'correct'), atomically write the immutable solution snapshot, and
-- return ONLY a learner-safe object (never to_jsonb(v_attempt)).
CREATE OR REPLACE FUNCTION public.submit_quiz_attempt_atomic_v2(
  p_tenant_id         uuid,
  p_quiz_id           uuid,
  p_answers           jsonb,
  p_expected_revision text,
  p_idempotency_key   uuid
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user_id      uuid := auth.uid();
  v_quiz         public.tenant_quizzes%ROWTYPE;
  v_questions    jsonb;
  v_qcount       int; v_acount int;
  v_graded_total int := 0; v_correct int := 0;
  v_i int; v_ques jsonb; v_ans jsonb; v_is_corr boolean;
  v_stored       jsonb := '[]'::jsonb;   -- learner-safe answers (NO canonical correct)
  v_score int; v_pass_cutoff int; v_passed boolean;
  v_lock_key bigint;
  v_existing public.quiz_attempts%ROWTYPE;
  v_attempt public.quiz_attempts%ROWTYPE;
  v_attempt_num int; v_is_retake boolean;
  v_pts_total int := 0; v_pts int;
  c_completed CONSTANT int := 25; c_passed CONSTANT int := 75;
  c_retake_pass CONSTANT int := 40; c_perfect CONSTANT int := 25;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: must be authenticated'; END IF;
  IF p_idempotency_key IS NULL THEN RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: idempotency key required'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id AND tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: tenant mismatch';
  END IF;

  SELECT * INTO v_quiz FROM public.tenant_quizzes WHERE id = p_quiz_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: quiz not found in tenant'; END IF;
  v_questions := COALESCE(v_quiz.questions, '[]'::jsonb);

  IF p_expected_revision IS DISTINCT FROM v_quiz.question_revision THEN
    RETURN jsonb_build_object('status','quiz_changed','retryable',true,'current_revision',v_quiz.question_revision);
  END IF;

  v_qcount := jsonb_array_length(v_questions);
  v_acount := jsonb_array_length(COALESCE(p_answers,'[]'::jsonb));
  IF v_acount <> v_qcount THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: answer count % <> question count %', v_acount, v_qcount;
  END IF;
  IF (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(v_questions) e) <> v_qcount THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: duplicate question ids in quiz';
  END IF;

  FOR v_i IN 0 .. v_qcount - 1 LOOP
    v_ques := v_questions -> v_i;
    v_ans  := p_answers -> v_i;
    IF (v_ans->>'questionId') IS DISTINCT FROM (v_ques->>'id') THEN
      RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: answer % misaligned (got %, expected %)',
        v_i, v_ans->>'questionId', v_ques->>'id';
    END IF;
    v_is_corr := CASE WHEN (v_ques->>'type') = 'open' THEN NULL
                      ELSE public._quiz_answer_is_correct(v_ques, v_ans->'selected') END;
    IF (v_ques->>'type') <> 'open' THEN
      v_graded_total := v_graded_total + 1;
      IF v_is_corr THEN v_correct := v_correct + 1; END IF;
    END IF;
    -- LEARNER-SAFE stored detail: learner submission + server isCorrect + time.
    -- Canonical 'correct' is DELIBERATELY OMITTED (it lives only in the snapshot).
    v_stored := v_stored || jsonb_build_object(
      'questionId', v_ques->>'id',
      'selected',   v_ans->'selected',
      'isCorrect',  v_is_corr,
      'timeSpent',  v_ans->'timeSpent');
  END LOOP;

  v_score := CASE WHEN v_graded_total > 0 THEN round(100.0 * v_correct / v_graded_total)::int ELSE 100 END;
  v_pass_cutoff := COALESCE(v_quiz.passing_score, 100);
  v_passed := v_score >= v_pass_cutoff;

  v_lock_key := hashtextextended(p_tenant_id::text || ':' || v_user_id::text || ':' || p_quiz_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  SELECT * INTO v_existing FROM public.quiz_attempts WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status','ok','alreadyRecorded',true,
      'server_score', v_existing.score, 'server_passed', v_existing.passed,
      'attempt', jsonb_build_object('id',v_existing.id,'attempt_num',v_existing.attempt_num,
                   'created_at',v_existing.created_at,'score',v_existing.score,'passed',v_existing.passed),
      'answers', v_existing.answers);   -- already learner-safe for server_v2 rows
  END IF;

  SELECT count(*) INTO v_attempt_num FROM public.quiz_attempts
    WHERE tenant_id = p_tenant_id AND user_id = v_user_id AND quiz_id = p_quiz_id;
  v_is_retake := v_attempt_num > 0;
  v_attempt_num := v_attempt_num + 1;

  INSERT INTO public.quiz_attempts
    (tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key,
     grading_provenance, verified_revision, graded_at)
  VALUES
    (p_tenant_id, v_user_id, p_quiz_id, v_score, v_passed, v_attempt_num, v_stored,
     p_idempotency_key, 'server_v2', v_quiz.question_revision, now())
  RETURNING * INTO v_attempt;

  -- Immutable canonical solution snapshot for THIS attempt (same transaction).
  INSERT INTO public.quiz_attempt_solutions
    (attempt_id, tenant_id, user_id, quiz_id, attempt_num, verified_revision, solution)
  VALUES
    (v_attempt.id, p_tenant_id, v_user_id, p_quiz_id, v_attempt_num, v_quiz.question_revision, v_questions);

  -- XP — unchanged economy.
  INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
    VALUES (p_tenant_id, v_user_id, 'quiz', p_quiz_id::text, c_completed, 'Quiz completed');
  v_pts_total := c_completed;
  IF v_passed THEN
    v_pts := CASE WHEN v_is_retake THEN c_retake_pass ELSE c_passed END;
    INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
      VALUES (p_tenant_id, v_user_id, 'quiz', p_quiz_id::text, v_pts,
              CASE WHEN v_is_retake THEN 'Quiz passed on retake' ELSE 'Quiz passed' END);
    v_pts_total := v_pts_total + v_pts;
    IF v_score = 100 THEN
      INSERT INTO public.user_point_events (tenant_id, user_id, source_type, source_id, points, reason)
        VALUES (p_tenant_id, v_user_id, 'bonus', p_quiz_id::text, c_perfect, 'Perfect score');
      v_pts_total := v_pts_total + c_perfect;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status','ok','alreadyRecorded',false,
    'server_score', v_score, 'server_passed', v_passed, 'pointsAwarded', v_pts_total,
    'attempt', jsonb_build_object('id',v_attempt.id,'attempt_num',v_attempt.attempt_num,
                 'created_at',v_attempt.created_at,'score',v_score,'passed',v_passed),
    'answers', v_stored);   -- learner-safe only; NEVER canonical correct
END $$;
-- grants unchanged (already granted to authenticated in 054).

-- ── Backfill snapshots for EXISTING trusted attempts (never guess) ────────────
-- Only server_v2 attempts whose graded revision STILL exactly matches the quiz's
-- current revision get a historical snapshot (the exact solution used is provably
-- reconstructable). Attempts whose quiz changed since grading are left WITHOUT a
-- snapshot so review degrades honestly ("exact historical answer detail
-- unavailable"). Legacy (untrusted) attempts are never snapshotted. Idempotent.
INSERT INTO public.quiz_attempt_solutions
  (attempt_id, tenant_id, user_id, quiz_id, attempt_num, verified_revision, solution)
SELECT qa.id, qa.tenant_id, qa.user_id, qa.quiz_id, qa.attempt_num, qa.verified_revision, tq.questions
FROM public.quiz_attempts qa
JOIN public.tenant_quizzes tq ON tq.id = qa.quiz_id
WHERE qa.grading_provenance = 'server_v2'
  AND qa.verified_revision IS NOT NULL
  AND qa.verified_revision = tq.question_revision
  AND NOT EXISTS (SELECT 1 FROM public.quiz_attempt_solutions s WHERE s.attempt_id = qa.id);

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- Restore 054's submit_quiz_attempt_atomic_v2 body; DROP FUNCTION get_quiz_review,
-- get_quiz_for_attempt, list_quizzes_for_learner, list_my_quiz_attempts_safe,
-- _quiz_learner_can_access, _quiz_sanitize_for_attempt; DROP TABLE
-- public.quiz_attempt_solutions.
