-- ─────────────────────────────────────────────────────────────────────────────
-- Input Authority Hardening — Area 1 (Quiz): server-authoritative grading.
--
-- ADDITIVE ONLY. Adds:
--   1. Trusted provenance columns on quiz_attempts (server-writable ONLY —
--      column-level privileges prevent authenticated clients from setting them,
--      even via a direct REST insert while the legacy insert policy still exists).
--   2. A deterministic questions-only revision hash on tenant_quizzes (generated).
--   3. submit_quiz_attempt_atomic_v2 — a NEW, distinctly-named RPC (not an overload)
--      that recomputes score/passed server-side from the canonical questions,
--      mirroring rankd-app.jsx::isAnswerCorrect exactly, guards against mid-attempt
--      quiz edits via the revision, and awards XP in the SAME transaction.
--
-- Does NOT touch the legacy submit_quiz_attempt_atomic RPC or the direct-insert
-- policy quiz_attempts_own_insert. Legacy revocation is a SEPARATE later migration
-- (055), authored only after this path is deployed and live-QA'd.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Trusted provenance columns (nullable → legacy rows stay NULL = excluded from v2).
ALTER TABLE public.quiz_attempts
  ADD COLUMN IF NOT EXISTS grading_provenance text
    CHECK (grading_provenance IS NULL OR grading_provenance = 'server_v2'),
  ADD COLUMN IF NOT EXISTS verified_revision text,
  ADD COLUMN IF NOT EXISTS graded_at timestamptz;

-- 1a. Close the provenance spoofing window with COLUMN-LEVEL privileges.
--     authenticated may INSERT the normal attempt columns but NOT the three
--     trusted columns. The SECURITY DEFINER RPC runs as the table owner and is
--     unaffected. A direct REST insert that tries to set grading_provenance is
--     rejected with "permission denied for column".
REVOKE INSERT, UPDATE ON public.quiz_attempts FROM authenticated;
GRANT INSERT (id, tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key, created_at)
  ON public.quiz_attempts TO authenticated;
-- (No UPDATE granted back — attempts remain append-only for clients, as before.)

-- 2. Deterministic questions-ONLY revision. jsonb text output is canonical
--    (sorted keys, no insignificant whitespace), so this is stable and ignores
--    cosmetic metadata edits (title/status) that don't change `questions`.
ALTER TABLE public.tenant_quizzes
  ADD COLUMN IF NOT EXISTS question_revision text
    GENERATED ALWAYS AS (encode(extensions.digest(questions::text, 'sha256'), 'hex')) STORED;

-- ── Canonical per-answer grader — mirrors rankd-app.jsx isAnswerCorrect ────────
-- selected is the answer's `selected` jsonb; ques is the question jsonb.
CREATE OR REPLACE FUNCTION public._quiz_answer_is_correct(ques jsonb, selected jsonb)
RETURNS boolean
LANGUAGE plpgsql IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  v_type   text := ques->>'type';
  v_pairs  jsonb := COALESCE(ques->'pairs', '[]'::jsonb);
  v_elem   jsonb;
  v_ok     boolean;
