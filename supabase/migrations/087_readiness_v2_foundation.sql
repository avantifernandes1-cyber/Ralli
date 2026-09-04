-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 087 — Readiness V2 foundation + SHADOW calculation (ADDITIVE, backend only)
--
-- Readiness V2 measures VERIFIED QUIZ KNOWLEDGE MASTERY ONLY. This migration adds,
-- on top of the existing versioned readiness infrastructure (migrations 050–053):
--   1. readiness_tag_designations — versioned, tenant-scoped set of quiz tags a
--      manager designates as readiness knowledge areas (+ required flag). Ordinary
--      tags never affect readiness unless designated. Tied to a formula version so
--      the config is versioned/effective-dated/auditable and historical scores keep
--      their exact config.
--   2. readiness_v2_config_hash — one canonical config-hash construction (mirrors
--      the 052 v1 discipline) so server code is reproducible byte-for-byte.
--   3. Manager/orgAdmin (+ ralli_admin) SECURITY DEFINER configuration RPCs:
--      candidates listing (with assessment-support counts + warnings), get config,
--      save draft, validate, and activate (draft→active, supersede prior, audited).
--   4. Server-authoritative SHADOW compute: readiness_compute_v2 (one rep) +
--      readiness_run_shadow (a tenant population) + readiness_process_recalc_batch
--      (durable, idempotent queue drain). Writes ONLY the versioned shadow source
--      (readiness_scores_current / _history / _runs). Never touches legacy
--      readiness_scores, and no UI reads these — this is shadow, not cutover.
--   5. Learner-safe own-result read + authorized legacy-vs-V2 comparison report.
--
-- Mastery model (platform-owned in beta): per-quiz mastery FIRST (≤3 most-recent
-- CURRENT-COMPARABLE verified attempts, 60-day half-life, recency-only weighting),
-- one MANAGER-SELECTED PRIMARY readiness tag per quiz, EQUAL-AREA averaging, breadth gates
-- (≥3 distinct quizzes, ≥2 readiness tags, ≥10 distinct current-version graded
-- questions, all required tags covered), 120-day staleness, bands Ready≥80 /
-- Developing 65–79 / Needs Attention <65. Missing evidence is NEVER zero:
-- insufficient breadth → success_status='insufficient_evidence' (Establishing);
-- all-stale evidence → 'insufficient_evidence' + flags.state='stale'.
--
-- Security: every function is SECURITY DEFINER with SET search_path=''. Clients
-- cannot write any readiness table (no new write policies; RLS from 051 unchanged).
-- Compute/run/queue entry points are REVOKED from anon/authenticated (server-only)
-- except the explicitly manager/admin-gated config + report RPCs and the learner
-- own-result read. No answer keys or question text ever leave these functions.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Versioned readiness-tag designations + RLS + canonical config hash
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.readiness_tag_designations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  formula_version_id  uuid NOT NULL,
  tag_id              uuid NOT NULL,
  is_required         boolean NOT NULL DEFAULT false,
  created_by          uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (formula_version_id, tag_id),
  -- Designation, its formula version, and its tag are all the SAME tenant (DB-enforced):
  CONSTRAINT rtd_formula_same_tenant FOREIGN KEY (formula_version_id, tenant_id)
    REFERENCES public.readiness_formula_versions (id, tenant_id) ON DELETE CASCADE,
  CONSTRAINT rtd_tag_same_tenant FOREIGN KEY (tag_id, tenant_id)
    REFERENCES public.tenant_quiz_tags (id, tenant_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_rtd_version ON public.readiness_tag_designations (formula_version_id);
CREATE INDEX IF NOT EXISTS idx_rtd_tenant_tag ON public.readiness_tag_designations (tenant_id, tag_id);

ALTER TABLE public.readiness_tag_designations ENABLE ROW LEVEL SECURITY;

-- MANAGER-SELECTED PRIMARY readiness tag per quiz (the ONE area a quiz counts toward
-- for official scoring). Additive, nullable; composite FK keeps it same-tenant. It is
-- NEVER auto-chosen by id/order — a quiz with no valid primary is excluded from
-- official scoring with an honest reason. Set only via the role-gated RPC below.
ALTER TABLE public.tenant_quizzes ADD COLUMN IF NOT EXISTS primary_readiness_tag_id uuid;
DO $$ BEGIN
  ALTER TABLE public.tenant_quizzes
    ADD CONSTRAINT tq_primary_readiness_tag_same_tenant
    FOREIGN KEY (primary_readiness_tag_id, tenant_id)
    REFERENCES public.tenant_quiz_tags (id, tenant_id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Reps may read the ACTIVE version's designations (what readiness measures);
-- managers/orgAdmin read all statuses in their tenant; platform admins cross-tenant.
-- No client writes (server-only, like every readiness table).
DROP POLICY IF EXISTS rtd_select ON public.readiness_tag_designations;
CREATE POLICY rtd_select ON public.readiness_tag_designations
  FOR SELECT TO authenticated
  USING (
    public.is_ralli_admin()
    OR (tenant_id = public.readiness_caller_tenant()
        AND (public.readiness_caller_is_manager()
             OR EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                        WHERE v.id = formula_version_id AND v.status = 'active')))
  );

-- Canonical V2 config-hash. Platform-owned formula params are embedded so a
-- version's config_hash captures the EXACT formula that produced its scores:
--   v2_quiz_mastery|threshold=<t>|hl=60|stale=120|cap=3|minq=3|mint=2|minqu=10|bands=65/80|tags=<tagid>:<req>,...
-- tags sorted by tag_id ascending; req = 1 (required) | 0; empty set → tags=.
CREATE OR REPLACE FUNCTION public.readiness_v2_config_hash(p_threshold integer, p_version_id uuid)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT encode(extensions.digest(
    'v2_quiz_mastery|threshold=' || COALESCE(p_threshold, 80)::text
      || '|hl=60|stale=120|cap=3|minq=3|mint=2|minqu=10|bands=65/80|tags='
      || COALESCE((
           SELECT string_agg(d.tag_id::text || ':' || (CASE WHEN d.is_required THEN '1' ELSE '0' END), ',' ORDER BY d.tag_id)
           FROM public.readiness_tag_designations d
           WHERE d.formula_version_id = p_version_id
         ), ''),
    'sha256'), 'hex');
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Authorization + population + tag-support helpers
-- ══════════════════════════════════════════════════════════════════════════════

-- Who may CONFIGURE readiness: tenant manager (orgAdmin or 'manager') or platform
-- admin. Kept separate from the read-side readiness_caller_is_manager() (orgAdmin
-- only) so a future 'manager' role can configure without widening read RLS.
CREATE OR REPLACE FUNCTION public.readiness_caller_can_configure()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT public.is_ralli_admin() OR EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role IN ('orgAdmin','manager')
  );
$$;

-- Scorable readiness population: an ACTIVE learner (role='user') of the tenant.
-- Managers/admins are never scored as reps.
CREATE OR REPLACE FUNCTION public.readiness_is_scorable_rep(p_tenant uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role = 'user'
  );
$$;

