-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 058 — Quiz Taxonomy foundation (ADDITIVE, backend only)
--
-- Introduces a normalized, tenant-scoped quiz-tag taxonomy that will become the
-- canonical source for the Leadership Dashboard Knowledge Heatmap. Replaces the
-- untrustworthy free-text `tenant_quizzes.tags` JSONB (no identity, no dedupe,
-- analytics keyed on mutable display text) with:
--   1. tenant_quiz_tags — the controlled vocabulary: stable UUID identity,
--      case-insensitive uniqueness per tenant, active/archived lifecycle, a safe
--      merge relationship (merged_into), DB-generated normalized_label.
--   2. quiz_tag_map — many-to-many quiz↔tag current assignment, with tenant
--      consistency ENFORCED STRUCTURALLY via composite foreign keys (a map row,
--      its quiz, and its tag are guaranteed to share tenant_id — cross-tenant
--      mapping is impossible even through a buggy RPC).
--   3. tenant_quizzes.tags_classified_at — watermark: set once when a quiz first
--      receives a non-empty approved tag configuration. NULL = never classified;
--      its pre-classification attempts are "awaiting initial classification"
--      (attempt-time snapshotting + inheritance lives in migration 059).
--   4. SECURITY DEFINER management RPCs (create/rename/archive/merge/assign) with
--      explicit role gates. Governance (create/rename/archive/merge) = orgAdmin/
--      ralli_admin only; assignment of existing tags to quizzes = manager+.
--   5. list_quiz_tags_for_learner() — ADDITIVELY exposes normalized taxonomy
--      metadata (tagIds/tagDefs) alongside the legacy `tags` field. Labels only,
--      never question/answer content.
--
-- No RLS/table change to any answer-bearing table. Does NOT weaken migration 056
-- (get_quiz_review sanitization) or 057 (learner RLS lockdown). The new tables
-- and RPCs are dormant until the manager UI ships (no product writer yet), and
-- list_quiz_tags_for_learner keeps returning today's data (taxonomy is empty
-- until a manager classifies), so applying this migration is a no-op for every
-- live surface.
--
-- Learners: cannot read or write the taxonomy tables (RLS: managers/orgAdmin/
-- ralli_admin read; all writes via role-checked SECURITY DEFINER RPCs) and
-- cannot mutate tags (RPC role gate). They only ever see labels via the
-- learner-safe RPC. Tags carry no question or answer content.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 0. Composite-unique targets for the tenant-consistency foreign keys ───────
-- id is already unique (PK); a UNIQUE(id, tenant_id) lets quiz_tag_map reference
-- (quiz_id, tenant_id) and (tag_id, tenant_id) so the DB proves tenant equality.
ALTER TABLE public.tenant_quizzes
  ADD CONSTRAINT uq_tenant_quizzes_id_tenant UNIQUE (id, tenant_id);

-- ── 1. tenant_quiz_tags — controlled vocabulary ──────────────────────────────
CREATE TABLE IF NOT EXISTS public.tenant_quiz_tags (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  label            text NOT NULL,
  -- Case/whitespace-insensitive identity, computed by the DB so it can never
  -- drift from the label (used for dedupe + resolution).
  normalized_label text GENERATED ALWAYS AS (lower(btrim(label))) STORED,
  status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  -- When a tag is merged into another, the source is archived and points here;
  -- history keeps referencing the source id and resolves forward via this chain.
  merged_into      uuid REFERENCES public.tenant_quiz_tags(id) ON DELETE RESTRICT,
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_quiz_tags_label_not_blank CHECK (btrim(label) <> ''),
  CONSTRAINT tenant_quiz_tags_no_self_merge   CHECK (merged_into IS NULL OR merged_into <> id),
  CONSTRAINT tenant_quiz_tags_merged_archived CHECK (merged_into IS NULL OR status = 'archived'),
  CONSTRAINT uq_tenant_quiz_tags_id_tenant    UNIQUE (id, tenant_id)
);
-- Case-insensitive uniqueness across ALL statuses, per tenant. An archived label
-- stays GLOBALLY RESERVED: a tenant can never hold two stable ids that normalize
-- to the same label (even one archived), which would split historical analytics
-- under visually identical labels. Reusing an archived concept means RESTORING
-- its existing id (restore_quiz_tag), never minting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tenant_quiz_tags_norm
  ON public.tenant_quiz_tags (tenant_id, normalized_label);
CREATE INDEX IF NOT EXISTS idx_tenant_quiz_tags_tenant ON public.tenant_quiz_tags (tenant_id);

