-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 060 — Archived-tag integrity (ADDITIVE forward migration)
--
-- Makes quiz_tag_map the clean "current ACTIVE classification" source of truth so
-- an archived tag can never masquerade as a current quiz classification (the
-- Library "Tagged" badge bug) and can never leak into the future Knowledge
-- Heatmap's canonical current-mapping input.
--
--   1. archive_quiz_tag — now atomic + guarded: rejects the archive if it would
--      leave ANY currently-mapped quiz with zero OTHER active tags; otherwise
--      archives the tag AND detaches its current quiz_tag_map rows. Immutable
--      attempt-tag snapshots are never touched (they live in quiz_attempt_tags /
--      quiz_attempt_tag_snapshots and keep the source tag identity via a
--      RESTRICT FK; the tag row is archived, never deleted).
--   2. Conditional one-time cleanup — deletes an EXISTING archived mapping ONLY
--      when that quiz already has another active mapped tag. A quiz whose ONLY
--      association is an archived tag is LEFT AS-IS (a temporary migration
--      exception the UI flags "Tag required"); the manager assigns an active
--      replacement, and set_quiz_tags removes the archived mapping normally.
--   3. set_quiz_tags — now server-authoritative: rejects a submitted set with
--      zero ACTIVE same-tenant tags (empty / archived-only / foreign-tenant /
--      merged-source). Every saved quiz must carry ≥1 active tag. First-
--      classification + historical inheritance behavior is preserved verbatim.
--
-- Concurrency: both mutators take a per-tenant advisory xact lock, so an archive
-- and an assignment cannot interleave into an invalid (zero-active-tag) state,
-- with no lock-ordering deadlock. Does NOT edit applied migrations 058/059, and
-- does NOT change grading, XP, RLS, or the confidentiality functions (056/057).
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. archive_quiz_tag — block-or-detach, atomic ────────────────────────────
CREATE OR REPLACE FUNCTION public.archive_quiz_tag(p_tag_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_tag_tenant uuid;
        v_blocked int; v_detached int;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'archive_quiz_tag: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role = 'orgAdmin') THEN
    RAISE EXCEPTION 'archive_quiz_tag: only orgAdmin may manage the quiz tag taxonomy';
  END IF;
  SELECT tenant_id INTO v_tag_tenant FROM public.tenant_quiz_tags WHERE id = p_tag_id;
  IF v_tag_tenant IS NULL THEN RAISE EXCEPTION 'archive_quiz_tag: tag not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tag_tenant = v_tenant) THEN
    RAISE EXCEPTION 'archive_quiz_tag: tag not in caller tenant';
  END IF;

  -- Serialize all taxonomy mutations in the tenant so an assignment cannot race
  -- a tag into an affected quiz between the guard count and the detach.
  PERFORM pg_advisory_xact_lock(hashtextextended('quiz_taxonomy:' || v_tag_tenant::text, 0));

  -- Guard: how many quizzes currently mapped to this tag would be left with NO
  -- other active tag if we archived it? (The tag itself is being archived, so it
  -- is excluded from "other active".)
  SELECT count(*) INTO v_blocked
  FROM public.quiz_tag_map m
  WHERE m.tag_id = p_tag_id
    AND NOT EXISTS (
      SELECT 1 FROM public.quiz_tag_map m2
      JOIN public.tenant_quiz_tags t2 ON t2.id = m2.tag_id
      WHERE m2.quiz_id = m.quiz_id AND m2.tag_id <> p_tag_id AND t2.status = 'active'
    );

  IF v_blocked > 0 THEN
    RAISE EXCEPTION 'archive_quiz_tag: This tag is the only active tag on % quiz(zes). Assign a replacement tag or merge it before archiving.', v_blocked
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Safe: archive the tag and detach its CURRENT mappings. Immutable attempt
  -- snapshots (quiz_attempt_tags) are untouched — they reference the tag id via a
  -- separate table + RESTRICT FK, and the tag row is archived, never deleted.
  UPDATE public.tenant_quiz_tags SET status = 'archived', updated_at = now() WHERE id = p_tag_id;
  DELETE FROM public.quiz_tag_map WHERE tag_id = p_tag_id;
  GET DIAGNOSTICS v_detached = ROW_COUNT;

  RETURN jsonb_build_object('id', p_tag_id, 'status', 'archived', 'detached', v_detached);
END $$;
REVOKE ALL ON FUNCTION public.archive_quiz_tag(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_quiz_tag(uuid) TO authenticated;

-- ── 2. Conditional one-time cleanup of pre-060 archived mappings ─────────────
-- Detach an archived mapping ONLY when the quiz already has another active mapped
-- tag (so cleanup can never strand a quiz at zero active tags). A quiz whose only
-- association is an archived tag keeps that row temporarily until a manager
-- assigns an active replacement (set_quiz_tags then removes it). Snapshots
-- untouched.
DELETE FROM public.quiz_tag_map m
USING public.tenant_quiz_tags t
WHERE m.tag_id = t.id
  AND t.status = 'archived'
  AND EXISTS (
    SELECT 1 FROM public.quiz_tag_map m2
    JOIN public.tenant_quiz_tags t2 ON t2.id = m2.tag_id
    WHERE m2.quiz_id = m.quiz_id AND t2.status = 'active'
  );

-- ── 3. set_quiz_tags — server-authoritative ≥1-active-tag invariant ──────────
-- Supersedes the 059 version. Reproduces its grading/inheritance behavior EXACTLY
-- except: an empty / archived-only / foreign-tenant / merged-source set is now
-- rejected (every saved quiz must carry ≥1 active same-tenant tag), and a
-- per-tenant advisory lock prevents an archive/assignment race. There is no
-- longer an "uncategorized" outcome.
CREATE OR REPLACE FUNCTION public.set_quiz_tags(p_quiz_id uuid, p_tag_ids uuid[], p_classify boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid;
        v_quiz_tenant uuid; v_was_classified boolean; v_bad int;
        v_input_has_tags boolean;
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

  -- Serialize with archive (same per-tenant lock) so a tag cannot be archived
  -- between validation and insert, and so a save cannot re-add a just-archived tag.
  PERFORM pg_advisory_xact_lock(hashtextextended('quiz_taxonomy:' || v_quiz_tenant::text, 0));

  -- REQUIRE ≥1 tag, and every tag must be ACTIVE + same tenant (this rejects
  -- empty, archived-only, foreign-tenant and merged-source sets — a merged/
  -- archived source is not status='active').
  v_input_has_tags := (p_tag_ids IS NOT NULL AND array_length(p_tag_ids, 1) IS NOT NULL);
  IF NOT v_input_has_tags THEN
    RAISE EXCEPTION 'set_quiz_tags: at least one active tag is required';
  END IF;
  SELECT count(*) INTO v_bad FROM unnest(p_tag_ids) AS x(tag_id)
    WHERE NOT EXISTS (SELECT 1 FROM public.tenant_quiz_tags t
                        WHERE t.id = x.tag_id AND t.tenant_id = v_quiz_tenant AND t.status = 'active');
  IF v_bad > 0 THEN RAISE EXCEPTION 'set_quiz_tags: % invalid/foreign/archived tag id(s)', v_bad; END IF;

  -- Unclassified quizzes must be explicitly classified (UI passes p_classify=true).
  IF NOT v_was_classified AND NOT p_classify THEN
    RAISE EXCEPTION 'set_quiz_tags: cannot assign tags to an unclassified quiz; pass p_classify=true to classify';
  END IF;

  -- Replace mapping (attach/detach affects FUTURE attempts only).
  DELETE FROM public.quiz_tag_map WHERE quiz_id = p_quiz_id;
  INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id, created_by)
    SELECT p_quiz_id, x.tag_id, v_quiz_tenant, v_uid
    FROM unnest(p_tag_ids) AS x(tag_id);

  IF NOT v_was_classified THEN
    -- First explicit classification: mark the quiz and inherit to awaiting attempts once.
    UPDATE public.tenant_quizzes SET tags_classified_at = now(), updated_at = now()
      WHERE id = p_quiz_id AND tags_classified_at IS NULL;

    INSERT INTO public.quiz_attempt_tag_snapshots (attempt_id, tenant_id, quiz_id, snapshot_source)
      SELECT qa.id, qa.tenant_id, qa.quiz_id, 'initial_classification'
      FROM public.quiz_attempts qa
      WHERE qa.quiz_id = p_quiz_id
        AND NOT EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = qa.id);

    INSERT INTO public.quiz_attempt_tags (attempt_id, tag_id, tenant_id)
      SELECT s.attempt_id, m.tag_id, s.tenant_id
      FROM public.quiz_attempt_tag_snapshots s
      JOIN public.quiz_tag_map m ON m.quiz_id = s.quiz_id
      WHERE s.quiz_id = p_quiz_id AND s.snapshot_source = 'initial_classification'
      ON CONFLICT (attempt_id, tag_id) DO NOTHING;
  END IF;

  RETURN jsonb_build_object('quiz_id', p_quiz_id,
                            'tag_ids', to_jsonb(p_tag_ids),
                            'classification', 'tagged');
END $$;
REVOKE ALL ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- Restore the 058 archive_quiz_tag body (status-only) and the 059 set_quiz_tags
-- body (allowed empty/uncategorized). The conditional cleanup is not reversible
-- (deleted archived mappings would have to be re-derived from history); it only
-- removed archived mappings from quizzes that still have an active tag, so no
-- active classification is lost. Never weaken 056/057.
