-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 090 — Readiness V2 automation: CATALOG / TAXONOMY PROPAGATION (Phase 088B-2) — ADDITIVE
--
-- Propagates readiness-relevant CATALOG changes to the recalc queue via a DURABLE OUTBOX + BOUNDED WORKER,
-- so a catalog write never does an unbounded synchronous per-learner fan-out, yet every affected learner is
-- eventually covered (durable continuation, no starvation). Scoring stays the existing 088 consumer's job;
-- this migration is ENQUEUE-ONLY. It never rewrites readiness history or quiz attempts, never touches legacy
-- `readiness_scores`, the V2 formula, or the three existing cron jobs.
--
-- ── SCOPE (from audit; approved) ──────────────────────────────────────────────
-- readiness_compute_v2 attributes evidence ONLY from IMMUTABLE attempt snapshots (quiz_attempt_tags),
-- resolving merges and checking CURRENT tag status + the quiz's CURRENT primary tag. Therefore the catalog
-- events that actually change EXISTING scores are:
--   * Tag ARCHIVE / RESTORE  (tenant_quiz_tags.status)      → primary-validity (primaryArchived) changes.
--   * Tag MERGE              (tenant_quiz_tags.merged_into)  → the resolve chain re-maps the snapshot tag.
--   * Quiz PRIMARY-tag change (tenant_quizzes.primary_readiness_tag_id) → per-quiz attribution changes.
-- NOT propagated (proven score-neutral under snapshot immutability — verified compute_v2 ignores them):
--   * Quiz active/archived status  — compute never reads tenant_quizzes.status.
--   * quiz_tag_map insert/delete   — attribution uses the immutable snapshot, not current quiz_tag_map
--                                    (only FUTURE attempts' snapshots change).
-- Already covered elsewhere (not duplicated): configuration activation → readiness_v2_activate (087);
-- verified attempts → 088 trigger; missed enqueues → 089 recovery sweep.
--
-- ── ARCHITECTURE (trigger-only is insufficient) ───────────────────────────────
-- A trigger that synchronously enqueues every affected learner is either unbounded (prohibited) or
-- bounded-and-drops-the-remainder (starvation); and the 089 watermark sweep can't see catalog changes
-- (no new attempt). So:
--   (1) readiness_propagation_events — a small OUTBOX. Each catalog change inserts ONE O(1) coalesced row
--       {tenant, event_type, subject}. Fail-open. A unique partial index coalesces duplicate PENDING events
--       for the same subject.
--   (2) readiness_process_propagation_batch(...) — a bounded worker (new cron), claims events FOR UPDATE
--       SKIP LOCKED, resolves the affected scorable reps for the event, enqueues a BOUNDED PAGE
--       (user_id > cursor ORDER BY user_id LIMIT N) into the existing recalc queue (reason 'catalog_change'),
--       advances the cursor, and leaves the event 'pending' until the affected set is exhausted → durable
--       continuation, no first-page starvation, no skipped remainder. Retry/backoff/dead_letter; dead-letter
--       events are never auto-revived. Idempotent (queue coalescing + compute material-hash dedup).
--   (3) readiness_set_quiz_primary_tag (087) is REFACTORED: its previous UNBOUNDED synchronous all-tenant-
--       reps fan-out (a demonstrated instance of the pattern this phase forbids) is replaced by emitting ONE
--       'quiz_primary_changed' outbox event. All authz/validation is preserved byte-for-byte.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- (1) OUTBOX
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.readiness_propagation_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type      text NOT NULL CHECK (event_type IN ('tag_changed','quiz_primary_changed')),
  subject_tag_id  uuid,
  subject_quiz_id uuid,
  subject_id      uuid GENERATED ALWAYS AS (COALESCE(subject_tag_id, subject_quiz_id)) STORED,
  cursor_user_id  uuid,                                   -- last enqueued user (durable continuation); NULL = from start
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','dead_letter')),
  attempt_count   integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz
);
-- Coalesce duplicate PENDING events for the same subject (a processing event never blocks emit; a new
-- pending event created during processing simply re-scans fully next run — safe, non-blocking).
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_pending_subject
  ON public.readiness_propagation_events (tenant_id, event_type, subject_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_prop_claim
  ON public.readiness_propagation_events (next_attempt_at) WHERE status = 'pending';

-- Ops-internal: no client access. RLS on, no policies; server-only (definer functions own the table).
ALTER TABLE public.readiness_propagation_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.readiness_propagation_events FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- (2) EMIT HELPER — O(1) coalesced outbox insert; server-only; fail-open at call sites
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_emit_propagation_event(
  p_tenant uuid, p_event_type text, p_tag_id uuid, p_quiz_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE v_subject uuid := COALESCE(p_tag_id, p_quiz_id);
BEGIN
  IF p_tenant IS NULL OR v_subject IS NULL THEN RETURN; END IF;
  -- Only for tenants with an ACTIVE v2 config (otherwise nothing to propagate).
  IF NOT EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                  WHERE v.tenant_id = p_tenant AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery') THEN
    RETURN;
  END IF;

  -- Coalesce: refresh an existing PENDING event for this subject (restart its scan), else insert one.
  UPDATE public.readiness_propagation_events
     SET updated_at = now(), cursor_user_id = NULL, next_attempt_at = LEAST(next_attempt_at, now())
   WHERE tenant_id = p_tenant AND event_type = p_event_type AND subject_id = v_subject AND status = 'pending';
  IF FOUND THEN RETURN; END IF;

  BEGIN
    INSERT INTO public.readiness_propagation_events (tenant_id, event_type, subject_tag_id, subject_quiz_id)
    VALUES (p_tenant, p_event_type, p_tag_id, p_quiz_id);
  EXCEPTION WHEN unique_violation THEN
    UPDATE public.readiness_propagation_events
       SET updated_at = now(), cursor_user_id = NULL, next_attempt_at = LEAST(next_attempt_at, now())
     WHERE tenant_id = p_tenant AND event_type = p_event_type AND subject_id = v_subject AND status = 'pending';
  END;
END
$fn$;
REVOKE ALL ON FUNCTION public.readiness_emit_propagation_event(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- (3) BOUNDED WORKER — durable continuation via cursor; enqueue-only
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_process_propagation_batch(
  p_event_limit integer DEFAULT 20,
  p_user_limit  integer DEFAULT 200,
  p_now         timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ev   record;
  v_uid  uuid;
  v_last uuid;
  v_cnt  int;
  v_elim int := GREATEST(COALESCE(p_event_limit,20),1);
  v_ulim int := GREATEST(COALESCE(p_user_limit,200),1);
  v_events int := 0; v_enq int := 0; v_completed int := 0; v_continued int := 0; v_failed int := 0;
BEGIN
  FOR v_ev IN
    SELECT * FROM public.readiness_propagation_events
     WHERE status='pending' AND next_attempt_at <= p_now
     ORDER BY next_attempt_at
     FOR UPDATE SKIP LOCKED
     LIMIT v_elim
  LOOP
    v_events := v_events + 1;
    UPDATE public.readiness_propagation_events SET status='processing', updated_at=now() WHERE id=v_ev.id;
    BEGIN
      -- No active v2 anymore → nothing to propagate; complete.
      IF NOT EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                      WHERE v.tenant_id=v_ev.tenant_id AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery') THEN
        UPDATE public.readiness_propagation_events SET status='completed', processed_at=now(), updated_at=now() WHERE id=v_ev.id;
        v_completed := v_completed + 1;
        CONTINUE;
      END IF;

      v_cnt := 0; v_last := v_ev.cursor_user_id;
      FOR v_uid IN
        SELECT s.u FROM (
          -- tag_changed: scorable reps whose IMMUTABLE snapshot carries the changed tag
          SELECT DISTINCT a.user_id AS u
            FROM public.quiz_attempt_tags qt
            JOIN public.quiz_attempts a ON a.id = qt.attempt_id AND a.tenant_id = qt.tenant_id
            JOIN public.profiles p ON p.id = a.user_id
           WHERE v_ev.event_type='tag_changed'
             AND qt.tenant_id = v_ev.tenant_id AND qt.tag_id = v_ev.subject_tag_id
             AND a.grading_provenance='server_v2'
             AND p.tenant_id = v_ev.tenant_id AND p.role='user' AND COALESCE(p.status,'active')<>'inactive'
          UNION
          -- quiz_primary_changed: scorable reps with a verified attempt on the quiz
          SELECT DISTINCT a.user_id AS u
            FROM public.quiz_attempts a
            JOIN public.profiles p ON p.id = a.user_id
           WHERE v_ev.event_type='quiz_primary_changed'
             AND a.tenant_id = v_ev.tenant_id AND a.quiz_id = v_ev.subject_quiz_id
             AND a.grading_provenance='server_v2'
             AND p.tenant_id = v_ev.tenant_id AND p.role='user' AND COALESCE(p.status,'active')<>'inactive'
        ) s
        WHERE s.u > COALESCE(v_ev.cursor_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
        ORDER BY s.u
        LIMIT v_ulim
      LOOP
        PERFORM public.enqueue_readiness_recalc(v_ev.tenant_id, v_uid, NULL, 'catalog_change',
                  jsonb_build_object('source','propagation','eventType',v_ev.event_type));
        v_last := v_uid; v_cnt := v_cnt + 1; v_enq := v_enq + 1;
      END LOOP;

      IF v_cnt >= v_ulim THEN
        -- A full page — more may remain: keep pending, advance cursor (reset failure budget on progress).
        UPDATE public.readiness_propagation_events
           SET status='pending', cursor_user_id=v_last, attempt_count=0, next_attempt_at=now(), updated_at=now(), last_error=NULL
         WHERE id=v_ev.id;
        v_continued := v_continued + 1;
      ELSE
        -- Exhausted (partial or empty page) → done.
        UPDATE public.readiness_propagation_events
           SET status='completed', cursor_user_id=v_last, processed_at=now(), updated_at=now(), last_error=NULL
         WHERE id=v_ev.id;
        v_completed := v_completed + 1;
      END IF;

    EXCEPTION WHEN OTHERS THEN
      UPDATE public.readiness_propagation_events
         SET status = CASE WHEN attempt_count >= 5 THEN 'dead_letter' ELSE 'pending' END,
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + (interval '1 minute' * LEAST(attempt_count+1,5)),
             last_error = left(SQLERRM, 300), updated_at = now()
       WHERE id=v_ev.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('events',v_events,'enqueued',v_enq,'completed',v_completed,'continued',v_continued,'failed',v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.readiness_process_propagation_batch(integer,integer,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_process_propagation_batch(integer,integer,timestamptz) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- (4) CATALOG TRIGGER — tag archive/restore/merge → outbox (fail-open, O(1))
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tenant_quiz_tags_emit_readiness_propagation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP='UPDATE'
     AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into IS DISTINCT FROM OLD.merged_into) THEN
    BEGIN
      PERFORM public.readiness_emit_propagation_event(NEW.tenant_id, 'tag_changed', NEW.id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'readiness: catalog propagation skipped for a tag change (non-fatal)';  -- fail-open; fixed literal, no error text
    END;
  END IF;
  RETURN NULL;
END
$fn$;
REVOKE ALL ON FUNCTION public.tenant_quiz_tags_emit_readiness_propagation() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_tag_readiness_propagation ON public.tenant_quiz_tags;
CREATE TRIGGER trg_tag_readiness_propagation
  AFTER UPDATE OF status, merged_into ON public.tenant_quiz_tags
  FOR EACH ROW EXECUTE FUNCTION public.tenant_quiz_tags_emit_readiness_propagation();

-- ══════════════════════════════════════════════════════════════════════════════
-- (5) REFACTOR 087 primary-tag RPC: emit ONE bounded outbox event instead of the unbounded
--     synchronous all-tenant-reps fan-out. Authz/validation preserved byte-for-byte. Fail-open on emit.
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_set_quiz_primary_tag(p_quiz_id uuid, p_tag_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
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

  -- 090: bounded propagation via the outbox (replaces the prior unbounded synchronous all-reps fan-out).
  -- Fail-open: a propagation failure never aborts the manager's primary-tag change.
  BEGIN
    PERFORM public.readiness_emit_propagation_event(v_tenant, 'quiz_primary_changed', NULL, p_quiz_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'readiness: catalog propagation skipped for a primary-tag change (non-fatal)';
  END;

  RETURN jsonb_build_object('quizId', p_quiz_id, 'primaryReadinessTagId', (SELECT primary_readiness_tag_id FROM public.tenant_quizzes WHERE id = p_quiz_id));
END $function$;
-- (grants unchanged from 087: authenticated may execute; internal authz gates it.)

-- ══════════════════════════════════════════════════════════════════════════════
-- (6) PROPAGATION WORKER CRON — in-DB, credential-free, uniquely named, idempotent
-- ══════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $cron$
DECLARE
  c_job_name text := 'readiness_propagation_worker';
  c_schedule text := '* * * * *';                                            -- every minute
  c_command  text := 'SELECT public.readiness_process_propagation_batch();';
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = c_job_name;  -- ONLY our job
  PERFORM cron.schedule(c_job_name, c_schedule, c_command);
  RAISE NOTICE '090: scheduled in-DB readiness propagation worker cron % (%) -> %', c_job_name, c_schedule, c_command;
END
$cron$;

-- ── AUDIT ─────────────────────────────────────────────────────────────────────
--   SELECT jobname, schedule, active, username, command FROM cron.job WHERE jobname='readiness_propagation_worker';
--   -- untouched: readiness_recalc_consumer(088), readiness_recovery_sweep(089), verify-queue-worker-every-minute(games)

-- ── ROLLBACK (removes only 090 objects; restores 087 RPC behavior) ────────────
--   DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_propagation_worker'; END $r$;
--   DROP TRIGGER IF EXISTS trg_tag_readiness_propagation ON public.tenant_quiz_tags;
--   DROP FUNCTION IF EXISTS public.tenant_quiz_tags_emit_readiness_propagation();
--   DROP FUNCTION IF EXISTS public.readiness_process_propagation_batch(integer,integer,timestamptz);
--   DROP FUNCTION IF EXISTS public.readiness_emit_propagation_event(uuid,text,uuid,uuid);
--   DROP TABLE IF EXISTS public.readiness_propagation_events;
--   -- To fully revert the 087 RPC to its pre-090 body, re-apply migration 087's readiness_set_quiz_primary_tag
--   --   definition (the inline all-reps fan-out). 088/089 objects and all three other crons are untouched.
-- ─────────────────────────────────────────────────────────────────────────────