-- ── 2. quiz_tag_map — current quiz↔tag assignment (many-to-many) ─────────────
CREATE TABLE IF NOT EXISTS public.quiz_tag_map (
  quiz_id    uuid NOT NULL,
  tag_id     uuid NOT NULL,
  tenant_id  uuid NOT NULL,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (quiz_id, tag_id),
  -- Structural tenant consistency: quiz, tag and map row must share tenant_id.
  -- Deleting a quiz clears its mappings; a tag still mapped cannot be deleted
  -- (must be detached/archived/merged) — never silently corrupt history.
  FOREIGN KEY (quiz_id, tenant_id) REFERENCES public.tenant_quizzes  (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id,  tenant_id) REFERENCES public.tenant_quiz_tags (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_quiz_tag_map_tag    ON public.quiz_tag_map (tag_id);
CREATE INDEX IF NOT EXISTS idx_quiz_tag_map_tenant ON public.quiz_tag_map (tenant_id);

-- ── 3. tenant_quizzes.tags_classified_at — first-classification watermark ─────
ALTER TABLE public.tenant_quizzes
  ADD COLUMN IF NOT EXISTS tags_classified_at timestamptz;
COMMENT ON COLUMN public.tenant_quizzes.tags_classified_at IS
  'Set once when the quiz first receives a non-empty approved tag configuration (set_quiz_tags). NULL = never classified; its pre-classification attempts are "awaiting initial classification" (see migration 059).';

-- ── 4. RLS — managers/orgAdmin read; no direct writes (RPC-only) ─────────────
ALTER TABLE public.tenant_quiz_tags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.quiz_tag_map     ENABLE ROW LEVEL SECURITY;

-- Read: tenant managers/orgAdmins (+ ralli_admin cross-tenant). Learners NEVER
-- read these directly — only labels via list_quiz_tags_for_learner.
CREATE POLICY tenant_quiz_tags_select ON public.tenant_quiz_tags
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = public.get_my_tenant_id() AND public.get_my_role() IN ('orgAdmin','manager')));
CREATE POLICY quiz_tag_map_select ON public.quiz_tag_map
  FOR SELECT TO authenticated
  USING (public.is_ralli_admin()
         OR (tenant_id = public.get_my_tenant_id() AND public.get_my_role() IN ('orgAdmin','manager')));
-- No INSERT/UPDATE/DELETE policies: every mutation flows through the SECURITY
-- DEFINER RPCs below (owner writes bypass RLS). Direct writes are denied for all
-- authenticated roles — same posture as 055/057.

