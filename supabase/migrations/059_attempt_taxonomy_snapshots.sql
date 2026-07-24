-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 059 — Attempt-time taxonomy snapshots (ADDITIVE, backend only)
--
-- Records, per attempt, the quiz's tag configuration AT THE TIME the attempt was
-- classified — immutably — so later re-tagging (attach/detach/rename/archive/
-- merge) never rewrites historical analytics. Uses a RELATIONAL model (not an
-- unenforced uuid[]) for referential integrity:
--   1. quiz_attempt_tag_snapshots — one "envelope" row per snapshotted attempt.
--      Its presence marks the attempt as classified (source = grading |
--      initial_classification). Absence marks the attempt "awaiting initial
--      classification". This unambiguously distinguishes "awaiting" (no envelope)
--      from "genuinely untagged" (envelope present, zero tag rows).
--   2. quiz_attempt_tags — the (attempt_id, tag_id) links. tag_id FK is
--      ON DELETE RESTRICT: a tag referenced by history can never be hard-deleted
--      (archive/merge instead) — history is never silently corrupted.
--
-- Population is SERVER-AUTHORITATIVE only (never client-supplied):
--   • submit_quiz_attempt_atomic_v2 (replaced below, byte-identical grading to
--     055) writes a 'grading' snapshot for every NEW attempt on a CLASSIFIED
--     quiz, from quiz_tag_map. New attempts on an unclassified quiz write no
--     envelope (they remain "awaiting").
--   • set_quiz_tags (replaced below, superset of 058) performs the ONE-TIME
--     initial classification: when a quiz first becomes classified, all of its
--     awaiting attempts (no envelope) inherit that initial tag set, immutably.
--     After that, attach/detach affects future attempts only; existing envelopes
--     are never rewritten.
--
-- No confidentiality change: snapshots hold tag IDs only (no questions/answers).
-- Does NOT weaken 056/057. Dormant for analytics until the Phase-3 Heatmap
-- cutover reads these tables. Grading/XP/idempotency/scoring are UNCHANGED.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Snapshot envelope (one per attempt; presence = classified) ────────────
CREATE TABLE IF NOT EXISTS public.quiz_attempt_tag_snapshots (
  attempt_id      uuid PRIMARY KEY REFERENCES public.quiz_attempts(id) ON DELETE CASCADE,
  tenant_id       uuid NOT NULL,
  quiz_id         uuid NOT NULL,
  snapshot_source text NOT NULL CHECK (snapshot_source IN ('grading','initial_classification')),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qats_tenant ON public.quiz_attempt_tag_snapshots (tenant_id);
CREATE INDEX IF NOT EXISTS idx_qats_quiz   ON public.quiz_attempt_tag_snapshots (quiz_id);

-- ── 2. Snapshot tag links (immutable; tag never hard-deletable while referenced)
CREATE TABLE IF NOT EXISTS public.quiz_attempt_tags (
  attempt_id uuid NOT NULL REFERENCES public.quiz_attempt_tag_snapshots(attempt_id) ON DELETE CASCADE,
  tag_id     uuid NOT NULL REFERENCES public.tenant_quiz_tags(id) ON DELETE RESTRICT,
  tenant_id  uuid NOT NULL,
  PRIMARY KEY (attempt_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_qat_tag    ON public.quiz_attempt_tags (tag_id);
CREATE INDEX IF NOT EXISTS idx_qat_tenant ON public.quiz_attempt_tags (tenant_id);

-- ── 3. RLS — managers/orgAdmin read; immutable, no direct writes (RPC-only) ──
ALTER TABLE public.quiz_attempt_tag_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_attempt_tags          ENABLE ROW LEVEL SECURITY;
CREATE POLICY qats_select_manager ON public.quiz_attempt_tag_snapshots
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = public.get_my_tenant_id() AND public.get_my_role() IN ('orgAdmin','manager')));
CREATE POLICY qat_select_manager ON public.quiz_attempt_tags
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = public.get_my_tenant_id() AND public.get_my_role() IN ('orgAdmin','manager')));
-- No INSERT/UPDATE/DELETE policies: writes happen as the table owner inside the
-- SECURITY DEFINER RPCs below, and rows are never mutated after creation —
-- immutable history, matching quiz_attempt_solutions (055).

-- ── 4. submit_quiz_attempt_atomic_v2 — 055 grading VERBATIM + tag snapshot ────
-- Identical to migration 055 EXCEPT: after writing the canonical solution
-- snapshot, if the quiz is CLASSIFIED, write the attempt-time tag snapshot from
-- quiz_tag_map (server-authoritative). Everything else — validation, grading,
-- scoring, pass cutoff, idempotency, attempt numbering, XP economy, learner-safe
-- return — is byte-for-byte unchanged.
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

  -- Attempt-time TAXONOMY snapshot (immutable, server-authoritative). Only when
  -- the quiz is CLASSIFIED. Unclassified quizzes leave the attempt "awaiting"
  -- (no envelope) so it can inherit the initial set once at first classification.
  IF v_quiz.tags_classified_at IS NOT NULL THEN
    INSERT INTO public.quiz_attempt_tag_snapshots (attempt_id, tenant_id, quiz_id, snapshot_source)
      VALUES (v_attempt.id, p_tenant_id, p_quiz_id, 'grading');
    INSERT INTO public.quiz_attempt_tags (attempt_id, tag_id, tenant_id)
      SELECT v_attempt.id, m.tag_id, p_tenant_id
      FROM public.quiz_tag_map m WHERE m.quiz_id = p_quiz_id;
  END IF;

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

