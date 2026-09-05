-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 089 — Readiness V2 automation: MISSED-ENQUEUE RECOVERY (Phase 088B-1) — ADDITIVE
--
-- The 088 enqueue trigger is FAIL-OPEN: a readiness-enqueue error never blocks the learner's quiz
-- submission, but a dropped enqueue then leaves that rep's readiness stale with no automatic recovery.
-- This migration adds the bounded, idempotent recovery backstop the 088 header promised — nothing else.
-- It is enqueue-only: it never computes scores, never touches legacy `readiness_scores`, the V2 formula,
-- history, current scores, the 088 trigger/consumer, or the two existing production cron jobs.
--
--   (1) readiness_recover_missed_enqueues(p_tenant, p_limit): for each tenant with an ACTIVE v2 config,
--       find ACTIVE SCORABLE learners whose newest ELIGIBLE current-comparable server_v2 attempt is newer
--       than their readiness_scores_current.last_attempt_at (or who have eligible evidence but NO current
--       row), that do NOT already have a live (pending/processing) ACTIVE job, and enqueue each through the
--       canonical enqueue_readiness_recalc (reason 'backfill', target ACTIVE). Bounded per tenant per run;
--       per-rep fail-open. Learners with NO eligible evidence are NEVER enqueued (a missing current row
--       alone is not a reason).
--   (2) One postgres-owned pg_cron job 'readiness_recovery_sweep' every 5 minutes calling it in-DB
--       (no URL / token / Vault / Edge Function). Idempotent install; leaves all other crons untouched.
--
-- ── NO-STARVATION / BATCHING CONTINUATION (design proof) ──────────────────────
-- Each run selects only reps WITHOUT a live ACTIVE job, ordered by the most-behind watermark first
-- (last_attempt_at NULLS FIRST), LIMIT p_limit per tenant. Consequences:
--   * If the consumer lags (enqueued jobs still pending), those reps now HAVE a live job, so the NEXT
--     run's selection skips them and picks the next p_limit NEW reps — coverage advances every run; the
--     remainder is never permanently starved behind a fixed "first page".
--   * When the consumer drains a job, readiness_compute_v2 sets last_attempt_at = now, so that rep's
--     watermark is no longer behind its newest attempt and it drops out of the eligible set entirely.
-- Either way the eligible set strictly shrinks across runs until empty. Idempotent: enqueue coalesces on
-- uq_recalc_live_job (no duplicate live jobs) and compute dedups history by material hash (no duplicate
-- history when evidence is unchanged).
--
-- ── ELIGIBILITY (matches readiness_compute_v2's attempt gate) ─────────────────
-- An attempt is ELIGIBLE iff: grading_provenance='server_v2' AND score IS NOT NULL AND verified_revision
-- IS NOT NULL AND verified_revision = the quiz's CURRENT question_revision AND a quiz_attempt_tag_snapshots
-- envelope exists. This is exactly compute_v2's `att` CTE, so recovery never enqueues a rep whose evidence
-- compute would ignore, and never on a missing current row alone.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.readiness_recover_missed_enqueues(
  p_tenant uuid DEFAULT NULL,
  p_limit  integer DEFAULT 500
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_tenant   uuid;
  v_version  uuid;
  v_uid      uuid;
  v_lim      int := GREATEST(COALESCE(p_limit, 500), 1);
  v_tenants  int := 0;
  v_enq      int := 0;
BEGIN
  FOR v_tenant, v_version IN
    SELECT f.tenant_id, f.id
      FROM public.readiness_formula_versions f
     WHERE f.status = 'active'
       AND f.configuration->>'model' = 'v2_quiz_mastery'
       AND (p_tenant IS NULL OR f.tenant_id = p_tenant)
  LOOP
    v_tenants := v_tenants + 1;

    FOR v_uid IN
      WITH newest AS (   -- newest ELIGIBLE current-comparable server_v2 attempt per scorable rep
        SELECT a.user_id, max(a.created_at) AS newest_at
          FROM public.quiz_attempts a
          JOIN public.tenant_quizzes q ON q.id = a.quiz_id AND q.tenant_id = a.tenant_id
          JOIN public.profiles p ON p.id = a.user_id
         WHERE a.tenant_id = v_tenant
           AND a.grading_provenance = 'server_v2'
           AND a.score IS NOT NULL
           AND a.verified_revision IS NOT NULL
           AND a.verified_revision = q.question_revision
           AND EXISTS (SELECT 1 FROM public.quiz_attempt_tag_snapshots s WHERE s.attempt_id = a.id)
           AND p.tenant_id = v_tenant
           AND p.role = 'user'
           AND COALESCE(p.status,'active') <> 'inactive'
         GROUP BY a.user_id
      ),
      cur AS (
        SELECT user_id, last_attempt_at
          FROM public.readiness_scores_current
         WHERE tenant_id = v_tenant AND formula_version_id = v_version
      )
      SELECT n.user_id
        FROM newest n
        LEFT JOIN cur c ON c.user_id = n.user_id
       WHERE (c.user_id IS NULL OR c.last_attempt_at IS NULL OR n.newest_at > c.last_attempt_at)  -- behind watermark, or no row despite evidence
         AND NOT EXISTS (                                                                          -- skip reps already queued (no wasted slot, no starvation)
           SELECT 1 FROM public.readiness_recalc_queue r
            WHERE r.tenant_id = v_tenant AND r.user_id = n.user_id
              AND r.target_key = 'ACTIVE' AND r.status IN ('pending','processing'))
       ORDER BY c.last_attempt_at NULLS FIRST, n.newest_at, n.user_id                              -- most-behind first (fair)
       LIMIT v_lim
    LOOP
      -- Per-rep fail-open: one rep's enqueue error never aborts the sweep. version=NULL → target ACTIVE.
      BEGIN
        PERFORM public.enqueue_readiness_recalc(v_tenant, v_uid, NULL, 'backfill',
                                                jsonb_build_object('source','recovery'));
        v_enq := v_enq + 1;
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'readiness: recovery enqueue skipped for one learner (non-fatal)';  -- fixed literal; no error text/ids/PII
      END;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('tenantsScanned', v_tenants, 'enqueued', v_enq, 'limitPerTenant', v_lim);
END
$fn$;

-- Server-only: never client-invocable. Owner postgres; runs in-DB via pg_cron (as postgres).
REVOKE ALL ON FUNCTION public.readiness_recover_missed_enqueues(uuid,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_recover_missed_enqueues(uuid,integer) TO service_role;

COMMENT ON FUNCTION public.readiness_recover_missed_enqueues(uuid,integer) IS
  'Phase 088B-1 recovery backstop: enqueues (reason backfill, target ACTIVE) active scorable learners in '
  'active-v2 tenants whose newest eligible current-comparable server_v2 attempt is newer than '
  'readiness_scores_current.last_attempt_at (or who have eligible evidence but no current row) and have no '
  'live ACTIVE job. Bounded per tenant, fail-open, coalesced, watermark-driven (no starvation). Enqueue-only.';

-- ── CONSUMER-INDEPENDENT RECOVERY CRON (in-DB; no Edge/HTTP/Vault/service-role key) ───────────────────
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
DECLARE
  c_job_name text := 'readiness_recovery_sweep';
  c_schedule text := '*/5 * * * *';                                    -- every 5 minutes
  c_command  text := 'SELECT public.readiness_recover_missed_enqueues();';
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = c_job_name;  -- ONLY our job; no-op otherwise
  PERFORM cron.schedule(c_job_name, c_schedule, c_command);
  RAISE NOTICE '089: scheduled in-DB readiness recovery cron % (%) -> %', c_job_name, c_schedule, c_command;
END
$cron$;

-- ── AUDIT ─────────────────────────────────────────────────────────────────────
--   SELECT jobname, schedule, active, username, command FROM cron.job WHERE jobname='readiness_recovery_sweep';
--   -- untouched: 'readiness_recalc_consumer' (088) and 'verify-queue-worker-every-minute' (Ralli Live)

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
--   DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_recovery_sweep'; END $r$;
--   DROP FUNCTION IF EXISTS public.readiness_recover_missed_enqueues(uuid,integer);
--   -- (pg_cron left installed; 088 trigger/consumer, the game cron, and the V2 formula are untouched.)
-- ─────────────────────────────────────────────────────────────────────────────