-- ── 5a. create_quiz_tag(label) — orgAdmin/ralli_admin only (governance) ───────
CREATE OR REPLACE FUNCTION public.create_quiz_tag(p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_norm text; v_id uuid;
        v_existing_status text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'create_quiz_tag: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role = 'orgAdmin') THEN
    RAISE EXCEPTION 'create_quiz_tag: only orgAdmin may manage the quiz tag taxonomy';
  END IF;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'create_quiz_tag: caller has no tenant'; END IF;
  IF btrim(COALESCE(p_label,'')) = '' THEN RAISE EXCEPTION 'create_quiz_tag: label required'; END IF;
  v_norm := lower(btrim(p_label));
  -- Reserved across ALL statuses: an archived label must be restored, not duplicated.
  SELECT status INTO v_existing_status FROM public.tenant_quiz_tags
    WHERE tenant_id = v_tenant AND normalized_label = v_norm;
  IF v_existing_status IS NOT NULL THEN
    RAISE EXCEPTION 'create_quiz_tag: a % tag named "%" already exists%',
      v_existing_status, btrim(p_label),
      CASE WHEN v_existing_status = 'archived' THEN ' — restore it instead of creating a duplicate' ELSE '' END
      USING ERRCODE = 'unique_violation';
  END IF;
  INSERT INTO public.tenant_quiz_tags (tenant_id, label, created_by)
    VALUES (v_tenant, btrim(p_label), v_uid)
    RETURNING id INTO v_id;
  RETURN (SELECT jsonb_build_object('id', t.id, 'tenant_id', t.tenant_id, 'label', t.label,
                                    'normalized_label', t.normalized_label, 'status', t.status)
          FROM public.tenant_quiz_tags t WHERE t.id = v_id);
END $$;
REVOKE ALL ON FUNCTION public.create_quiz_tag(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.create_quiz_tag(text) TO authenticated;

-- ── 5b. rename_quiz_tag(tag_id, label) — orgAdmin/ralli_admin; keeps id ───────
-- Renaming preserves the stable id (history/analytics unaffected); only the
-- display label + normalized_label change.
CREATE OR REPLACE FUNCTION public.rename_quiz_tag(p_tag_id uuid, p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_tag_tenant uuid; v_norm text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'rename_quiz_tag: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role = 'orgAdmin') THEN
    RAISE EXCEPTION 'rename_quiz_tag: only orgAdmin may manage the quiz tag taxonomy';
  END IF;
  IF btrim(COALESCE(p_label,'')) = '' THEN RAISE EXCEPTION 'rename_quiz_tag: label required'; END IF;
  SELECT tenant_id INTO v_tag_tenant FROM public.tenant_quiz_tags WHERE id = p_tag_id;
  IF v_tag_tenant IS NULL THEN RAISE EXCEPTION 'rename_quiz_tag: tag not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tag_tenant = v_tenant) THEN
    RAISE EXCEPTION 'rename_quiz_tag: tag not in caller tenant';
  END IF;
  v_norm := lower(btrim(p_label));
  -- Reserved across ALL statuses (cannot rename onto an active OR archived label).
  IF EXISTS (SELECT 1 FROM public.tenant_quiz_tags
               WHERE tenant_id = v_tag_tenant AND normalized_label = v_norm AND id <> p_tag_id) THEN
    RAISE EXCEPTION 'rename_quiz_tag: a tag named "%" already exists (active or archived)', btrim(p_label)
      USING ERRCODE = 'unique_violation';
  END IF;
  UPDATE public.tenant_quiz_tags SET label = btrim(p_label), updated_at = now() WHERE id = p_tag_id;
  RETURN (SELECT jsonb_build_object('id', t.id, 'label', t.label,
                                    'normalized_label', t.normalized_label, 'status', t.status)
          FROM public.tenant_quiz_tags t WHERE t.id = p_tag_id);
END $$;
REVOKE ALL ON FUNCTION public.rename_quiz_tag(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rename_quiz_tag(uuid, text) TO authenticated;

-- ── 5c. archive_quiz_tag(tag_id) — orgAdmin/ralli_admin; preserves history ────
-- Retires a tag from the active vocabulary (no longer assignable/offered) while
-- keeping every existing mapping and historical attribution intact.
CREATE OR REPLACE FUNCTION public.archive_quiz_tag(p_tag_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_tag_tenant uuid;
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
  UPDATE public.tenant_quiz_tags SET status = 'archived', updated_at = now() WHERE id = p_tag_id;
  RETURN jsonb_build_object('id', p_tag_id, 'status', 'archived');
END $$;
REVOKE ALL ON FUNCTION public.archive_quiz_tag(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.archive_quiz_tag(uuid) TO authenticated;

-- ── 5c'. restore_quiz_tag(tag_id) — orgAdmin/ralli_admin; un-archive by id ────
-- The only way to reuse an archived concept (labels are globally reserved). Only
-- a plain archived tag can be restored; a MERGED tag (merged_into set) stays
-- consolidated and cannot be revived (its concept now lives in the target).
-- Uniqueness is guaranteed: the archived label already occupies its (tenant,
-- normalized_label) slot, so flipping it back to active never collides.
CREATE OR REPLACE FUNCTION public.restore_quiz_tag(p_tag_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid;
        v_tag_tenant uuid; v_status text; v_merged uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'restore_quiz_tag: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role = 'orgAdmin') THEN
    RAISE EXCEPTION 'restore_quiz_tag: only orgAdmin may manage the quiz tag taxonomy';
  END IF;
  SELECT tenant_id, status, merged_into INTO v_tag_tenant, v_status, v_merged
    FROM public.tenant_quiz_tags WHERE id = p_tag_id;
  IF v_tag_tenant IS NULL THEN RAISE EXCEPTION 'restore_quiz_tag: tag not found'; END IF;
  IF NOT (public.is_ralli_admin() OR v_tag_tenant = v_tenant) THEN
    RAISE EXCEPTION 'restore_quiz_tag: tag not in caller tenant';
  END IF;
  IF v_status <> 'archived' THEN RAISE EXCEPTION 'restore_quiz_tag: tag is not archived'; END IF;
  IF v_merged IS NOT NULL THEN RAISE EXCEPTION 'restore_quiz_tag: a merged tag cannot be restored'; END IF;
  UPDATE public.tenant_quiz_tags SET status = 'active', updated_at = now() WHERE id = p_tag_id;
  RETURN (SELECT jsonb_build_object('id', t.id, 'label', t.label,
                                    'normalized_label', t.normalized_label, 'status', t.status)
          FROM public.tenant_quiz_tags t WHERE t.id = p_tag_id);
END $$;
REVOKE ALL ON FUNCTION public.restore_quiz_tag(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.restore_quiz_tag(uuid) TO authenticated;

-- ── 5d. merge_quiz_tags(source, target) — orgAdmin/ralli_admin ────────────────
-- Repoints CURRENT quiz mappings from source→target, then archives source with
-- merged_into=target. Historical attempt snapshots (migration 059) keep pointing
-- at the source id and resolve forward via merged_into — so history is preserved
-- immutably while the live vocabulary consolidates.
CREATE OR REPLACE FUNCTION public.merge_quiz_tags(p_source uuid, p_target uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid;
        v_src_tenant uuid; v_tgt_tenant uuid;
        v_src_status text; v_tgt_status text; v_src_merged uuid; v_tgt_merged uuid;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'merge_quiz_tags: must be authenticated'; END IF;
  v_role := public.get_my_role();
  v_tenant := public.get_my_tenant_id();
  IF NOT (public.is_ralli_admin() OR v_role = 'orgAdmin') THEN
    RAISE EXCEPTION 'merge_quiz_tags: only orgAdmin may manage the quiz tag taxonomy';
  END IF;
  IF p_source IS NULL OR p_target IS NULL THEN RAISE EXCEPTION 'merge_quiz_tags: source and target required'; END IF;
  IF p_source = p_target THEN RAISE EXCEPTION 'merge_quiz_tags: cannot merge a tag into itself'; END IF;
  SELECT tenant_id, status, merged_into INTO v_src_tenant, v_src_status, v_src_merged FROM public.tenant_quiz_tags WHERE id = p_source;
  SELECT tenant_id, status, merged_into INTO v_tgt_tenant, v_tgt_status, v_tgt_merged FROM public.tenant_quiz_tags WHERE id = p_target;
  IF v_src_tenant IS NULL OR v_tgt_tenant IS NULL THEN RAISE EXCEPTION 'merge_quiz_tags: source or target not found'; END IF;
  IF v_src_tenant <> v_tgt_tenant THEN RAISE EXCEPTION 'merge_quiz_tags: cross-tenant merge rejected'; END IF;
  IF NOT (public.is_ralli_admin() OR v_src_tenant = v_tenant) THEN
    RAISE EXCEPTION 'merge_quiz_tags: tags not in caller tenant';
  END IF;
  -- Source must be a live tag; target must be a live, non-merged tag. Because the
  -- target is required to be ACTIVE and NON-MERGED (merged_into IS NULL), it never
  -- points anywhere — so archiving the source into it cannot create a merge cycle
  -- or chain (a merged/archived tag can never be a merge target).
  IF v_src_status <> 'active' THEN RAISE EXCEPTION 'merge_quiz_tags: source must be an active tag'; END IF;
  IF v_tgt_status <> 'active' THEN RAISE EXCEPTION 'merge_quiz_tags: target must be an active tag'; END IF;
  IF v_src_merged IS NOT NULL OR v_tgt_merged IS NOT NULL THEN
    RAISE EXCEPTION 'merge_quiz_tags: cannot merge an already-merged tag';
  END IF;

  -- Repoint current mappings: attach target wherever source is mapped, then drop
  -- the source mappings. (attempt-time snapshots are NOT touched — immutable.)
  INSERT INTO public.quiz_tag_map (quiz_id, tag_id, tenant_id, created_by)
    SELECT m.quiz_id, p_target, m.tenant_id, v_uid
    FROM public.quiz_tag_map m
    WHERE m.tag_id = p_source
    ON CONFLICT (quiz_id, tag_id) DO NOTHING;
  DELETE FROM public.quiz_tag_map WHERE tag_id = p_source;

  UPDATE public.tenant_quiz_tags
    SET status = 'archived', merged_into = p_target, updated_at = now()
    WHERE id = p_source;
  RETURN jsonb_build_object('source', p_source, 'target', p_target, 'merged', true);
END $$;
REVOKE ALL ON FUNCTION public.merge_quiz_tags(uuid, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.merge_quiz_tags(uuid, uuid) TO authenticated;

-- ── 5e. set_quiz_tags(quiz_id, tag_ids[], classify) — manager+ EXPLICIT decide ─
-- Classification is an explicit, server-authoritative decision — NOT inferred
-- from whether the tag array happens to be non-empty. Three states:
--   • awaiting        — tags_classified_at IS NULL (no decision made yet).
--   • tagged          — classified with ≥1 current tag.
--   • uncategorized   — classified with zero current tags (an intentional choice).
-- Contract:
--   p_classify=true  → record the classification decision now if not already
--                      (tagged when tag_ids non-empty, intentionally Uncategorized
--                      when empty). First decision sets tags_classified_at.
--   p_classify=false → do NOT finalize an unclassified quiz. Empty tag_ids = a
--                      harmless no-op (stays awaiting); non-empty = rejected. On an
--                      ALREADY-classified quiz it just attaches/detaches (future
--                      attempts only) and can never revert to awaiting.
-- NOTE: attempt-time envelope INHERITANCE on first classification is added by
-- migration 059 (which CREATE OR REPLACEs this to a superset). 058/059 apply
-- together, before any UI caller exists.
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

  -- First explicit classification (tagged OR intentionally Uncategorized).
  IF NOT v_was_classified THEN
    UPDATE public.tenant_quizzes SET tags_classified_at = now(), updated_at = now()
      WHERE id = p_quiz_id AND tags_classified_at IS NULL;
  END IF;

  v_state := CASE WHEN v_now_has THEN 'tagged' ELSE 'uncategorized' END;
  RETURN jsonb_build_object('quiz_id', p_quiz_id,
                            'tag_ids', to_jsonb(COALESCE(p_tag_ids, '{}'::uuid[])),
                            'classification', v_state);
END $$;
REVOKE ALL ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_quiz_tags(uuid, uuid[], boolean) TO authenticated;

-- ── 6. list_quiz_tags_for_learner() — ADDITIVE taxonomy metadata ─────────────
-- Same identity/tenant/eligibility-or-own-history scoping as 056. Now returns,
-- per accessible quiz: the legacy `tags` (unchanged, backward-compatible) PLUS
-- normalized taxonomy `tagIds` and `tagDefs` [{id,label}] resolved from the
-- quiz_tag_map. Labels only — never questions/answers/keys. Aggregation still
-- consumes `tags`; the taxonomy fields are for the Phase-3 Heatmap cutover.
CREATE OR REPLACE FUNCTION public.list_quiz_tags_for_learner()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_tenant uuid; v_out jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'must be authenticated'; END IF;
  SELECT tenant_id INTO v_tenant FROM public.profiles
    WHERE id = v_uid AND COALESCE(status,'active') <> 'inactive';
  IF v_tenant IS NULL THEN RETURN '[]'::jsonb; END IF;

  SELECT COALESCE(jsonb_agg(row_obj), '[]'::jsonb) INTO v_out FROM (
    SELECT jsonb_build_object(
             'id',   tq.id,
             'tags', tq.tags,   -- legacy, unchanged (backward-compatible)
             'tagIds',  COALESCE((SELECT jsonb_agg(m.tag_id ORDER BY t.label)
                                   FROM public.quiz_tag_map m
                                   JOIN public.tenant_quiz_tags t ON t.id = m.tag_id
                                   WHERE m.quiz_id = tq.id), '[]'::jsonb),
             'tagDefs', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', t.id, 'label', t.label) ORDER BY t.label)
                                   FROM public.quiz_tag_map m
                                   JOIN public.tenant_quiz_tags t ON t.id = m.tag_id
                                   WHERE m.quiz_id = tq.id), '[]'::jsonb)
           ) AS row_obj
    FROM public.tenant_quizzes tq
    WHERE tq.tenant_id = v_tenant
      AND (
        public._quiz_learner_can_access(v_uid, tq.id)
        OR EXISTS (SELECT 1 FROM public.quiz_attempts qa WHERE qa.quiz_id = tq.id AND qa.user_id = v_uid)
      )
  ) s;
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION public.list_quiz_tags_for_learner() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.list_quiz_tags_for_learner() TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- Never weaken 056/057. To undo 058 (and only 058):
--   DROP FUNCTION IF EXISTS public.set_quiz_tags(uuid, uuid[], boolean);
--   DROP FUNCTION IF EXISTS public.merge_quiz_tags(uuid, uuid);
--   DROP FUNCTION IF EXISTS public.restore_quiz_tag(uuid);
--   DROP FUNCTION IF EXISTS public.archive_quiz_tag(uuid);
--   DROP FUNCTION IF EXISTS public.rename_quiz_tag(uuid, text);
--   DROP FUNCTION IF EXISTS public.create_quiz_tag(text);
--   -- restore 056's list_quiz_tags_for_learner body (id + tags only);
--   DROP TABLE IF EXISTS public.quiz_tag_map;
--   DROP TABLE IF EXISTS public.tenant_quiz_tags;
--   ALTER TABLE public.tenant_quizzes DROP COLUMN IF EXISTS tags_classified_at;
--   ALTER TABLE public.tenant_quizzes DROP CONSTRAINT IF EXISTS uq_tenant_quizzes_id_tenant;
-- (Requires migration 059 to be rolled back first — it depends on these tables.)