-- Assessment-support metrics for ONE tag (tenant-scoped), used by the Settings UI
-- and by config validation. Counts only CURRENTLY-mapped (quiz_tag_map) ACTIVE
-- quizzes, and distinct CURRENT-revision gradeable question ids across them.
-- Returns one row; NULL tag → all zero. No question/answer content is returned.
CREATE OR REPLACE FUNCTION public.readiness_tag_support(p_tenant uuid, p_tag_id uuid)
RETURNS TABLE (active_quiz_count integer, distinct_question_count integer)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH mapped AS (
    SELECT q.id AS quiz_id, q.questions
    FROM public.quiz_tag_map m
    JOIN public.tenant_quizzes q ON q.id = m.quiz_id AND q.tenant_id = m.tenant_id
    WHERE m.tenant_id = p_tenant AND m.tag_id = p_tag_id AND q.status = 'active'
  ),
  qs AS (
    SELECT DISTINCT mapped.quiz_id,
           COALESCE(e->>'id', mapped.quiz_id::text || ':' || (ord::text)) AS qkey
    FROM mapped
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(mapped.questions)='array' THEN mapped.questions ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS t(e, ord)
    WHERE (e->>'type') IN ('mc','tf','type','match','slider')
  )
  SELECT
    (SELECT count(*)::int FROM mapped),
    (SELECT count(DISTINCT (qs.quiz_id::text || '|' || qs.qkey))::int FROM qs);
$$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — Configuration RPCs (manager/orgAdmin/admin authorized)
-- ══════════════════════════════════════════════════════════════════════════════

-- Resolve the tenant's editable DRAFT V2 version (create one if absent). Internal.
CREATE OR REPLACE FUNCTION public.readiness_v2_ensure_draft(p_tenant uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_id uuid; v_next int; v_threshold int;
BEGIN
  SELECT id INTO v_id FROM public.readiness_formula_versions
   WHERE tenant_id = p_tenant AND status = 'draft'
     AND configuration->>'model' = 'v2_quiz_mastery'
   ORDER BY version DESC LIMIT 1;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  SELECT COALESCE(max(version),0)+1 INTO v_next FROM public.readiness_formula_versions WHERE tenant_id = p_tenant;
  SELECT public.readiness_valid_threshold(ts.learning_settings->>'readinessThreshold')
    INTO v_threshold FROM public.tenant_settings ts WHERE ts.tenant_id = p_tenant;
  v_threshold := COALESCE(v_threshold, 80);

  INSERT INTO public.readiness_formula_versions
    (tenant_id, version, status, configuration, readiness_threshold, config_hash, source, created_by, created_at)
  VALUES (p_tenant, v_next, 'draft',
          '{"model":"v2_quiz_mastery","params":{"halfLifeDays":60,"staleDays":120,"attemptCap":3,"minQuizzes":3,"minTags":2,"minQuestions":10,"bands":{"ready":80,"developing":65}}}'::jsonb,
          v_threshold, 'pending', 'tenant_customized', auth.uid(), now())
  RETURNING id INTO v_id;

  -- config_hash reflects the (currently empty) designation set; recomputed on save.
  UPDATE public.readiness_formula_versions
     SET config_hash = public.readiness_v2_config_hash(v_threshold, v_id) WHERE id = v_id;

  INSERT INTO public.readiness_formula_lifecycle_events
    (tenant_id, formula_version_id, event_type, actor_id, actor_role, config_hash, to_version_id, metadata)
  VALUES (p_tenant, v_id, 'created', auth.uid(), 'manager',
          (SELECT config_hash FROM public.readiness_formula_versions WHERE id=v_id), v_id,
          jsonb_build_object('model','v2_quiz_mastery'));
  RETURN v_id;
END $$;

-- List EVERY active quiz tag in the caller's tenant with readiness-support metadata
-- for the Settings → Readiness surface. counts_toward_readiness / is_required reflect
-- the current DRAFT (if any) else the ACTIVE V2 version. Managers/admins only.
CREATE OR REPLACE FUNCTION public.readiness_v2_tag_candidates()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_cfg uuid; v_rows jsonb;
BEGIN
  IF NOT public.readiness_caller_can_configure() THEN
    RAISE EXCEPTION 'readiness: not authorized to view readiness configuration';
  END IF;
  v_tenant := public.readiness_caller_tenant();
  IF v_tenant IS NULL AND NOT public.is_ralli_admin() THEN RAISE EXCEPTION 'readiness: caller has no tenant'; END IF;

  SELECT id INTO v_cfg FROM public.readiness_formula_versions
   WHERE tenant_id = v_tenant AND configuration->>'model'='v2_quiz_mastery' AND status IN ('draft','active')
   ORDER BY (status='draft') DESC, version DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'label')), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'tagId', t.id, 'label', t.label, 'status', t.status,
      'countsTowardReadiness', (d.tag_id IS NOT NULL),
      'isRequired', COALESCE(d.is_required, false),
      'activeQuizCount', s.active_quiz_count,
      'distinctQuestionCount', s.distinct_question_count,
      'coverageSufficient', (s.active_quiz_count >= 1 AND s.distinct_question_count >= 1),
      'warnings', (
        CASE WHEN t.status <> 'active' THEN jsonb_build_array('archived_or_merged') ELSE '[]'::jsonb END
        || CASE WHEN s.active_quiz_count = 0 THEN jsonb_build_array('no_active_quiz') ELSE '[]'::jsonb END
        || CASE WHEN s.active_quiz_count >= 1 AND s.distinct_question_count = 0 THEN jsonb_build_array('no_graded_questions') ELSE '[]'::jsonb END
        || CASE WHEN d.tag_id IS NOT NULL AND (s.active_quiz_count = 0 OR s.distinct_question_count = 0)
                THEN jsonb_build_array('designated_but_unsupported') ELSE '[]'::jsonb END
      )
    ) AS row
    FROM public.tenant_quiz_tags t
    LEFT JOIN public.readiness_tag_designations d ON d.tag_id = t.id AND d.formula_version_id = v_cfg
    CROSS JOIN LATERAL public.readiness_tag_support(v_tenant, t.id) s
    WHERE t.tenant_id = v_tenant AND t.status = 'active'
  ) sub;

  RETURN jsonb_build_object('tenantId', v_tenant, 'configVersionId', v_cfg, 'tags', v_rows);
END $$;

