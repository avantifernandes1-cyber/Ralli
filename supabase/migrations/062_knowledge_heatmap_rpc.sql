-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 062 — Knowledge Heatmap canonical aggregation RPC (ADDITIVE, read-only)
--
-- ONE canonical SECURITY DEFINER source for every topic-readiness surface:
--   • manager Leadership "Knowledge Heatmap" (full tenant matrix),
--   • learner "Knowledge by Topic" (own scores only),
--   • manager rep drill-down "Topic Readiness" (one rep, via the same rows).
-- The client no longer aggregates from the mutable legacy tenant_quizzes.tags —
-- it reads this function, so both views share one definition and can never drift.
--
-- HISTORICAL TRUTH: attribution comes ONLY from the immutable attempt-time
-- snapshots (quiz_attempt_tag_snapshots + quiz_attempt_tags). The current mutable
-- quiz_tag_map is NEVER used to attribute history — a later attach/detach/rename/
-- merge never rewrites a past attempt's topic.
--
-- TRUST (approved policy): only authoritative attempts contribute to SCORES:
--   grading_provenance='server_v2' AND score IS NOT NULL AND a snapshot envelope
--   exists AND the learner is an active same-tenant learner. Legacy/null-provenance
--   attempts are NEVER silently trusted or regraded — excluded from scores and
--   surfaced only in coverage meta (legacyExcluded). Attempts with no snapshot are
--   awaitingClassification (also excluded, never attached to current tags).
--
-- FULL TOPIC POPULATION (this revision): the manager matrix lists EVERY active
-- tenant tag as a row, even with no verified evidence — those render avgScore=null,
-- measuredLearners=0, learnersNoData=totalActiveLearners, repScores=[] (cells "—",
-- never 0). Plain-archived tags are not rows; merged sources resolve into their
-- active target's row. No Uncategorized/No-tag row. Learners see only tags relevant
-- to them (their immutable attempt history OR the tags on quizzes they can access),
-- never the whole tenant taxonomy.
--
-- POPULATION + IDENTITY: every ACTIVE learner (role 'user') is a matrix column even
-- with no verified data or no readiness row; the RPC returns the caller-authorized
-- display name so columns never depend on readiness_scores. orgAdmin/manager/
-- ralli-admin, inactive, removed and orphan identities are excluded.
--
-- MERGED TAGS: each snapshot/mapping tag_id is resolved TRANSITIVELY (cycle-safe)
-- to its ultimate active target via merged_into; contributions are de-duplicated on
-- (attempt_id, resolved_tag_id). A multi-tag attempt contributes once to EACH
-- relevant topic; topic cells are NEVER summed into a readiness score.
--
-- MULTI-TENANT: get_knowledge_heatmap(p_tenant_id) — learner/orgAdmin/manager may
-- read only their OWN tenant (any foreign p_tenant_id is rejected); a ralli-admin
-- may pass an explicitly selected tenant. NULL means the caller's own tenant. A
-- missing/unknown tenant is rejected honestly. Learners are always self-scoped and
-- never see peer identities or metrics; no cross-tenant leakage.
--
-- THRESHOLD: tenant_settings.learning_settings.readinessThreshold when present
-- (thresholdSource='tenant_settings'); otherwise the documented 80 default
-- (thresholdSource='default'). The fallback is returned explicitly, never hidden.
--
-- CONFIDENTIALITY: returns tag ids/labels, numeric scores/counts, learner ids and
-- authorized display names ONLY — never questions, answers, solution keys or quiz
-- contents. Does NOT touch or weaken migrations 056/057. No tables, columns,
-- policies or existing functions are changed; this is a pure additive read-only
-- function.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_knowledge_heatmap(p_tenant_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_uid              uuid := auth.uid();
  v_own              uuid;
  v_role             text;
  v_is_ralli         boolean;
  v_is_manager       boolean;
  v_target           uuid;
  v_threshold        int;
  v_threshold_source text;
  v_result           jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'get_knowledge_heatmap: must be authenticated'; END IF;
  v_own      := public.get_my_tenant_id();
  v_role     := public.get_my_role();
  v_is_ralli := public.is_ralli_admin();
  v_is_manager := v_is_ralli OR v_role IN ('orgAdmin','manager');
  IF v_own IS NULL AND NOT v_is_ralli THEN
    RAISE EXCEPTION 'get_knowledge_heatmap: caller has no tenant';
  END IF;

  -- ── Tenant authorization ──────────────────────────────────────────────────
  -- ralli-admin may target an explicitly selected tenant; everyone else is pinned
  -- to their own tenant and any foreign p_tenant_id is rejected outright.
  IF v_is_ralli THEN
    v_target := COALESCE(p_tenant_id, v_own);
  ELSE
    IF p_tenant_id IS NOT NULL AND p_tenant_id <> v_own THEN
      RAISE EXCEPTION 'get_knowledge_heatmap: not authorized for the requested tenant';
    END IF;
    v_target := v_own;
  END IF;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'get_knowledge_heatmap: no tenant specified';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.tenants t WHERE t.id = v_target) THEN
    RAISE EXCEPTION 'get_knowledge_heatmap: tenant not found';
  END IF;

  -- ── Threshold + explicit source (no hidden fallback) ──────────────────────
  SELECT CASE
           WHEN (s.ls->>'readinessThreshold') ~ '^[0-9]+(\.[0-9]+)?$'
                AND (s.ls->>'readinessThreshold')::numeric BETWEEN 0 AND 100
           THEN round((s.ls->>'readinessThreshold')::numeric)::int
         END
    INTO v_threshold
    FROM (SELECT learning_settings AS ls FROM public.tenant_settings WHERE tenant_id = v_target) s;
  IF v_threshold IS NULL THEN
    v_threshold := 80; v_threshold_source := 'default';
  ELSE
    v_threshold_source := 'tenant_settings';
  END IF;

  -- ── Canonical aggregation (single query; one source of truth) ─────────────
  WITH
  -- All active learners of the target tenant, with their authorized display name.
  active_learners AS (
    SELECT p.id AS user_id, p.name
    FROM public.profiles p
    WHERE p.tenant_id = v_target
      AND p.role = 'user'
      AND COALESCE(p.status,'active') = 'active'
  ),
  -- Visible population: managers see all active learners; a learner sees only self.
  pop AS (
    SELECT user_id, name FROM active_learners
    WHERE v_is_manager OR user_id = v_uid
  ),
  -- Transitive, cycle-safe merge resolution: every target-tenant tag -> its terminal
  -- (active, unmerged) target. Depth guard defends against any accidental cycle.
  resolve AS (
    WITH RECURSIVE chain AS (
      SELECT t.id AS start_id, t.id AS cur, t.merged_into, 0 AS depth
        FROM public.tenant_quiz_tags t
        WHERE t.tenant_id = v_target
      UNION ALL
      SELECT c.start_id, n.id, n.merged_into, c.depth + 1
        FROM chain c
        JOIN public.tenant_quiz_tags n ON n.id = c.merged_into
        WHERE c.depth < 32
    )
    SELECT start_id AS tag_id, cur AS resolved_id
    FROM chain
    WHERE merged_into IS NULL
  ),
  -- Active tags = candidate topic rows (plain-archived and merged excluded).
  active_tags AS (
    SELECT t.id, t.label
    FROM public.tenant_quiz_tags t
    WHERE t.tenant_id = v_target AND t.status = 'active' AND t.merged_into IS NULL
  ),
  -- Verified, attributable attempts (attempt-level trust gate) for the population.
  eligible AS (
    SELECT a.id AS attempt_id, a.user_id, a.quiz_id, a.score, a.passed, a.created_at
    FROM public.quiz_attempts a
    JOIN pop ON pop.user_id = a.user_id
    WHERE a.tenant_id = v_target
      AND a.grading_provenance = 'server_v2'
      AND a.score IS NOT NULL
      AND EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = a.id)
  ),
  -- Latest eligible trusted attempt per (learner, quiz).
  latest AS (
    SELECT DISTINCT ON (e.user_id, e.quiz_id)
           e.attempt_id, e.user_id, e.quiz_id, e.score, e.passed
    FROM eligible e
    ORDER BY e.user_id, e.quiz_id, e.created_at DESC, e.attempt_id DESC
  ),
  -- Attach the attempt-time (snapshot) tags, resolved + de-duplicated per topic.
  attempt_topic AS (
    SELECT DISTINCT l.user_id, l.quiz_id, l.attempt_id, l.score, l.passed, r.resolved_id
    FROM latest l
    JOIN public.quiz_attempt_tags qt ON qt.attempt_id = l.attempt_id
    JOIN resolve r ON r.tag_id = qt.tag_id
  ),
  -- Learner x topic: equal-weight mean of that learner's latest per-quiz scores.
  learner_topic AS (
    SELECT user_id, resolved_id,
           round(avg(score))::int         AS score,
           count(DISTINCT quiz_id)::int    AS n,
           count(*) FILTER (WHERE passed)::int AS passed
    FROM attempt_topic
    GROUP BY user_id, resolved_id
  ),
  -- Topic universe. Manager: every active tenant tag (full picture). Learner: only
  -- tags relevant to them — their immutable attempt history OR the tags on quizzes
  -- they can access — never the whole tenant taxonomy.
  topic_ids AS (
    SELECT at.id
      FROM active_tags at
      WHERE v_is_manager
    UNION
    SELECT rel.id
      FROM (
        -- history: resolved-active tags from the caller's own attempt snapshots
        SELECT r.resolved_id AS id
          FROM public.quiz_attempt_tags qt
          JOIN public.quiz_attempts a ON a.id = qt.attempt_id
          JOIN resolve r ON r.tag_id = qt.tag_id
          WHERE a.tenant_id = v_target AND a.user_id = v_uid
        UNION
        -- eligible: resolved-active tags currently mapped to quizzes the caller can access
        SELECT r.resolved_id AS id
          FROM public.quiz_tag_map m
          JOIN public.tenant_quizzes q ON q.id = m.quiz_id AND q.tenant_id = v_target
          JOIN resolve r ON r.tag_id = m.tag_id
          WHERE public._quiz_learner_can_access(v_uid, q.id)
      ) rel
      JOIN active_tags at2 ON at2.id = rel.id
      WHERE NOT v_is_manager
  ),
  -- Topic aggregate over the universe (LEFT JOIN → no-data topics keep a null cell).
  topic_agg AS (
    SELECT at.id AS resolved_id,
           at.label,
           CASE WHEN count(lt.user_id) = 0 THEN NULL ELSE round(avg(lt.score))::int END AS avg_score,
           count(lt.user_id)::int AS measured_learners,
           count(*) FILTER (WHERE lt.score <  v_threshold)::int AS reps_below,
           count(*) FILTER (WHERE lt.score >= v_threshold)::int AS reps_above,
           COALESCE(
             jsonb_agg(jsonb_build_object(
               'userId', lt.user_id, 'score', lt.score, 'n', lt.n, 'passed', lt.passed
             ) ORDER BY lt.score, lt.user_id) FILTER (WHERE lt.user_id IS NOT NULL),
             '[]'::jsonb) AS rep_scores
    FROM active_tags at
    JOIN topic_ids ti ON ti.id = at.id
    LEFT JOIN learner_topic lt ON lt.resolved_id = at.id
    GROUP BY at.id, at.label
  ),
  -- Coverage partition over the population's attempts (clean split of all attempts).
  meta_attempts AS (
    SELECT
      EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = a.id) AS has_env,
      -- COALESCE so a NULL/legacy provenance yields a real boolean false (not NULL);
      -- three-valued logic would otherwise drop legacy attempts from every bucket.
      (COALESCE(a.grading_provenance = 'server_v2', false) AND a.score IS NOT NULL) AS is_verified
    FROM public.quiz_attempts a
    JOIN pop ON pop.user_id = a.user_id
    WHERE a.tenant_id = v_target
  )
  SELECT jsonb_build_object(
    'topics', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'tagId',            ta.resolved_id,
               'label',            ta.label,
               'avgScore',         ta.avg_score,
               'measuredLearners', ta.measured_learners,
               'learnersNoData',   (SELECT count(*) FROM pop)::int - ta.measured_learners,
               'repsBelow',        ta.reps_below,
               'repsAbove',        ta.reps_above,
               'repScores',        ta.rep_scores
             )
             -- Scored topics weakest-first; no-verified-evidence topics after them.
             ORDER BY (ta.avg_score IS NULL), ta.avg_score, ta.label)
      FROM topic_agg ta), '[]'::jsonb),
    'learners', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.name) ORDER BY p.user_id)
      FROM pop p), '[]'::jsonb),
    'meta', jsonb_build_object(
      'tenantId',               v_target,
      'totalActiveLearners',    (SELECT count(*) FROM pop)::int,
      'measuredLearners',       (SELECT count(DISTINCT user_id) FROM learner_topic)::int,
      'totalAttempts',          (SELECT count(*) FROM meta_attempts)::int,
      'verifiedAttributed',     (SELECT count(*) FROM meta_attempts WHERE has_env AND is_verified)::int,
      'legacyExcluded',         (SELECT count(*) FROM meta_attempts WHERE has_env AND NOT is_verified)::int,
      'awaitingClassification', (SELECT count(*) FROM meta_attempts WHERE NOT has_env)::int,
      'threshold',              v_threshold,
      'thresholdSource',        v_threshold_source
    )
  )
  INTO v_result;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public.get_knowledge_heatmap(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_knowledge_heatmap(uuid) TO authenticated;

-- ── ROLLBACK (forward corrective migration only) ──────────────────────────────
-- Purely additive. To undo 062 and only 062:
--   DROP FUNCTION IF EXISTS public.get_knowledge_heatmap(uuid);
-- No data, tables, policies or other functions are touched; 056/057/058/059/060/061
-- are unaffected.