-- ── 5. set_quiz_tags — 058 explicit-classify contract + inheritance ──────────
-- Superset of the 058 version. On the FIRST explicit classification (p_classify,
-- tagged OR intentionally Uncategorized) every awaiting attempt of the quiz (no
-- envelope yet) inherits the initial configuration ONCE, immutably
-- (snapshot_source='initial_classification'). A zero-tag initial classification
-- creates envelopes with ZERO tag links (genuinely Uncategorized history), which
-- is distinct from an awaiting attempt (no envelope). Runs at most once per quiz;
-- later attach/detach only updates quiz_tag_map (future attempts). See 058 for
-- the full state/contract description.
CREATE OR REPLACE FUNCTION public.set_quiz_tags(p_quiz_id uuid, p_tag_ids uuid[], p_classify boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid;
        v_quiz_tenant uuid; v_was_classified boolean; v_bad int;
        v_input_has_tags boolean; v_now_has boolean; v_state text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'set_quiz_tags: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role IN ('orgAdmin','manager')) THEN
    RAISE EXCEPTION 'set_quiz_tags: insufficient role to assign quiz tags';
  END IF;
  SELECT tenant_id, (tags_classified_at IS NOT NULL) INTO v_quiz_tenant, v_was_classified
    FROM public.tenant_quizzes WHERE id = p_quiz_id;
  IF v_quiz_tenant IS NULL THEN RAISE EXCEPTION 'set_quiz_tags: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_quiz_tenant = v_tenant) THEN
    RAISE EXCEPTION 'set_quiz_tags: quiz not in caller tenant';
  END IF;

  v_input_has_tags := (p_tag_ids IS NOT NULL AND array_length(p_tag_ids, 1) IS NOT NULL);
  IF v_input_has_tags THEN
    SELECT count(*) INTO v_bad FROM unnest(p_tag_ids) AS x(tag_id)
      WHERE NOT EXISTS (SELECT 1 FROM public.tenant_quiz_tags t
                          WHERE t.id = x.tag_id AND t.tenant_id = v_quiz_tenant AND t.status = 'active');
    IF v_bad > 0 THEN RAISE EXCEPTION 'set_quiz_tags: % invalid/foreign/archived tag id(s)', v_bad; END IF;
  END IF;

  -- Guard: never accidentally finalize an untouched/legacy quiz.
  IF NOT v_was_classified AND NOT p_classify THEN
    IF v_input_has_tags THEN
      RAISE EXCEPTION 'set_quiz_tags: cannot assign tags to an unclassified quiz; pass p_classify=true to classify';
    END IF;
    RETURN jsonb_build_object('quiz_id', p_quiz_id, 'tag_ids', '[]'::jsonb, 'classification', 'awaiting');
  END IF;

  -- Replace mapping (attach/detach affects FUTURE attempts only).
  DELETE FROM public.quiz_tag_map WHERE quiz_id = p_quiz_id;
  INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id, created_by)
    SELECT p_quiz_id, x.tag_id, v_quiz_tenant, v_uid
    FROM unnest(COALESCE(p_tag_ids, '{}'::uuid[])) AS x(tag_id);
  v_now_has := EXISTS (SELECT 1 FROM public.quiz_tag_map WHERE quiz_id = p_quiz_id);

  IF NOT v_was_classified THEN
    -- First explicit classification: mark the quiz and inherit to awaiting attempts once.
    UPDATE public.tenant_quizzes SET tags_classified_at = now(), updated_at = now()
      WHERE id = p_quiz_id AND tags_classified_at IS NULL;

    -- Envelope for every attempt of this quiz that has none yet (source = initial).
    INSERT INTO public.quiz_attempt_tag_snapshots (attempt_id, tenant_id, quiz_id, snapshot_source)
      SELECT qa.id, qa.tenant_id, qa.quiz_id, 'initial_classification'
      FROM public.quiz_attempts qa
      WHERE qa.quiz_id = p_quiz_id
        AND NOT EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = qa.id);

    -- Tag links = the initial set (EMPTY for an intentionally-Uncategorized
    -- classification -> envelopes exist with zero links).
    INSERT INTO public.quiz_attempt_tags (attempt_id, tag_id, tenant_id)
      SELECT s.attempt_id, m.tag_id, s.tenant_id
      FROM public.quiz_attempt_tag_snapshots s
      JOIN public.quiz_tag_map m ON m.quiz_id = s.quiz_id
      WHERE s.quiz_id = p_quiz_id AND s.snapshot_source = 'initial_classification'
      ON CONFLICT (attempt_id, tag_id) DO NOTHING;
  END IF;

  v_state := CASE WHEN v_now_has THEN 'tagged' ELSE 'uncategorized' END;
  RETURN jsonb_build_object('quiz_id', p_quiz_id,
                            'tag_ids', to_jsonb(COALESCE(p_tag_ids, '{}'::uuid[])),
                            'classification', v_state);
END $$;
REVOKE ALL ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- Never weaken 056/057 confidentiality. To undo 059 (and only 059):
--   • CREATE OR REPLACE submit_quiz_attempt_atomic_v2 with the 055 body (drop the
--     tag-snapshot INSERT block only — keep learner-safe answers + solution snapshot);
--   • CREATE OR REPLACE set_quiz_tags with the 058 body (drop the inheritance block);
--   DROP TABLE IF EXISTS public.quiz_attempt_tags;
--   DROP TABLE IF EXISTS public.quiz_attempt_tag_snapshots;