-- Compute validity of a version's designation set (setup-complete gate).
CREATE OR REPLACE FUNCTION public.readiness_v2_validate(p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_valid_tags int; v_required int; v_required_ok int; v_issues jsonb;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.readiness_formula_versions WHERE id = p_version_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: version not found'; END IF;
  IF NOT (public.is_ralli_admin() OR (v_tenant = public.readiness_caller_tenant() AND public.readiness_caller_can_configure())) THEN
    RAISE EXCEPTION 'readiness: not authorized';
  END IF;

  WITH desig AS (
    SELECT d.tag_id, d.is_required, t.status AS tag_status, s.active_quiz_count, s.distinct_question_count
    FROM public.readiness_tag_designations d
    JOIN public.tenant_quiz_tags t ON t.id = d.tag_id AND t.tenant_id = v_tenant
    CROSS JOIN LATERAL public.readiness_tag_support(v_tenant, d.tag_id) s
    WHERE d.formula_version_id = p_version_id
  )
  SELECT
    count(*) FILTER (WHERE tag_status='active' AND active_quiz_count>=1 AND distinct_question_count>=1),
    count(*) FILTER (WHERE is_required),
    count(*) FILTER (WHERE is_required AND tag_status='active' AND active_quiz_count>=1 AND distinct_question_count>=1),
    COALESCE(jsonb_agg(jsonb_build_object('tagId',tag_id,'reason',
        CASE WHEN tag_status<>'active' THEN 'archived_or_merged'
             WHEN active_quiz_count=0 THEN 'no_active_quiz'
             WHEN distinct_question_count=0 THEN 'no_graded_questions' END)
      ) FILTER (WHERE NOT (tag_status='active' AND active_quiz_count>=1 AND distinct_question_count>=1)), '[]'::jsonb)
  INTO v_valid_tags, v_required, v_required_ok, v_issues
  FROM desig;

  RETURN jsonb_build_object(
    'versionId', p_version_id,
    'validReadinessTags', v_valid_tags,
    'requiredTags', v_required,
    'requiredTagsSupported', v_required_ok,
    'setupComplete', (v_valid_tags >= 2 AND v_required = v_required_ok),
    'issues', v_issues
  );
END $$;

-- Save the DRAFT designation set. p_designations = [{"tagId":uuid,"required":bool}, ...].
-- Replaces the draft's designations wholesale (validated: active, same-tenant tags).
-- Does NOT activate. Managers/admins only.
CREATE OR REPLACE FUNCTION public.readiness_v2_save_draft(p_designations jsonb, p_threshold integer DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_draft uuid; v_threshold int; v_n int; v_bad int;
BEGIN
  IF NOT public.readiness_caller_can_configure() THEN RAISE EXCEPTION 'readiness: not authorized to configure readiness'; END IF;
  v_tenant := public.readiness_caller_tenant();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: caller has no tenant'; END IF;
  IF p_designations IS NULL OR jsonb_typeof(p_designations) <> 'array' THEN
    RAISE EXCEPTION 'readiness: designations must be a JSON array';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('readiness_config:'||v_tenant::text, 0));
  v_draft := public.readiness_v2_ensure_draft(v_tenant);

  -- Reject any tag that is not an ACTIVE tag of this tenant (honest, no silent drop).
  SELECT count(*) INTO v_bad FROM jsonb_array_elements(p_designations) e
   WHERE NOT EXISTS (
     SELECT 1 FROM public.tenant_quiz_tags t
     WHERE t.id = (e->>'tagId')::uuid AND t.tenant_id = v_tenant AND t.status = 'active');
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'readiness: % designated tag(s) are not active tags of this tenant', v_bad;
  END IF;

  DELETE FROM public.readiness_tag_designations WHERE formula_version_id = v_draft;
  INSERT INTO public.readiness_tag_designations (tenant_id, formula_version_id, tag_id, is_required, created_by)
  SELECT v_tenant, v_draft, (e->>'tagId')::uuid, COALESCE((e->>'required')::boolean, false), auth.uid()
  FROM jsonb_array_elements(p_designations) e
  ON CONFLICT (formula_version_id, tag_id) DO UPDATE SET is_required = EXCLUDED.is_required;
  GET DIAGNOSTICS v_n = ROW_COUNT;

  IF p_threshold IS NOT NULL THEN
    IF p_threshold < 0 OR p_threshold > 100 THEN RAISE EXCEPTION 'readiness: threshold must be 0..100'; END IF;
    UPDATE public.readiness_formula_versions SET readiness_threshold = p_threshold WHERE id = v_draft;
  END IF;
  SELECT readiness_threshold INTO v_threshold FROM public.readiness_formula_versions WHERE id = v_draft;

  UPDATE public.readiness_formula_versions
     SET config_hash = public.readiness_v2_config_hash(v_threshold, v_draft) WHERE id = v_draft;

  INSERT INTO public.readiness_formula_lifecycle_events
    (tenant_id, formula_version_id, event_type, actor_id, actor_role, config_hash, to_version_id, metadata)
  VALUES (v_tenant, v_draft, 'previewed', auth.uid(), 'manager',
          (SELECT config_hash FROM public.readiness_formula_versions WHERE id=v_draft), v_draft,
          jsonb_build_object('designationCount', v_n, 'threshold', v_threshold));

  RETURN public.readiness_v2_validate(v_draft) || jsonb_build_object('draftVersionId', v_draft, 'status','draft');
END $$;

-- Activate a valid draft: draft→active, supersede the prior active formula (v1 or a
-- prior V2), effective-dated + audited, and enqueue a shadow recalc. Managers/admins.
-- NOTE: activation flips the tenant's ACTIVE formula version but does NOT cut the
-- live dashboard over — no UI reads formula_versions (shadow-safe).
CREATE OR REPLACE FUNCTION public.readiness_v2_activate(p_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_status text; v_valid jsonb; v_prior uuid;
BEGIN
  SELECT tenant_id, status INTO v_tenant, v_status FROM public.readiness_formula_versions WHERE id = p_version_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: version not found'; END IF;
  IF NOT (public.is_ralli_admin() OR (v_tenant = public.readiness_caller_tenant() AND public.readiness_caller_can_configure())) THEN
    RAISE EXCEPTION 'readiness: not authorized to activate readiness configuration';
  END IF;
  IF v_status <> 'draft' THEN RAISE EXCEPTION 'readiness: only a draft version can be activated (status=%)', v_status; END IF;

  v_valid := public.readiness_v2_validate(p_version_id);
  IF NOT (v_valid->>'setupComplete')::boolean THEN
    RAISE EXCEPTION 'readiness: configuration is not valid for activation (need >=2 supported readiness tags and all required tags supported)';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('readiness_config:'||v_tenant::text, 0));

  SELECT id INTO v_prior FROM public.readiness_formula_versions
   WHERE tenant_id = v_tenant AND status = 'active' AND id <> p_version_id;
  IF v_prior IS NOT NULL THEN
    UPDATE public.readiness_formula_versions SET status='superseded' WHERE id = v_prior;
    INSERT INTO public.readiness_formula_lifecycle_events
      (tenant_id, formula_version_id, event_type, actor_id, actor_role, from_version_id, to_version_id, metadata)
    VALUES (v_tenant, v_prior, 'superseded', auth.uid(), 'manager', v_prior, p_version_id, jsonb_build_object('by','v2_activation'));
  END IF;

  UPDATE public.readiness_formula_versions
     SET status='active', activated_at = now(), supersedes_version_id = v_prior
   WHERE id = p_version_id;
  INSERT INTO public.readiness_formula_lifecycle_events
    (tenant_id, formula_version_id, event_type, actor_id, actor_role, config_hash, from_version_id, to_version_id, metadata)
  VALUES (v_tenant, p_version_id, 'activated', auth.uid(), 'manager',
          (SELECT config_hash FROM public.readiness_formula_versions WHERE id=p_version_id), v_prior, p_version_id,
          jsonb_build_object('effectiveAt', now()));

  -- Enqueue a shadow recalc for every scorable rep under the newly active version.
  PERFORM public.enqueue_readiness_recalc(v_tenant, p.id, p_version_id, 'formula_activation', jsonb_build_object('versionId', p_version_id))
  FROM public.profiles p WHERE p.tenant_id = v_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user';

  RETURN jsonb_build_object('versionId', p_version_id, 'status','active', 'supersededVersionId', v_prior, 'effectiveAt', now());
END $$;

-- Resolve a merged tag transitively to its ultimate target (cycle-safe). Helper for
-- primary-tag validation and compute. Returns the input if not merged.
CREATE OR REPLACE FUNCTION public.readiness_resolve_tag(p_tenant uuid, p_tag uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH RECURSIVE chain AS (
    SELECT t.id AS cur, t.merged_into, 0 AS depth
    FROM public.tenant_quiz_tags t WHERE t.id = p_tag AND t.tenant_id = p_tenant
    UNION ALL
    SELECT n.id, n.merged_into, c.depth + 1
    FROM chain c JOIN public.tenant_quiz_tags n ON n.id = c.merged_into WHERE c.depth < 20
  )
  SELECT cur FROM chain WHERE merged_into IS NULL LIMIT 1;
$$;

-- MANAGER/orgAdmin/admin: set (or clear) a quiz's PRIMARY readiness tag. The tag must
-- be an ACTIVE tag currently ASSIGNED to the quiz (quiz_tag_map) AND a DESIGNATED
-- readiness tag of the tenant's current config (active, else latest draft). Passing
-- NULL clears it. Enqueues a shadow recalc for the tenant's reps.
CREATE OR REPLACE FUNCTION public.readiness_set_quiz_primary_tag(p_quiz_id uuid, p_tag_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_cfg uuid; v_resolved uuid;
BEGIN
  SELECT tenant_id INTO v_tenant FROM public.tenant_quizzes WHERE id = p_quiz_id;
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: quiz not found'; END IF;
  IF NOT (public.is_ralli_admin() OR (v_tenant = public.readiness_caller_tenant() AND public.readiness_caller_can_configure())) THEN
    RAISE EXCEPTION 'readiness: not authorized to set the quiz primary readiness tag';
  END IF;

  IF p_tag_id IS NULL THEN
    UPDATE public.tenant_quizzes SET primary_readiness_tag_id = NULL WHERE id = p_quiz_id;
  ELSE
    -- current config version (active preferred, else latest draft):
    SELECT id INTO v_cfg FROM public.readiness_formula_versions
     WHERE tenant_id = v_tenant AND configuration->>'model'='v2_quiz_mastery' AND status IN ('active','draft')
     ORDER BY (status='active') DESC, version DESC LIMIT 1;
    v_resolved := public.readiness_resolve_tag(v_tenant, p_tag_id);
    IF v_resolved IS NULL OR NOT EXISTS (SELECT 1 FROM public.tenant_quiz_tags WHERE id = v_resolved AND tenant_id = v_tenant AND status='active') THEN
      RAISE EXCEPTION 'readiness: primary tag is not an active tag of this tenant';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.quiz_tag_map m WHERE m.quiz_id = p_quiz_id AND m.tenant_id = v_tenant AND m.tag_id = v_resolved) THEN
      RAISE EXCEPTION 'readiness: primary tag must be a tag currently assigned to the quiz';
    END IF;
    IF v_cfg IS NULL OR NOT EXISTS (SELECT 1 FROM public.readiness_tag_designations d WHERE d.formula_version_id = v_cfg AND d.tag_id = v_resolved) THEN
      RAISE EXCEPTION 'readiness: primary tag must be a designated readiness tag';
    END IF;
    UPDATE public.tenant_quizzes SET primary_readiness_tag_id = v_resolved WHERE id = p_quiz_id;
  END IF;

  PERFORM public.enqueue_readiness_recalc(v_tenant, p.id, NULL, 'catalog_change', jsonb_build_object('quizId', p_quiz_id, 'primaryTag', p_tag_id))
  FROM public.profiles p WHERE p.tenant_id = v_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user';

  RETURN jsonb_build_object('quizId', p_quiz_id, 'primaryReadinessTagId', (SELECT primary_readiness_tag_id FROM public.tenant_quizzes WHERE id = p_quiz_id));
END $$;

-- MANAGER/admin: list quizzes that carry ≥1 designated readiness tag, with their
-- designated assigned tags, current primary, and whether the primary is valid (so the
-- Settings UI can prompt the manager to choose one). No question/answer content.
CREATE OR REPLACE FUNCTION public.readiness_v2_quiz_primaries()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_cfg uuid; v_rows jsonb;
BEGIN
  IF NOT public.readiness_caller_can_configure() THEN RAISE EXCEPTION 'readiness: not authorized'; END IF;
  v_tenant := public.readiness_caller_tenant();
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: caller has no tenant'; END IF;
  SELECT id INTO v_cfg FROM public.readiness_formula_versions
   WHERE tenant_id = v_tenant AND configuration->>'model'='v2_quiz_mastery' AND status IN ('active','draft')
   ORDER BY (status='active') DESC, version DESC LIMIT 1;

  SELECT COALESCE(jsonb_agg(row ORDER BY (row->>'quizName')), '[]'::jsonb) INTO v_rows FROM (
    SELECT jsonb_build_object(
      'quizId', q.id, 'quizName', q.name, 'quizStatus', q.status,
      'designatedAssignedTags', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object('tagId', t.id, 'label', t.label) ORDER BY t.label), '[]'::jsonb)
        FROM public.quiz_tag_map m
        JOIN public.tenant_quiz_tags t ON t.id = m.tag_id AND t.tenant_id = m.tenant_id AND t.status='active'
        WHERE m.quiz_id = q.id AND m.tenant_id = v_tenant
          AND EXISTS (SELECT 1 FROM public.readiness_tag_designations d WHERE d.formula_version_id = v_cfg AND d.tag_id = m.tag_id)),
      'primaryTagId', q.primary_readiness_tag_id,
      'primaryValid', (
        q.primary_readiness_tag_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM public.quiz_tag_map m WHERE m.quiz_id=q.id AND m.tenant_id=v_tenant AND m.tag_id=q.primary_readiness_tag_id)
        AND EXISTS (SELECT 1 FROM public.tenant_quiz_tags t WHERE t.id=q.primary_readiness_tag_id AND t.status='active')
        AND EXISTS (SELECT 1 FROM public.readiness_tag_designations d WHERE d.formula_version_id=v_cfg AND d.tag_id=q.primary_readiness_tag_id))
    ) AS row
    FROM public.tenant_quizzes q
    WHERE q.tenant_id = v_tenant AND q.status = 'active'
      AND EXISTS (
        SELECT 1 FROM public.quiz_tag_map m
        JOIN public.readiness_tag_designations d ON d.formula_version_id = v_cfg AND d.tag_id = m.tag_id
        WHERE m.quiz_id = q.id AND m.tenant_id = v_tenant)
  ) sub;
  RETURN jsonb_build_object('tenantId', v_tenant, 'configVersionId', v_cfg, 'quizzes', v_rows);
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — Shadow compute (core mastery engine) for ONE rep
-- ══════════════════════════════════════════════════════════════════════════════

