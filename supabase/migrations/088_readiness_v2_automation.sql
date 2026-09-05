-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 088 — Readiness V2 automation foundation (S1 ONLY) — ADDITIVE, backend only
--
-- Closes the two S1 gaps found in the pipeline audit (docs/engineering/DEPLOYMENT_LEDGER.md):
-- the readiness recalc queue had NO producer for learner activity and NO consumer at all.
-- This migration wires ONLY those two, on top of 050–053 (queue + enqueue) and 087 (v2 config/
-- compute/batch). It is shadow-safe: it never reads/writes legacy `readiness_scores`, never cuts
-- the Leadership Dashboard over, and computes only into the versioned V2 tables via the existing
-- SECURITY DEFINER path.
--
--   (1) ENQUEUE: an AFTER INSERT trigger on public.quiz_attempts that, IN THE SAME TRANSACTION as
--       the committed attempt, enqueues exactly one coalesced readiness recalc IFF the attempt is an
--       eligible verified CURRENT-version server_v2 attempt by an ACTIVE SCORABLE LEARNER in a tenant
--       that has an ACTIVE v2 configuration. Reuses enqueue_readiness_recalc (target ACTIVE, reason
--       'quiz_attempt'); no queue logic is duplicated. Idempotent under retries/double-submits.
--       FAIL-OPEN (see decision note): a readiness-enqueue error NEVER aborts the quiz submission.
--
--   (2) CONSUMER: one idempotently-managed pg_cron schedule that invokes readiness_process_recalc_batch
--       DIRECTLY in-database. No Edge Function, HTTP, pg_net, Vault secret, or service-role key. Uniquely
--       named, bounded batch, re-apply safe, and it leaves the Ralli Live verification cron untouched.
--
-- Catalog/profile/staleness triggers, dead-letter/queue observability = Phase 088B (see footer). NOT here.
--
-- ── FAIL-OPEN vs FAIL-CLOSED (explicit decision — enqueue failure) ────────────
-- DECISION: FAIL OPEN. The enqueue is wrapped so that if enqueue_readiness_recalc raises for ANY
-- reason, the learner's already-inserted quiz attempt still commits and the submission succeeds.
-- Rationale: readiness is a downstream, server-authoritative SHADOW signal; coupling core quiz-taking
-- availability to the readiness subsystem would let a readiness hiccup block learners — a severe UX/
-- availability regression — whereas a missed enqueue is self-healing and never yields a WRONG score:
-- a later attempt, a config/primary change, or the planned 088B time-based staleness/backfill sweep
-- re-enqueues the rep, and a periodic reconciliation run_shadow recovers any gap. Trade-off: enqueue
-- durability is "eventually", not "exactly at this commit"; the 088B periodic sweep is the durability
-- backstop. On the SUCCESS path the enqueue still commits atomically in the same transaction as the
-- attempt (a rolled-back attempt leaves no queue row). No answers/content/PII are ever logged.
--
-- ── LEASE RECOVERY: intentionally NOT included (proven unnecessary) ───────────
-- readiness_process_recalc_batch is a plpgsql FUNCTION (not a PROCEDURE) and performs no COMMIT: for
-- each claimed job, claim (UPDATE→'processing') + readiness_compute_v2 + completion (UPDATE→'completed'
-- | 'pending' | 'dead_letter') all run inside the SINGLE transaction of the invoking
-- `SELECT readiness_process_recalc_batch(...)`. A backend crash therefore rolls the WHOLE transaction
-- back, including the 'processing' claim, so a row can never be left COMMITTED in 'processing'. There
-- is no reachable stale-lease state, so no lease-recovery sweep is added (avoids speculative scope).
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- (1) ELIGIBLE-ATTEMPT ENQUEUE
-- ══════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.quiz_attempts_enqueue_readiness_recalc()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_current_rev text;
BEGIN
  -- Cheapest disqualifiers first. A direct REST insert cannot set grading_provenance (column-level
  -- grant in 054 omits it), so the server_v2 gate cannot be forged by a learner.
  IF NEW.grading_provenance IS DISTINCT FROM 'server_v2' THEN RETURN NULL; END IF;   -- legacy/unverified
  IF NEW.verified_revision IS NULL THEN RETURN NULL; END IF;                          -- unverified

  -- Must match the quiz's CURRENT revision (rejects stale/superseded evidence; also rejects a missing quiz).
  SELECT q.question_revision INTO v_current_rev
    FROM public.tenant_quizzes q
   WHERE q.id = NEW.quiz_id AND q.tenant_id = NEW.tenant_id;
  IF v_current_rev IS NULL OR NEW.verified_revision <> v_current_rev THEN RETURN NULL; END IF;

  -- Active scorable learner (role='user', not inactive) IN THE SAME TENANT (rejects cross-tenant,
  -- inactive users, managers/admins). Reuses the canonical 087 predicate.
  IF NOT public.readiness_is_scorable_rep(NEW.tenant_id, NEW.user_id) THEN RETURN NULL; END IF;

  -- Only when the tenant actually has an ACTIVE v2 configuration — otherwise the ACTIVE target would
  -- resolve to a non-v2 / absent version and produce pointless (or no-op) work.
  IF NOT EXISTS (
    SELECT 1 FROM public.readiness_formula_versions v
     WHERE v.tenant_id = NEW.tenant_id
       AND v.status = 'active'
       AND v.configuration->>'model' = 'v2_quiz_mastery'
  ) THEN RETURN NULL; END IF;

  -- FAIL-OPEN enqueue: reuse the single canonical coalescing enqueue. version=NULL → target 'ACTIVE'
  -- (recompute under whatever is active at process time). source_ref carries only non-sensitive ids.
  BEGIN
    PERFORM public.enqueue_readiness_recalc(
      NEW.tenant_id, NEW.user_id, NULL, 'quiz_attempt',
      jsonb_build_object('attemptId', NEW.id, 'quizId', NEW.quiz_id));
  EXCEPTION WHEN OTHERS THEN
    -- Never abort the learner's committed attempt for a readiness-side failure. No PII/answers/content.
    RAISE WARNING 'readiness: enqueue skipped for a quiz attempt (non-fatal): %', SQLERRM;
  END;

  RETURN NULL;  -- AFTER trigger: return value ignored