BEGIN
  IF v_type = 'slider' THEN
    IF selected IS NULL OR jsonb_typeof(selected) <> 'number' THEN RETURN false; END IF;
    RETURN abs((selected#>>'{}')::numeric - COALESCE((ques->>'correct')::numeric, 5))
             <= COALESCE((ques->>'tolerance')::numeric, 1);

  ELSIF v_type = 'type' THEN
    IF selected IS NULL OR jsonb_typeof(selected) <> 'string' THEN RETURN false; END IF;
    RETURN EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(ques->'acceptedAnswers', '[]'::jsonb)) a
      WHERE lower(btrim(a)) = lower(btrim(selected#>>'{}')));

  ELSIF v_type = 'match' THEN
    IF selected IS NULL OR jsonb_typeof(selected) <> 'array'
       OR jsonb_array_length(v_pairs) = 0
       OR jsonb_array_length(selected) <> jsonb_array_length(v_pairs) THEN
      RETURN false;
    END IF;
    -- every submitted {leftIdx, rightText} must match pairs[leftIdx].right
    FOR v_elem IN SELECT * FROM jsonb_array_elements(selected) LOOP
      IF (v_pairs -> (v_elem->>'leftIdx')::int ->> 'right') IS DISTINCT FROM (v_elem->>'rightText') THEN
        RETURN false;
      END IF;
    END LOOP;
    RETURN true;

  ELSIF v_type = 'open' THEN
    -- Manually graded; auto-correct iff a non-empty string was submitted.
    RETURN selected IS NOT NULL AND jsonb_typeof(selected) = 'string'
           AND length(btrim(selected#>>'{}')) > 0;

  ELSIF v_type IN ('mc', 'tf') THEN
    RETURN selected IS NOT NULL AND selected = (ques->'correct');

  ELSE
    RETURN false;  -- unknown/legacy type — never guess
  END IF;
END $$;

-- ── The trusted v2 submission RPC ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_quiz_attempt_atomic_v2(
  p_tenant_id         uuid,
  p_quiz_id           uuid,
  p_answers           jsonb,
  p_expected_revision text,
  p_idempotency_key   uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id      uuid := auth.uid();
  v_quiz         public.tenant_quizzes%ROWTYPE;
  v_questions    jsonb;
  v_qcount       int;
  v_acount       int;
  v_graded_total int := 0;
  v_correct      int := 0;
  v_i            int;
  v_ques         jsonb;
  v_ans          jsonb;
  v_is_corr      boolean;
  v_stored       jsonb := '[]'::jsonb;   -- sanitized, server-authoritative answer detail
  v_score        int;
  v_pass_cutoff  int;
  v_passed       boolean;
  v_lock_key     bigint;
  v_existing     public.quiz_attempts%ROWTYPE;
  v_attempt      public.quiz_attempts%ROWTYPE;
  v_attempt_num  int;
  v_is_retake    boolean;
  v_pts_total    int := 0;
  v_pts          int;
  c_completed    CONSTANT int := 25;
  c_passed       CONSTANT int := 75;
  c_retake_pass  CONSTANT int := 40;
  c_perfect      CONSTANT int := 25;
BEGIN
  -- Identity: derived ONLY from auth.uid() (C-3). Idempotency key required.
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: must be authenticated';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: idempotency key required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_user_id AND tenant_id = p_tenant_id) THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: tenant mismatch';
  END IF;

  -- Fetch questions AND revision from the SAME canonical row (tenant-scoped).
  SELECT * INTO v_quiz FROM public.tenant_quizzes
    WHERE id = p_quiz_id AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: quiz not found in tenant';
  END IF;
  v_questions := COALESCE(v_quiz.questions, '[]'::jsonb);

  -- Mid-attempt mutation guard: mismatch inserts nothing, awards no XP.
  IF p_expected_revision IS DISTINCT FROM v_quiz.question_revision THEN
    RETURN jsonb_build_object('status', 'quiz_changed', 'retryable', true,
                              'current_revision', v_quiz.question_revision);
  END IF;

  -- Structural validation of the submitted payload.
  v_qcount := jsonb_array_length(v_questions);
  v_acount := jsonb_array_length(COALESCE(p_answers, '[]'::jsonb));
  IF v_acount <> v_qcount THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: answer count % <> question count %', v_acount, v_qcount;
  END IF;
  -- no duplicate question ids in the quiz definition
  IF (SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(v_questions) e) <> v_qcount THEN
    RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: duplicate question ids in quiz';
  END IF;

  -- Grade by index; require questionId alignment (rejects extra/unknown answers).
  FOR v_i IN 0 .. v_qcount - 1 LOOP
    v_ques := v_questions -> v_i;
    v_ans  := p_answers -> v_i;
    IF (v_ans->>'questionId') IS DISTINCT FROM (v_ques->>'id') THEN
      RAISE EXCEPTION 'submit_quiz_attempt_atomic_v2: answer % misaligned (got %, expected %)',
        v_i, v_ans->>'questionId', v_ques->>'id';
    END IF;
    -- Server-authoritative per-question correctness. Open questions are manually
    -- graded (isCorrect NULL) and excluded from the automatic denominator.
    v_is_corr := CASE WHEN (v_ques->>'type') = 'open' THEN NULL
                      ELSE public._quiz_answer_is_correct(v_ques, v_ans->'selected') END;
    IF (v_ques->>'type') <> 'open' THEN
      v_graded_total := v_graded_total + 1;
      IF v_is_corr THEN v_correct := v_correct + 1; END IF;
    END IF;
    -- Sanitized stored detail: keep the learner's `selected` and client-reported
    -- `timeSpent` (NOT server-verified), but OVERWRITE `correct` with the canonical
    -- question value and record a server-computed `isCorrect`. Any client-supplied
    -- `correct`/`isCorrect` in p_answers is discarded here.
    v_stored := v_stored || jsonb_build_object(
      'questionId', v_ques->>'id',
      'selected',   v_ans->'selected',
      'correct',    v_ques->'correct',
      'isCorrect',  v_is_corr,
      'timeSpent',  v_ans->'timeSpent');
  END LOOP;

  v_score := CASE WHEN v_graded_total > 0
                  THEN round(100.0 * v_correct / v_graded_total)::int
                  ELSE 100 END;                        -- all-open quiz → 100 (matches client)
  v_pass_cutoff := COALESCE(v_quiz.passing_score, 100); -- D-PASS: default 100
  v_passed := v_score >= v_pass_cutoff;

  -- Serialize concurrent submissions for this user+quiz.
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || v_user_id::text || ':' || p_quiz_id::text, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Idempotency short-circuit under the lock.
  SELECT * INTO v_existing FROM public.quiz_attempts WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object('status', 'ok', 'attempt', to_jsonb(v_existing),
                              'pointsAwarded', 0, 'alreadyRecorded', true,
                              'server_score', v_existing.score, 'server_passed', v_existing.passed);
  END IF;

  SELECT count(*) INTO v_attempt_num FROM public.quiz_attempts
    WHERE tenant_id = p_tenant_id AND user_id = v_user_id AND quiz_id = p_quiz_id;
  v_is_retake  := v_attempt_num > 0;
  v_attempt_num := v_attempt_num + 1;

  INSERT INTO public.quiz_attempts
    (tenant_id, user_id, quiz_id, score, passed, attempt_num, answers, idempotency_key,
     grading_provenance, verified_revision, graded_at)
  VALUES
    (p_tenant_id, v_user_id, p_quiz_id, v_score, v_passed, v_attempt_num, v_stored,
     p_idempotency_key, 'server_v2', v_quiz.question_revision, now())
  RETURNING * INTO v_attempt;

  -- XP — same constants/rules as the legacy RPC (unchanged economy).
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

  RETURN jsonb_build_object('status', 'ok', 'attempt', to_jsonb(v_attempt),
                            'pointsAwarded', v_pts_total, 'alreadyRecorded', false,
                            'server_score', v_score, 'server_passed', v_passed);
END $$;

REVOKE ALL ON FUNCTION public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public._quiz_answer_is_correct(jsonb,jsonb) FROM PUBLIC, anon, authenticated;

-- ── ROLLBACK (forward corrective migration only; never edit applied history) ───
-- DROP FUNCTION IF EXISTS public.submit_quiz_attempt_atomic_v2(uuid,uuid,jsonb,text,uuid);
-- DROP FUNCTION IF EXISTS public._quiz_answer_is_correct(jsonb,jsonb);
-- ALTER TABLE public.tenant_quizzes DROP COLUMN IF EXISTS question_revision;
-- GRANT INSERT, UPDATE ON public.quiz_attempts TO authenticated;  -- restore table-level grant
-- ALTER TABLE public.quiz_attempts DROP COLUMN IF EXISTS grading_provenance, DROP COLUMN IF EXISTS verified_revision, DROP COLUMN IF EXISTS graded_at;