-- Computes and PERSISTS the V2 shadow result for (tenant, user) under a formula
-- version. p_now enables deterministic tests. p_run_id ties the write to a run.
-- Returns the result jsonb. Server-only (REVOKE below). Idempotent history.
CREATE OR REPLACE FUNCTION public.readiness_compute_v2(
  p_tenant uuid, p_user uuid, p_version_id uuid, p_run_id uuid DEFAULT NULL, p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_threshold int; v_config_hash text;
  v_hl  numeric := 60; v_stale numeric := 120; v_cap int := 3;
  v_minq int := 3; v_mint int := 2; v_minqu int := 10; v_band_ready int := 80; v_band_dev int := 65;
  v_overall numeric; v_overall_int int;
  v_dq int; v_dt int; v_dqu int; v_req_total int; v_req_ok int; v_req_current_ok int;
  v_req_met boolean; v_req_current boolean; v_breadth_met boolean;
  v_was_established boolean; v_last_known int;
  v_newest_age numeric; v_state text; v_success text; v_confidence text; v_band text;
  v_tag_masteries jsonb; v_secondary jsonb; v_included jsonb; v_excluded jsonb; v_excluded_quizzes jsonb; v_evidence jsonb; v_flags jsonb;
  v_material text; v_comp jsonb; v_eff_weights jsonb;
BEGIN
  IF NOT public.readiness_is_scorable_rep(p_tenant, p_user) THEN
    RETURN jsonb_build_object('skipped','not_scorable_rep');
  END IF;

  SELECT readiness_threshold, config_hash INTO v_threshold, v_config_hash
    FROM public.readiness_formula_versions WHERE id = p_version_id AND tenant_id = p_tenant;
  IF v_threshold IS NULL THEN RAISE EXCEPTION 'readiness_compute_v2: version not found for tenant'; END IF;

  -- ── Evidence gathering — attempt-time SNAPSHOTS are the ONLY attribution source
  -- (current quiz_tag_map never rewrites history; mirrors migration 062). Merged
  -- tags resolve transitively to their active target; archived tags/quizzes keep
  -- their historical attribution (grace) until 120-day staleness. Per-quiz mastery
  -- first (≤3 most-recent CURRENT-COMPARABLE verified attempts), then PRIMARY-tag
  -- attribution from the quiz's most-recent counted attempt snapshot. ──
  WITH RECURSIVE rt AS (
    SELECT tag_id, is_required FROM public.readiness_tag_designations WHERE formula_version_id = p_version_id
  ),
  chain AS (
    SELECT t.id AS start_id, t.id AS cur, t.merged_into, 0 AS depth
    FROM public.tenant_quiz_tags t WHERE t.tenant_id = p_tenant
    UNION ALL
    SELECT c.start_id, n.id, n.merged_into, c.depth + 1
    FROM chain c JOIN public.tenant_quiz_tags n ON n.id = c.merged_into
    WHERE c.depth < 20
  ),
  resolve AS ( SELECT start_id AS tag_id, cur AS resolved_id FROM chain WHERE merged_into IS NULL ),
  -- Rep's verified, CURRENT-COMPARABLE attempts carrying a snapshot envelope:
  att AS (
    SELECT a.id AS attempt_id, a.quiz_id, a.score::numeric AS score, a.created_at,
           EXTRACT(EPOCH FROM (p_now - a.created_at))/86400.0 AS age_days
    FROM public.quiz_attempts a
    JOIN public.tenant_quizzes q ON q.id = a.quiz_id AND q.tenant_id = p_tenant
    WHERE a.tenant_id = p_tenant AND a.user_id = p_user
      AND a.grading_provenance = 'server_v2' AND a.score IS NOT NULL
      AND a.verified_revision IS NOT NULL AND a.verified_revision = q.question_revision
      AND EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = a.id)
  ),
  -- attempt → DESIGNATED (resolved, de-duplicated) tags from the immutable snapshot:
  att_tags AS (
    SELECT DISTINCT at.attempt_id, at.quiz_id, r.resolved_id AS tag_id
    FROM att at
    JOIN public.quiz_attempt_tags qt ON qt.attempt_id = at.attempt_id
    JOIN resolve r ON r.tag_id = qt.tag_id
    JOIN rt ON rt.tag_id = r.resolved_id
  ),
  elig AS ( SELECT at.* FROM att at WHERE EXISTS (SELECT 1 FROM att_tags x WHERE x.attempt_id = at.attempt_id) ),
  ranked AS (
    SELECT e.*, row_number() OVER (PARTITION BY e.quiz_id ORDER BY e.created_at DESC) AS rn FROM elig e
  ),
  capped AS ( SELECT * FROM ranked WHERE rn <= v_cap ),
  per_quiz AS (
    SELECT quiz_id,
           SUM(power(0.5, age_days / v_hl) * score) / NULLIF(SUM(power(0.5, age_days / v_hl)),0) AS mastery,
           MIN(age_days) AS newest_age_days,
           (array_agg(attempt_id ORDER BY created_at DESC))[1] AS recent_attempt
    FROM capped GROUP BY quiz_id
  ),
  -- OFFICIAL scoring attributes each quiz to exactly ONE MANAGER-SELECTED PRIMARY
  -- readiness tag (tenant_quizzes.primary_readiness_tag_id), merge-resolved. It is valid
  -- only if that tag is ACTIVE, a DESIGNATED readiness tag of this version, and was one of
  -- the tags the counted attempt actually carried (snapshot-evidenced). A quiz with a
  -- missing/invalid primary is EXCLUDED from official scoring with an honest reason — a
  -- primary is NEVER auto-chosen by id or order. Other designated tags on the quiz are
  -- SECONDARY: insights only, never affecting the overall, tag coverage, or required
  -- coverage. Aggregation is EQUAL-AREA: overall = equal mean over the primary tags that
  -- have evidence, so each readiness AREA counts equally and a quiz in a crowded area
  -- individually counts less (this is NOT equal-per-quiz weighting — see docs).
  quiz_pick AS (
    SELECT pq.quiz_id, pq.mastery, pq.newest_age_days, pq.recent_attempt,
           public.readiness_resolve_tag(p_tenant, q.primary_readiness_tag_id) AS primary_tag,
           q.primary_readiness_tag_id AS raw_primary
    FROM per_quiz pq
    JOIN public.tenant_quizzes q ON q.id = pq.quiz_id AND q.tenant_id = p_tenant
  ),
  quiz_primary AS (   -- quizzes whose manager-selected primary is VALID
    SELECT qp.quiz_id, qp.mastery, qp.newest_age_days, qp.recent_attempt, qp.primary_tag AS tag_id
    FROM quiz_pick qp
    WHERE qp.primary_tag IS NOT NULL
      AND EXISTS (SELECT 1 FROM rt WHERE rt.tag_id = qp.primary_tag)
      AND EXISTS (SELECT 1 FROM public.tenant_quiz_tags t WHERE t.id = qp.primary_tag AND t.status='active')
      AND EXISTS (SELECT 1 FROM att_tags x WHERE x.attempt_id = qp.recent_attempt AND x.tag_id = qp.primary_tag)
  ),
  quiz_excluded AS (  -- quizzes with verified evidence but NO valid primary (honest reason)
    SELECT qp.quiz_id,
      CASE
        WHEN qp.raw_primary IS NULL THEN 'primaryMissing'
        WHEN qp.primary_tag IS NULL OR NOT EXISTS (SELECT 1 FROM public.tenant_quiz_tags t WHERE t.id = qp.primary_tag AND t.status='active') THEN 'primaryArchived'
        WHEN NOT EXISTS (SELECT 1 FROM rt WHERE rt.tag_id = qp.primary_tag) THEN 'primaryNotDesignated'
        ELSE 'primaryNotAssigned'
      END AS reason
    FROM quiz_pick qp
    WHERE NOT EXISTS (SELECT 1 FROM quiz_primary p WHERE p.quiz_id = qp.quiz_id)
  ),
  tag_mastery AS (
    SELECT tag_id, avg(mastery) AS tag_score, count(*) AS quizzes, min(newest_age_days) AS tag_newest_age
    FROM quiz_primary GROUP BY tag_id
  ),
  secondary AS (     -- insights only: a valid quiz's OTHER designated tags (not its primary)
    SELECT x.tag_id, round(avg(qp.mastery),1) AS tag_score
    FROM quiz_primary qp
    JOIN att_tags x ON x.attempt_id = qp.recent_attempt
    WHERE x.tag_id <> qp.tag_id
    GROUP BY x.tag_id
  ),
  contrib_quiz AS ( SELECT DISTINCT quiz_id FROM quiz_primary ),
  -- distinct current-version gradeable question ids across contributing quizzes:
  qdistinct AS (
    SELECT DISTINCT cq.quiz_id, COALESCE(e->>'id', cq.quiz_id::text||':'||ord::text) AS qkey
    FROM contrib_quiz cq
    JOIN public.tenant_quizzes q ON q.id = cq.quiz_id AND q.tenant_id = p_tenant
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(q.questions)='array' THEN q.questions ELSE '[]'::jsonb END)
      WITH ORDINALITY AS t(e, ord)
    WHERE (e->>'type') IN ('mc','tf','type','match','slider')
  )
  SELECT
    (SELECT avg(tag_score) FROM tag_mastery),                       -- overall = EQUAL-AREA mean over primary tags
    (SELECT count(*) FROM contrib_quiz),                            -- distinct contributing quizzes (valid primary)
    (SELECT count(*) FROM tag_mastery),                             -- distinct primary readiness tags
    (SELECT count(*) FROM qdistinct),                               -- distinct current-version graded questions
    (SELECT count(*) FROM rt WHERE is_required),                    -- required tags total
    (SELECT count(*) FROM rt r WHERE r.is_required AND EXISTS (SELECT 1 FROM tag_mastery tm WHERE tm.tag_id = r.tag_id)),                       -- required covered (as a primary tag)
    (SELECT count(*) FROM rt r WHERE r.is_required AND EXISTS (SELECT 1 FROM tag_mastery tm WHERE tm.tag_id = r.tag_id AND tm.tag_newest_age <= v_stale)),  -- required current (≤120d)
    (SELECT min(newest_age_days) FROM quiz_primary),                -- newest evidence age
    (SELECT COALESCE(jsonb_object_agg(tag_id, round(tag_score,1)), '{}'::jsonb) FROM tag_mastery),
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('quizId',quiz_id,'mastery',round(mastery,1),'primaryTag',tag_id) ORDER BY quiz_id), '[]'::jsonb) FROM quiz_primary),
    (SELECT COALESCE(jsonb_object_agg(tag_id, tag_score), '{}'::jsonb) FROM secondary),
    (SELECT COALESCE(jsonb_object_agg(reason, cnt), '{}'::jsonb) FROM (SELECT reason, count(*) AS cnt FROM quiz_excluded GROUP BY reason) z)
  INTO v_overall, v_dq, v_dt, v_dqu, v_req_total, v_req_ok, v_req_current_ok, v_newest_age, v_tag_masteries, v_included, v_secondary, v_excluded_quizzes;

  v_req_met     := (v_req_total = v_req_ok);          -- every required tag has evidence (any age)
  v_req_current := (v_req_total = v_req_current_ok);  -- every required tag has ≤120d evidence
  v_breadth_met := (v_dq >= v_minq AND v_dt >= v_mint AND v_dqu >= v_minqu);

  -- Prior Established state (before this compute) distinguishes Stale from Establishing.
  SELECT EXISTS (SELECT 1 FROM public.readiness_score_history
                  WHERE tenant_id = p_tenant AND user_id = p_user
                    AND formula_version_id = p_version_id AND success_status = 'ok')
    INTO v_was_established;
  SELECT overall_score FROM public.readiness_score_history
    WHERE tenant_id = p_tenant AND user_id = p_user
      AND formula_version_id = p_version_id AND success_status = 'ok'
    ORDER BY calculated_at DESC LIMIT 1
    INTO v_last_known;

  -- Excluded-evidence summary (counts + reasons; never content): rep attempts that
  -- ARE attributable to a designated readiness tag (via snapshot) but were excluded.
  WITH RECURSIVE rtx AS (
    SELECT tag_id FROM public.readiness_tag_designations WHERE formula_version_id = p_version_id
  ),
  chainx AS (
    SELECT t.id AS start_id, t.id AS cur, t.merged_into, 0 AS depth FROM public.tenant_quiz_tags t WHERE t.tenant_id = p_tenant
    UNION ALL
    SELECT c.start_id, n.id, n.merged_into, c.depth + 1 FROM chainx c JOIN public.tenant_quiz_tags n ON n.id = c.merged_into WHERE c.depth < 20
  ),
  resolvex AS ( SELECT start_id AS tag_id, cur AS resolved_id FROM chainx WHERE merged_into IS NULL ),
  rel AS (
    SELECT a.grading_provenance, a.verified_revision, q.question_revision,
           EXTRACT(EPOCH FROM (p_now - a.created_at))/86400.0 AS age_days
    FROM public.quiz_attempts a
    JOIN public.tenant_quizzes q ON q.id = a.quiz_id AND q.tenant_id = p_tenant
    WHERE a.tenant_id = p_tenant AND a.user_id = p_user
      AND EXISTS (SELECT 1 FROM public.quiz_attempt_tags qt JOIN resolvex r ON r.tag_id = qt.tag_id JOIN rtx ON rtx.tag_id = r.resolved_id
                  WHERE qt.attempt_id = a.id)
  )
  SELECT jsonb_build_object(
    'supersededRevision', count(*) FILTER (WHERE grading_provenance='server_v2' AND verified_revision IS NOT NULL AND verified_revision <> question_revision),
    'legacyUnverified',   count(*) FILTER (WHERE grading_provenance IS DISTINCT FROM 'server_v2' OR verified_revision IS NULL),
    'staleCurrentComparable', count(*) FILTER (WHERE grading_provenance='server_v2' AND verified_revision = question_revision AND age_days > v_stale)
  ) INTO v_excluded FROM rel;

  -- ── Evidence state (approved semantics) ──
  -- Established: breadth met AND EVERY required tag has current (≤120d) comparable
  --   evidence. (Per-required-tag currency — an optional/other tag being current
  --   cannot rescue a stale required tag.)
  -- Stale — reassessment needed: not currently Established, but the rep was
  --   previously Established (a required tag's current evidence lapsed, or breadth
  --   regressed). Not ranked/averaged/Needs-Attention; last Established score kept.
  -- Establishing readiness: never reached Established (insufficient current required
  --   coverage from the start).
  IF v_breadth_met AND v_req_current THEN
    v_state := 'established'; v_success := 'ok';
  ELSIF v_was_established THEN
    v_state := 'stale'; v_success := 'insufficient_evidence';
  ELSE
    v_state := 'establishing'; v_success := 'insufficient_evidence';
  END IF;

  IF v_success = 'ok' THEN
    v_overall_int := round(v_overall);
    v_band := CASE WHEN v_overall_int >= v_band_ready THEN 'ready'
                   WHEN v_overall_int >= v_band_dev THEN 'developing' ELSE 'needs_attention' END;
    v_confidence := CASE
      WHEN v_dq >= 6 AND v_dqu >= 30 THEN 'high'
      WHEN v_dq >= 4 OR v_dqu >= 20 THEN 'moderate' ELSE 'limited' END;
    v_comp := jsonb_build_object('tagMastery', v_tag_masteries);
    v_eff_weights := (SELECT jsonb_object_agg(r.tag_id, round(1.0/NULLIF(v_dt,0),4))
                      FROM public.readiness_tag_designations r
                      WHERE r.formula_version_id = p_version_id
                        AND EXISTS (SELECT 1 FROM jsonb_object_keys(v_tag_masteries) k WHERE k = r.tag_id::text));
  ELSE
    v_overall_int := NULL; v_band := NULL; v_confidence := 'insufficient'; v_comp := NULL; v_eff_weights := NULL;
  END IF;

  v_flags := jsonb_build_object('state', v_state, 'band', v_band);

  v_evidence := jsonb_build_object(
    'state', v_state,
    'distinctQuizzes', v_dq, 'distinctReadinessTags', v_dt, 'distinctQuestions', v_dqu,
    'requiredTags', v_req_total, 'requiredTagsCovered', v_req_ok,
    'requiredTagsCurrent', v_req_current_ok, 'requiredCoverageMet', v_req_met,
    'requiredCoverageCurrent', v_req_current, 'breadthMet', v_breadth_met,
    'thresholds', jsonb_build_object('minQuizzes',v_minq,'minTags',v_mint,'minQuestions',v_minqu,
                                     'halfLifeDays',v_hl,'staleDays',v_stale,'attemptCap',v_cap),
    'newestEvidenceAgeDays', CASE WHEN v_newest_age IS NULL THEN NULL ELSE round(v_newest_age,1) END,
    'tagMastery', v_tag_masteries,
    'secondaryTagMastery', v_secondary,   -- insights only; NOT part of the official score
    'includedQuizzes', v_included,
    'excludedCounts', v_excluded,
    'excludedQuizzes', v_excluded_quizzes,  -- quizzes dropped from official scoring for lacking a valid primary (by reason)
    -- Stale keeps the last ESTABLISHED score from history (not a fresh recompute).
    'lastKnownScore', CASE WHEN v_state='stale' THEN v_last_known ELSE NULL END
  );

  -- Material state hash: evidence set + config + state label (NOT the clock), so
  -- history appends only on genuine material/state change; scores_current always
  -- reflects the latest compute.
  SELECT encode(extensions.digest(
    p_user::text || '|' || v_config_hash || '|' || v_state || '|' ||
    COALESCE((SELECT string_agg(quiz_id::text||':'||round(mastery,2)::text, ',' ORDER BY quiz_id)
              FROM (SELECT (e->>'quizId')::uuid quiz_id, (e->>'mastery')::numeric mastery
                    FROM jsonb_array_elements(v_included) e) z), ''),
    'sha256'), 'hex') INTO v_material;

  -- Upsert current (always latest).
  INSERT INTO public.readiness_scores_current
    (tenant_id, user_id, formula_version_id, overall_score, component_scores, effective_weights,
     confidence, evidence_summary, flags, success_status, evidence_hash, calculated_config_hash,
     calculated_at, success_run_id, last_attempt_status, last_attempt_at, last_attempt_run_id)
  VALUES
    (p_tenant, p_user, p_version_id, v_overall_int, v_comp, v_eff_weights,
     v_confidence, v_evidence, v_flags, v_success, v_material, v_config_hash,
     p_now, CASE WHEN v_success='ok' THEN p_run_id END, v_success, p_now, p_run_id)
  ON CONFLICT (tenant_id, user_id, formula_version_id) DO UPDATE SET
     overall_score = EXCLUDED.overall_score, component_scores = EXCLUDED.component_scores,
     effective_weights = EXCLUDED.effective_weights, confidence = EXCLUDED.confidence,
     evidence_summary = EXCLUDED.evidence_summary, flags = EXCLUDED.flags,
     success_status = EXCLUDED.success_status, evidence_hash = EXCLUDED.evidence_hash,
     calculated_config_hash = EXCLUDED.calculated_config_hash, calculated_at = EXCLUDED.calculated_at,
     success_run_id = COALESCE(EXCLUDED.success_run_id, public.readiness_scores_current.success_run_id),
     last_attempt_status = EXCLUDED.last_attempt_status, last_attempt_at = EXCLUDED.last_attempt_at,
     last_attempt_run_id = EXCLUDED.last_attempt_run_id;

  -- Append history only on new material state (idempotent).
  INSERT INTO public.readiness_score_history
    (tenant_id, user_id, formula_version_id, overall_score, component_scores, confidence,
     evidence_summary, flags, success_status, evidence_hash, material_state_hash,
     calculated_config_hash, calculation_run_id, idempotency_key, calculated_at)
  VALUES
    (p_tenant, p_user, p_version_id, v_overall_int, v_comp, v_confidence,
     v_evidence, v_flags, v_success, v_material, v_material, v_config_hash, p_run_id, v_material, p_now)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING;

  RETURN jsonb_build_object('state', v_state, 'success', v_success, 'overall', v_overall_int,
                            'band', v_band, 'confidence', v_confidence, 'evidence', v_evidence);
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — Run driver + durable queue drain (shadow)
-- ══════════════════════════════════════════════════════════════════════════════

