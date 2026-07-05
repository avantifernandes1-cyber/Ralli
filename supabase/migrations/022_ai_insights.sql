-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli: AI Insights Foundation
-- Run after 020_user_point_events.sql and 010_content_tables.sql.
--
-- Adds:
--   1. tags TEXT[] on tenant_lessons and tenant_courses
--   2. quiz_attempts — persists per-attempt quiz scores and per-question answers
--   3. readiness_scores — cached computed readiness scores (0-100) per user
--   4. ai_insights — cached AI-generated summaries per user/team/org
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Tags on content tables ─────────────────────────────────────────────────
-- tenant_quizzes already has a `tags` JSONB column (migration 010).
-- tenant_lessons and tenant_courses get a proper TEXT[] for simpler querying.

ALTER TABLE public.tenant_lessons
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE public.tenant_courses
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.tenant_lessons.tags IS 'Topic tags for readiness grouping, e.g. {discovery,objection-handling}';
COMMENT ON COLUMN public.tenant_courses.tags IS 'Topic tags for readiness grouping, e.g. {onboarding,product-knowledge}';

-- ── 2. quiz_attempts ──────────────────────────────────────────────────────────
-- One row per quiz attempt per user. Powers quiz accuracy analytics and
-- topic-level readiness scoring.

CREATE TABLE IF NOT EXISTS public.quiz_attempts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES public.tenants(id)         ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES public.profiles(id)        ON DELETE CASCADE,
  quiz_id     UUID        NOT NULL REFERENCES public.tenant_quizzes(id)  ON DELETE CASCADE,
  score       INTEGER     NOT NULL CHECK (score >= 0 AND score <= 100),
  passed      BOOLEAN     NOT NULL,
  attempt_num INTEGER     NOT NULL DEFAULT 1,
  answers     JSONB       NOT NULL DEFAULT '[]',
  -- answers format: [{ question_idx, question_text, selected, correct_answer, is_correct, time_ms }]
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.quiz_attempts              IS 'Per-attempt quiz results — source of truth for quiz accuracy analytics';
COMMENT ON COLUMN public.quiz_attempts.score        IS 'Percent correct (0-100)';
COMMENT ON COLUMN public.quiz_attempts.attempt_num  IS '1-based attempt counter per user per quiz';
COMMENT ON COLUMN public.quiz_attempts.answers      IS 'Array of per-question answer details for drill-down analytics';

-- Indexes
CREATE INDEX IF NOT EXISTS idx_qa_tenant_user
  ON public.quiz_attempts (tenant_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qa_quiz_user
  ON public.quiz_attempts (quiz_id, user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_qa_tenant_quiz
  ON public.quiz_attempts (tenant_id, quiz_id);

-- RLS
ALTER TABLE public.quiz_attempts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quiz_attempts' AND policyname = 'quiz_attempts_tenant_read') THEN
    CREATE POLICY "quiz_attempts_tenant_read"
      ON public.quiz_attempts FOR SELECT TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'quiz_attempts' AND policyname = 'quiz_attempts_own_insert') THEN
    CREATE POLICY "quiz_attempts_own_insert"
      ON public.quiz_attempts FOR INSERT TO authenticated
      WITH CHECK (
        user_id = auth.uid()
        AND tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid())
      );
  END IF;
END $$;

-- ── 3. readiness_scores ───────────────────────────────────────────────────────
-- Cached readiness score per user, computed from aggregated performance data.
-- Recomputed on demand; latest row per user is the current score.

CREATE TABLE IF NOT EXISTS public.readiness_scores (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID        NOT NULL REFERENCES public.tenants(id)  ON DELETE CASCADE,
  user_id            UUID        NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  score              INTEGER     NOT NULL CHECK (score >= 0 AND score <= 100),
  -- Component sub-scores (0-100 each)
  learning_score     INTEGER     NOT NULL DEFAULT 0, -- lesson/course completion rate
  quiz_score         INTEGER     NOT NULL DEFAULT 0, -- avg quiz accuracy
  game_score         INTEGER     NOT NULL DEFAULT 0, -- game performance + participation
  -- Activity counts used in computation
  lessons_completed  INTEGER     NOT NULL DEFAULT 0,
  courses_completed  INTEGER     NOT NULL DEFAULT 0,
  quizzes_passed     INTEGER     NOT NULL DEFAULT 0,
  quizzes_attempted  INTEGER     NOT NULL DEFAULT 0,
  games_played       INTEGER     NOT NULL DEFAULT 0,
  -- Window
  window_days        INTEGER     NOT NULL DEFAULT 30,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.readiness_scores          IS 'Cached 0-100 readiness score per user; recomputed on demand';
COMMENT ON COLUMN public.readiness_scores.score    IS 'Composite readiness score (0-100)';

CREATE INDEX IF NOT EXISTS idx_rs_tenant_user
  ON public.readiness_scores (tenant_id, user_id, computed_at DESC);

ALTER TABLE public.readiness_scores ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'readiness_scores' AND policyname = 'readiness_scores_tenant_read') THEN
    CREATE POLICY "readiness_scores_tenant_read"
      ON public.readiness_scores FOR SELECT TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'readiness_scores' AND policyname = 'readiness_scores_own_insert') THEN
    CREATE POLICY "readiness_scores_own_insert"
      ON public.readiness_scores FOR INSERT TO authenticated
      WITH CHECK (
        user_id = auth.uid()
        AND tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid())
      );
  END IF;
END $$;

-- ── 4. ai_insights ────────────────────────────────────────────────────────────
-- Cached AI-generated summaries and recommendations.
-- scope: 'user' | 'team' | 'org'
-- scope_id: user UUID, team UUID, or tenant UUID (as text)

CREATE TABLE IF NOT EXISTS public.ai_insights (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID        NOT NULL REFERENCES public.tenants(id)  ON DELETE CASCADE,
  scope           TEXT        NOT NULL CHECK (scope IN ('user','team','org')),
  scope_id        TEXT        NOT NULL,
  summary         TEXT        NOT NULL,
  recommendations JSONB       NOT NULL DEFAULT '[]',
  -- recommendations format: [{ priority, action, reason, type }]
  input_hash      TEXT,       -- hash of input data — used to skip regeneration if data unchanged
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE  public.ai_insights                  IS 'Cached AI-generated summaries per user/team/org';
COMMENT ON COLUMN public.ai_insights.scope            IS 'user | team | org';
COMMENT ON COLUMN public.ai_insights.scope_id         IS 'UUID of the user, team, or tenant this insight is for';
COMMENT ON COLUMN public.ai_insights.input_hash       IS 'MD5 of input data — skip AI call if unchanged';
COMMENT ON COLUMN public.ai_insights.recommendations  IS 'Ranked list of recommended actions with priority and reason';

CREATE INDEX IF NOT EXISTS idx_ai_insights_tenant_scope
  ON public.ai_insights (tenant_id, scope, scope_id, generated_at DESC);

ALTER TABLE public.ai_insights ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_insights' AND policyname = 'ai_insights_tenant_read') THEN
    CREATE POLICY "ai_insights_tenant_read"
      ON public.ai_insights FOR SELECT TO authenticated
      USING (tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'ai_insights' AND policyname = 'ai_insights_own_insert') THEN
    CREATE POLICY "ai_insights_own_insert"
      ON public.ai_insights FOR INSERT TO authenticated
      WITH CHECK (tenant_id IN (SELECT tenant_id FROM public.profiles WHERE id = auth.uid()));
  END IF;
END $$;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT table_name FROM information_schema.tables
-- WHERE table_schema = 'public'
--   AND table_name IN ('quiz_attempts','readiness_scores','ai_insights');