END
$fn$;

-- Definer helper: never client-invocable (the trigger is the only caller).
REVOKE ALL ON FUNCTION public.quiz_attempts_enqueue_readiness_recalc() FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.quiz_attempts_enqueue_readiness_recalc() IS
  'AFTER INSERT trigger fn (088): enqueues one coalesced readiness recalc (reason quiz_attempt, target '
  'ACTIVE) for an eligible verified current-version server_v2 attempt by an active scorable learner in a '
  'tenant with an active v2 config. FAIL-OPEN: never blocks the quiz submission. Reuses enqueue_readiness_recalc.';

DROP TRIGGER IF EXISTS trg_enqueue_readiness_on_attempt ON public.quiz_attempts;
CREATE TRIGGER trg_enqueue_readiness_on_attempt
  AFTER INSERT ON public.quiz_attempts
  FOR EACH ROW
  EXECUTE FUNCTION public.quiz_attempts_enqueue_readiness_recalc();

-- ══════════════════════════════════════════════════════════════════════════════
-- (2) READINESS QUEUE CONSUMER — in-database pg_cron (no Edge/HTTP/Vault/service-role)
-- ══════════════════════════════════════════════════════════════════════════════

-- Present in production; a no-op there. Locally, makes the schedule testable.
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Idempotently (re-apply safe) install EXACTLY ONE uniquely-named readiness consumer job that runs the
-- bounded batch processor directly in-DB. The DO block unschedules ONLY our own job by its unique name
-- first, so re-running this migration never duplicates it AND never touches the Ralli Live verification
-- cron ('verify-queue-worker-every-minute') or any other job. Batch is bounded (50). The command is a
-- plain SELECT of a SECURITY DEFINER function — it carries no secret, credential, URL, or content.
DO $cron$
DECLARE
  c_job_name text := 'readiness_recalc_consumer';
  c_schedule text := '* * * * *';                                           -- every minute
  c_command  text := 'SELECT public.readiness_process_recalc_batch(50, ''cron'');';  -- bounded batch, in-DB
BEGIN
  PERFORM cron.unschedule(j.jobid)
    FROM cron.job j
   WHERE j.jobname = c_job_name;   -- removes ONLY our job if it already exists; no-op otherwise

  PERFORM cron.schedule(c_job_name, c_schedule, c_command);

  RAISE NOTICE '088: scheduled in-DB readiness consumer cron % (% ) -> %', c_job_name, c_schedule, c_command;
END
$cron$;

-- ── AUDIT: verify exactly one readiness consumer job exists and the game cron is intact ───────────────
--   SELECT jobname, schedule, active, command FROM cron.job WHERE jobname='readiness_recalc_consumer';
--   SELECT jobname, schedule, active FROM cron.job WHERE jobname='verify-queue-worker-every-minute';  -- unchanged

-- ── ROLLBACK (disable/unschedule + drop trigger) ─────────────────────────────
--   -- (2) stop & remove the consumer schedule (safe if already absent):
--   DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_recalc_consumer'; END $r$;
--   -- (1) remove the enqueue trigger + its function:
--   DROP TRIGGER IF EXISTS trg_enqueue_readiness_on_attempt ON public.quiz_attempts;
--   DROP FUNCTION IF EXISTS public.quiz_attempts_enqueue_readiness_recalc();
--   -- (pg_cron extension is left installed; it is shared infrastructure.)

-- ── PHASE 088B — follow-up requirements (documented, NOT implemented here) ────
--   * Catalog enqueues: quiz revision/content change, quiz archive, tag assign/archive/merge
--     (reasons catalog_change / content_archived) — AFTER triggers on tenant_quizzes / tenant_quiz_tags
--     / quiz_tag_map.
--   * Readiness designation changes: enqueue affected reps when readiness_tag_designations change.
--   * Profile/role/status lifecycle: AFTER triggers on profiles (status/role/team) to (de)enqueue reps.
--   * Daily 120-day staleness sweep: a scheduled function that enqueues Established reps whose required-
--     area currency is about to lapse, so scores recompute with no new user event.
--   * Queue health / dead-letter observability: a counts-only view/log (no answers/content) for depth,
--     age, ret#, and dead-letter surfacing; optional processing-lease reclaim IF a committed stuck
--     'processing' state is ever proven reachable (it is not today — see header).
-- ─────────────────────────────────────────────────────────────────────────────