-- Run a shadow calculation for a whole tenant population under a version (defaults
-- to the tenant's active version). Records a readiness_calculation_runs row.
-- Manager/admin authorized (or internal). Returns the run summary.
CREATE OR REPLACE FUNCTION public.readiness_run_shadow(
  p_tenant uuid, p_version_id uuid DEFAULT NULL, p_mode text DEFAULT 'reconciliation', p_now timestamptz DEFAULT now()
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_ver uuid; v_hash text; v_run uuid; v_uid uuid; v_res jsonb;
  v_expected int := 0; v_processed int := 0; v_ok int := 0; v_insuf int := 0; v_fail int := 0;
BEGIN
  IF NOT (public.is_ralli_admin() OR (p_tenant = public.readiness_caller_tenant() AND public.readiness_caller_can_configure())) THEN
    RAISE EXCEPTION 'readiness: not authorized to run readiness calculation';
  END IF;
  IF p_mode NOT IN ('event','preview','reconciliation','backfill') THEN RAISE EXCEPTION 'readiness: bad mode'; END IF;

  v_ver := COALESCE(p_version_id, (SELECT id FROM public.readiness_formula_versions WHERE tenant_id=p_tenant AND status='active'));
  IF v_ver IS NULL THEN RAISE EXCEPTION 'readiness: no active version for tenant (activate a V2 config first)'; END IF;
  SELECT config_hash INTO v_hash FROM public.readiness_formula_versions WHERE id = v_ver;

  SELECT count(*) INTO v_expected FROM public.profiles p
   WHERE p.tenant_id=p_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user';

  INSERT INTO public.readiness_calculation_runs (tenant_id, formula_version_id, config_hash, mode, status, expected_count, started_by)
  VALUES (p_tenant, v_ver, v_hash, p_mode, 'running', v_expected, auth.uid()) RETURNING id INTO v_run;

  FOR v_uid IN SELECT p.id FROM public.profiles p
      WHERE p.tenant_id=p_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user'
  LOOP
    BEGIN
      v_res := public.readiness_compute_v2(p_tenant, v_uid, v_ver, v_run, p_now);
      v_processed := v_processed + 1;
      IF v_res->>'success' = 'ok' THEN v_ok := v_ok + 1; ELSE v_insuf := v_insuf + 1; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_processed := v_processed + 1; v_fail := v_fail + 1;
    END;
  END LOOP;

  UPDATE public.readiness_calculation_runs
     SET status = CASE WHEN v_fail=0 THEN 'completed' ELSE 'partial_failure' END,
         processed_count=v_processed, success_count=v_ok, insufficient_count=v_insuf, failure_count=v_fail,
         completed_at = now()
   WHERE id = v_run;

  RETURN jsonb_build_object('runId', v_run, 'versionId', v_ver, 'expected', v_expected,
                            'processed', v_processed, 'ok', v_ok, 'insufficient', v_insuf, 'failed', v_fail);
END $$;

-- Durable, idempotent, concurrency-safe drain of the recalc queue (shadow). Claims
-- up to p_limit pending jobs with FOR UPDATE SKIP LOCKED, computes under the job's
-- version (or the tenant's active version), marks completed/failed. Server-only.
CREATE OR REPLACE FUNCTION public.readiness_process_recalc_batch(p_limit integer DEFAULT 50, p_worker text DEFAULT 'shadow', p_now timestamptz DEFAULT now())
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job record; v_ver uuid; v_done int := 0; v_fail int := 0;
BEGIN
  FOR v_job IN
    SELECT * FROM public.readiness_recalc_queue
     WHERE status='pending' AND next_attempt_at <= p_now
     ORDER BY next_attempt_at
     FOR UPDATE SKIP LOCKED
     LIMIT GREATEST(p_limit,1)
  LOOP
    UPDATE public.readiness_recalc_queue
       SET status='processing', attempt_count=attempt_count+1, locked_by=p_worker, locked_at=now(), updated_at=now()
     WHERE id=v_job.id;
    BEGIN
      v_ver := COALESCE(v_job.formula_version_id,
                        (SELECT id FROM public.readiness_formula_versions WHERE tenant_id=v_job.tenant_id AND status='active'));
      IF v_ver IS NULL THEN RAISE EXCEPTION 'no active version'; END IF;
      PERFORM public.readiness_compute_v2(v_job.tenant_id, v_job.user_id, v_ver, NULL, p_now);
      UPDATE public.readiness_recalc_queue
         SET status='completed', processed_at=now(), updated_at=now(), locked_by=NULL, locked_at=NULL, last_error=NULL
       WHERE id=v_job.id;
      v_done := v_done + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.readiness_recalc_queue
         SET status = CASE WHEN attempt_count >= 5 THEN 'dead_letter' ELSE 'pending' END,
             next_attempt_at = now() + (interval '1 minute' * LEAST(attempt_count,5)),
             last_error = SQLERRM, locked_by=NULL, locked_at=NULL, updated_at=now()
       WHERE id=v_job.id;
      v_fail := v_fail + 1;
    END;
  END LOOP;
  RETURN jsonb_build_object('processed', v_done, 'failed', v_fail);
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 6 — Learner-safe own result + authorized comparison report
-- ══════════════════════════════════════════════════════════════════════════════

-- The CALLER's own V2 shadow result (learner-safe): state + score only if Established.
-- No other learner's data; no answer keys or question text.
CREATE OR REPLACE FUNCTION public.readiness_v2_my_result()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_ver uuid; r record;
BEGIN
  v_tenant := public.readiness_caller_tenant();
  IF v_tenant IS NULL THEN RETURN jsonb_build_object('state','establishing'); END IF;
  SELECT id INTO v_ver FROM public.readiness_formula_versions WHERE tenant_id=v_tenant AND status='active';
  IF v_ver IS NULL THEN RETURN jsonb_build_object('state','establishing'); END IF;

  SELECT * INTO r FROM public.readiness_scores_current
   WHERE tenant_id=v_tenant AND user_id=auth.uid() AND formula_version_id=v_ver;
  IF NOT FOUND THEN RETURN jsonb_build_object('state','establishing','hasResult',false); END IF;

  RETURN jsonb_build_object(
    'state', COALESCE(r.flags->>'state','establishing'),
    'score', CASE WHEN r.success_status='ok' THEN r.overall_score ELSE NULL END,
    'band', CASE WHEN r.success_status='ok' THEN r.flags->>'band' ELSE NULL END,
    'confidence', r.confidence,
    'progress', jsonb_build_object(
       'distinctQuizzes', r.evidence_summary->'distinctQuizzes',
       'distinctReadinessTags', r.evidence_summary->'distinctReadinessTags',
       'distinctQuestions', r.evidence_summary->'distinctQuestions',
       'requiredCoverageMet', r.evidence_summary->'requiredCoverageMet',
       'thresholds', r.evidence_summary->'thresholds'),
    'calculatedAt', r.calculated_at, 'hasResult', true);
END $$;

-- Authorized internal legacy-vs-V2 comparison for QA during shadow. Manager/admin.
-- Returns per scorable rep: legacy score (readiness_scores) vs V2 (state/score/band
-- + breadth + exclusion counts). No content leakage.
CREATE OR REPLACE FUNCTION public.readiness_v2_compare(p_tenant uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_tenant uuid; v_ver uuid; v_rows jsonb;
BEGIN
  v_tenant := COALESCE(p_tenant, public.readiness_caller_tenant());
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'readiness: tenant required'; END IF;
  IF NOT (public.is_ralli_admin() OR (v_tenant = public.readiness_caller_tenant() AND public.readiness_caller_can_configure())) THEN
    RAISE EXCEPTION 'readiness: not authorized';
  END IF;
  SELECT id INTO v_ver FROM public.readiness_formula_versions WHERE tenant_id=v_tenant AND status='active';

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'userId', p.id,
      'legacyScore', ls.score,
      'v2State', COALESCE(c.flags->>'state','establishing'),
      'v2Score', CASE WHEN c.success_status='ok' THEN c.overall_score ELSE NULL END,
      'v2Band', CASE WHEN c.success_status='ok' THEN c.flags->>'band' ELSE NULL END,
      'v2Confidence', c.confidence,
      'distinctQuizzes', c.evidence_summary->'distinctQuizzes',
      'distinctReadinessTags', c.evidence_summary->'distinctReadinessTags',
      'distinctQuestions', c.evidence_summary->'distinctQuestions',
      'excludedCounts', c.evidence_summary->'excludedCounts'
    ) ORDER BY p.id), '[]'::jsonb) INTO v_rows
  FROM public.profiles p
  LEFT JOIN public.readiness_scores ls ON ls.tenant_id=p.tenant_id AND ls.user_id=p.id
  LEFT JOIN public.readiness_scores_current c ON c.tenant_id=p.tenant_id AND c.user_id=p.id AND c.formula_version_id=v_ver
  WHERE p.tenant_id=v_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user';

  RETURN jsonb_build_object('tenantId', v_tenant, 'activeVersionId', v_ver, 'reps', v_rows);
END $$;

-- ══════════════════════════════════════════════════════════════════════════════
-- SECTION 7 — Grants (least privilege)
-- ══════════════════════════════════════════════════════════════════════════════

-- Server-only compute/run/queue (definer internal; never client-callable):
REVOKE ALL ON FUNCTION public.readiness_compute_v2(uuid,uuid,uuid,uuid,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.readiness_process_recalc_batch(integer,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.readiness_tag_support(uuid,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.readiness_v2_ensure_draft(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.readiness_v2_config_hash(integer,uuid) FROM PUBLIC, anon, authenticated;

-- Manager/admin-gated config + run + report (gate enforced INSIDE each function):
REVOKE ALL ON FUNCTION public.readiness_v2_tag_candidates() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_v2_validate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_v2_save_draft(jsonb,integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_v2_activate(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_run_shadow(uuid,uuid,text,timestamptz) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_v2_compare(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_v2_tag_candidates() TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_v2_validate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_v2_save_draft(jsonb,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_v2_activate(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_run_shadow(uuid,uuid,text,timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_v2_compare(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.readiness_set_quiz_primary_tag(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.readiness_v2_quiz_primaries() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_set_quiz_primary_tag(uuid,uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_v2_quiz_primaries() TO authenticated;
REVOKE ALL ON FUNCTION public.readiness_resolve_tag(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- Learner-safe own read + predicate helpers used by RLS/other definers:
REVOKE ALL ON FUNCTION public.readiness_v2_my_result() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_v2_my_result() TO authenticated;
REVOKE ALL ON FUNCTION public.readiness_caller_can_configure() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_caller_can_configure() TO authenticated;
REVOKE ALL ON FUNCTION public.readiness_is_scorable_rep(uuid,uuid) FROM PUBLIC, anon, authenticated;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS public.readiness_v2_compare(uuid), public.readiness_v2_my_result(),
--   public.readiness_process_recalc_batch(integer,text,timestamptz),
--   public.readiness_run_shadow(uuid,uuid,text,timestamptz),
--   public.readiness_compute_v2(uuid,uuid,uuid,uuid,timestamptz),
--   public.readiness_v2_activate(uuid), public.readiness_v2_save_draft(jsonb,integer),
--   public.readiness_v2_validate(uuid), public.readiness_v2_tag_candidates(),
--   public.readiness_v2_ensure_draft(uuid), public.readiness_tag_support(uuid,uuid),
--   public.readiness_is_scorable_rep(uuid,uuid), public.readiness_caller_can_configure(),
--   public.readiness_v2_config_hash(integer,uuid) CASCADE;
-- DROP TABLE IF EXISTS public.readiness_tag_designations CASCADE;
