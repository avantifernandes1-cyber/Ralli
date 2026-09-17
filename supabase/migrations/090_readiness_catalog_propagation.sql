-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 090 — Readiness V2 automation: CATALOG / TAXONOMY PROPAGATION (Phase 088B-2) — ADDITIVE
--
-- Propagates readiness-relevant CATALOG changes to the recalc queue via a DURABLE OUTBOX + BOUNDED WORKER.
-- Enqueue-only; scoring stays the 088 consumer's job. Never rewrites history or attempts, never touches
-- legacy readiness_scores, the V2 formula, or the three existing cron jobs.
--
-- SCOPE (audit; approved): compute_v2 is IMMUTABLE-SNAPSHOT-driven, resolving the merge chain and checking
-- CURRENT tag status + the quiz's CURRENT primary tag. Events that change EXISTING scores:
--   * Tag ARCHIVE/RESTORE (tenant_quiz_tags.status) and MERGE (merged_into)  → 'tag_changed'
--   * Quiz PRIMARY-tag change (tenant_quizzes.primary_readiness_tag_id)       → 'quiz_primary_changed'
-- Score-neutral (NOT wired): quiz status, quiz_tag_map (attribution uses the immutable snapshot).
-- Already covered: config activation (087), attempts (088), missed enqueues (089).
--
-- ── CORRECTION HIGHLIGHTS vs the prior 090 draft ──────────────────────────────
-- (1) TRANSITIVE tag resolution: a change to tag X affects every snapshot tag whose resolution chain
--     passes through X — i.e. X and all its transitive merge PREDECESSORS (A→B→C: changing B or C affects
--     carriers of A). The worker expands X via a depth-bounded recursive reverse-walk (cycle-safe, mirrors
--     compute_v2's depth<20) and enqueues carriers of any tag in that set.
-- (2) GENERATION / DIRTY / RERUN: exactly ONE outbox row per (tenant,type,subject). Every emit bumps
--     `generation`, revives the row to 'pending', and resets the cursor to NULL. A change arriving while the
--     worker holds the row (FOR UPDATE) blocks briefly, then applies AFTER the worker's txn — forcing a
--     complete fresh pass from the beginning (already-processed learners reconsidered). No duplicate rows,
--     no lost change; queue coalescing still guarantees no duplicate live readiness jobs.
-- (3) DROPPED-EMIT RECOVERY: because catalog writes are fail-open, readiness_reconcile_catalog() (run at the
--     start of every worker tick, bounded by window+limit, active-v2 only) re-emits an event for any tag/
--     quiz whose sanctioned change (updated_at) has no covering event. All sanctioned change paths set
--     updated_at (taxonomy RPCs already do; the primary RPC below now does too), so a dropped emit is
--     recovered within one tick. Bounded — never an unbounded tenant-wide scan.
-- (4) ROLLBACK restores the EXACT pre-090 readiness_set_quiz_primary_tag (inline all-reps fan-out) + grants
--     — see docs/engineering/rollback_090_readiness_catalog_propagation.sql (self-contained) and the footer.
-- ─────────────────────────────────────────────────────────────────────────────

-- ══════════════════════════════════════════════════════════════════════════════
-- (1) OUTBOX — one row per (tenant,event_type,subject); generation/dirty semantics
-- ══════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.readiness_propagation_events (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  event_type                text NOT NULL CHECK (event_type IN ('tag_changed','quiz_primary_changed')),
  subject_tag_id            uuid,
  subject_quiz_id           uuid,
  subject_id                uuid GENERATED ALWAYS AS (COALESCE(subject_tag_id, subject_quiz_id)) STORED,
  generation                bigint NOT NULL DEFAULT 1,       -- bumped on every emit (dirty marker)
  last_processed_generation bigint NOT NULL DEFAULT 0,       -- generation fully covered by the worker
  cursor_user_id            uuid,                            -- durable continuation; NULL = from the start
  status                    text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','dead_letter')),
  attempt_count             integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at           timestamptz NOT NULL DEFAULT now(),
  last_error                text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  processed_at              timestamptz
);
-- ONE row per subject (unconditional) → continuation never collides with a dirty rerun.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prop_subject ON public.readiness_propagation_events (tenant_id, event_type, subject_id);
CREATE INDEX IF NOT EXISTS idx_prop_claim ON public.readiness_propagation_events (next_attempt_at) WHERE status='pending';
-- Reconcile change-detection scans (bounded by window); indexes keep them cheap at scale.
CREATE INDEX IF NOT EXISTS idx_tqt_updated_at ON public.tenant_quiz_tags (updated_at);
CREATE INDEX IF NOT EXISTS idx_tq_updated_at  ON public.tenant_quizzes (updated_at);

ALTER TABLE public.readiness_propagation_events ENABLE ROW LEVEL SECURITY;   -- ops-internal; no client policies
REVOKE ALL ON public.readiness_propagation_events FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- (2) EMIT — O(1) upsert with generation bump + dirty/rerun revival; server-only
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_emit_propagation_event(
  p_tenant uuid, p_event_type text, p_tag_id uuid, p_quiz_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF p_tenant IS NULL OR COALESCE(p_tag_id, p_quiz_id) IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                  WHERE v.tenant_id = p_tenant AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery') THEN
    RETURN;
  END IF;

  INSERT INTO public.readiness_propagation_events (tenant_id, event_type, subject_tag_id, subject_quiz_id)
  VALUES (p_tenant, p_event_type, p_tag_id, p_quiz_id)
  ON CONFLICT (tenant_id, event_type, subject_id) DO UPDATE SET
     generation      = public.readiness_propagation_events.generation + 1,  -- a new change → new generation (dirty)
     status          = 'pending',                                           -- revive from completed/dead_letter/keep pending
     cursor_user_id  = NULL,                                                -- reconsider from the beginning
     attempt_count   = 0,
     next_attempt_at = LEAST(public.readiness_propagation_events.next_attempt_at, now()),
     last_error      = NULL,
     updated_at      = now();
END
$fn$;
REVOKE ALL ON FUNCTION public.readiness_emit_propagation_event(uuid,text,uuid,uuid) FROM PUBLIC, anon, authenticated;

-- ══════════════════════════════════════════════════════════════════════════════
-- (3) DROPPED-EMIT RECONCILIATION — bounded, credential-free, tenant-safe
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_reconcile_catalog(
  p_window interval DEFAULT interval '1 day',
  p_limit  integer  DEFAULT 200,
  p_now    timestamptz DEFAULT now()
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE r record; v_n int := 0; v_lim int := GREATEST(COALESCE(p_limit,200),1);
BEGIN
  -- Tags whose sanctioned change (updated_at) has NO covering propagation event → re-emit (recovers a drop).
  FOR r IN
    SELECT t.tenant_id, t.id AS tag_id
      FROM public.tenant_quiz_tags t
     WHERE t.updated_at > p_now - p_window
       AND EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                    WHERE v.tenant_id=t.tenant_id AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery')
       AND NOT EXISTS (SELECT 1 FROM public.readiness_propagation_events e
                        WHERE e.tenant_id=t.tenant_id AND e.event_type='tag_changed'
                          AND e.subject_id=t.id AND e.updated_at >= t.updated_at)
     ORDER BY t.updated_at
     LIMIT v_lim
  LOOP PERFORM public.readiness_emit_propagation_event(r.tenant_id,'tag_changed',r.tag_id,NULL); v_n := v_n + 1; END LOOP;

  -- Quizzes with a primary tag whose sanctioned change (updated_at) has NO covering event → re-emit.
  FOR r IN
    SELECT q.tenant_id, q.id AS quiz_id
      FROM public.tenant_quizzes q
     WHERE q.primary_readiness_tag_id IS NOT NULL AND q.updated_at > p_now - p_window
       AND EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                    WHERE v.tenant_id=q.tenant_id AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery')
       AND NOT EXISTS (SELECT 1 FROM public.readiness_propagation_events e
                        WHERE e.tenant_id=q.tenant_id AND e.event_type='quiz_primary_changed'
                          AND e.subject_id=q.id AND e.updated_at >= q.updated_at)
     ORDER BY q.updated_at
     LIMIT v_lim
  LOOP PERFORM public.readiness_emit_propagation_event(r.tenant_id,'quiz_primary_changed',NULL,r.quiz_id); v_n := v_n + 1; END LOOP;

  RETURN v_n;
END
$fn$;
REVOKE ALL ON FUNCTION public.readiness_reconcile_catalog(interval,integer,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_reconcile_catalog(interval,integer,timestamptz) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- (4) BOUNDED WORKER — reconcile, then process events with transitive resolution + cursor continuation
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.readiness_process_propagation_batch(
  p_event_limit integer DEFAULT 20,
  p_user_limit  integer DEFAULT 200,
  p_now         timestamptz DEFAULT now(),
  p_reconcile   boolean DEFAULT true
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_ev record; v_uid uuid; v_last uuid; v_cnt int; v_gen bigint;
  v_elim int := GREATEST(COALESCE(p_event_limit,20),1);
  v_ulim int := GREATEST(COALESCE(p_user_limit,200),1);
  v_events int := 0; v_enq int := 0; v_completed int := 0; v_continued int := 0; v_failed int := 0; v_reemitted int := 0;
BEGIN
  IF p_reconcile THEN v_reemitted := public.readiness_reconcile_catalog(interval '1 day', 200, p_now); END IF;

  FOR v_ev IN
    SELECT * FROM public.readiness_propagation_events
     WHERE status='pending' AND next_attempt_at <= p_now
     ORDER BY next_attempt_at
     FOR UPDATE SKIP LOCKED
     LIMIT v_elim
  LOOP
    v_events := v_events + 1;
    v_gen := v_ev.generation;
    UPDATE public.readiness_propagation_events SET status='processing', updated_at=now() WHERE id=v_ev.id;
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM public.readiness_formula_versions v
                      WHERE v.tenant_id=v_ev.tenant_id AND v.status='active' AND v.configuration->>'model'='v2_quiz_mastery') THEN
        UPDATE public.readiness_propagation_events SET status='completed', last_processed_generation=v_gen, processed_at=now(), updated_at=now() WHERE id=v_ev.id;
        v_completed := v_completed + 1; CONTINUE;
      END IF;

      v_cnt := 0; v_last := v_ev.cursor_user_id;

      IF v_ev.event_type = 'tag_changed' THEN
        FOR v_uid IN
          WITH RECURSIVE chain(tag_id, depth) AS (           -- X + all transitive merge predecessors of X (cycle-safe)
            SELECT v_ev.subject_tag_id, 0
            UNION ALL
            SELECT t.id, c.depth+1 FROM public.tenant_quiz_tags t JOIN chain c ON t.merged_into = c.tag_id
             WHERE t.tenant_id = v_ev.tenant_id AND c.depth < 20
          )
          SELECT s.u FROM (
            SELECT DISTINCT a.user_id AS u
              FROM public.quiz_attempt_tags qt
              JOIN public.quiz_attempts a ON a.id = qt.attempt_id AND a.tenant_id = qt.tenant_id
              JOIN public.profiles p ON p.id = a.user_id
             WHERE qt.tenant_id = v_ev.tenant_id AND qt.tag_id IN (SELECT tag_id FROM chain)
               AND a.grading_provenance='server_v2'
               AND p.tenant_id = v_ev.tenant_id AND p.role='user' AND COALESCE(p.status,'active')<>'inactive'
          ) s
          WHERE s.u > COALESCE(v_ev.cursor_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY s.u LIMIT v_ulim
        LOOP
          PERFORM public.enqueue_readiness_recalc(v_ev.tenant_id, v_uid, NULL, 'catalog_change',
                    jsonb_build_object('source','propagation','eventType',v_ev.event_type));
          v_last := v_uid; v_cnt := v_cnt + 1; v_enq := v_enq + 1;
        END LOOP;

      ELSIF v_ev.event_type = 'quiz_primary_changed' THEN
        FOR v_uid IN
          SELECT DISTINCT a.user_id AS u
            FROM public.quiz_attempts a JOIN public.profiles p ON p.id = a.user_id
           WHERE a.tenant_id = v_ev.tenant_id AND a.quiz_id = v_ev.subject_quiz_id AND a.grading_provenance='server_v2'
             AND p.tenant_id = v_ev.tenant_id AND p.role='user' AND COALESCE(p.status,'active')<>'inactive'
             AND a.user_id > COALESCE(v_ev.cursor_user_id, '00000000-0000-0000-0000-000000000000'::uuid)
          ORDER BY a.user_id LIMIT v_ulim
        LOOP
          PERFORM public.enqueue_readiness_recalc(v_ev.tenant_id, v_uid, NULL, 'catalog_change',
                    jsonb_build_object('source','propagation','eventType',v_ev.event_type));
          v_last := v_uid; v_cnt := v_cnt + 1; v_enq := v_enq + 1;
        END LOOP;
      END IF;

      IF v_cnt >= v_ulim THEN
        -- full page — more may remain: continue this generation from the advanced cursor
        UPDATE public.readiness_propagation_events
           SET status='pending', cursor_user_id=v_last, next_attempt_at=now(), updated_at=now() WHERE id=v_ev.id;
        v_continued := v_continued + 1;
      ELSE
        -- exhausted this generation
        UPDATE public.readiness_propagation_events
           SET status='completed', last_processed_generation=v_gen, cursor_user_id=v_last, processed_at=now(), updated_at=now() WHERE id=v_ev.id;
        v_completed := v_completed + 1;
      END IF;
      -- NOTE: an emit arriving while this row is held (FOR UPDATE) blocks, then applies AFTER commit,
      -- setting status='pending', generation+1, cursor=NULL → a complete fresh pass reconsiders everyone.

    EXCEPTION WHEN OTHERS THEN
      UPDATE public.readiness_propagation_events
         SET status = CASE WHEN attempt_count >= 5 THEN 'dead_letter' ELSE 'pending' END,
             attempt_count = attempt_count + 1,
             next_attempt_at = now() + (interval '1 minute' * LEAST(attempt_count+1,5)),
             last_error = left(SQLERRM,300), updated_at = now()
       WHERE id=v_ev.id;
      v_failed := v_failed + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('reemitted',v_reemitted,'events',v_events,'enqueued',v_enq,'completed',v_completed,'continued',v_continued,'failed',v_failed);
END
$fn$;
REVOKE ALL ON FUNCTION public.readiness_process_propagation_batch(integer,integer,timestamptz,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.readiness_process_propagation_batch(integer,integer,timestamptz,boolean) TO service_role;

-- ══════════════════════════════════════════════════════════════════════════════
-- (5) CATALOG TRIGGER — tag archive/restore/merge → outbox (fail-open, O(1))
-- ══════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.tenant_quiz_tags_emit_readiness_propagation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.merged_into IS DISTINCT FROM OLD.merged_into) THEN
    BEGIN
      PERFORM public.readiness_emit_propagation_event(NEW.tenant_id, 'tag_changed', NEW.id, NULL);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'readiness: catalog propagation skipped for a tag change (non-fatal); reconcile will recover';
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
-- (6) REFACTOR 087 primary-tag RPC: emit ONE bounded event (replaces unbounded synchronous fan-out).
--     Also stamps tenant_quizzes.updated_at so a dropped emit is recoverable by reconcile.
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
    UPDATE public.tenant_quizzes SET primary_readiness_tag_id = NULL, updated_at = now() WHERE id = p_quiz_id;
  ELSE
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
    UPDATE public.tenant_quizzes SET primary_readiness_tag_id = v_resolved, updated_at = now() WHERE id = p_quiz_id;
  END IF;

  -- 090: bounded propagation via the outbox (replaces the prior unbounded synchronous all-reps fan-out).
  BEGIN
    PERFORM public.readiness_emit_propagation_event(v_tenant, 'quiz_primary_changed', NULL, p_quiz_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'readiness: catalog propagation skipped for a primary-tag change (non-fatal); reconcile will recover';
  END;

  RETURN jsonb_build_object('quizId', p_quiz_id, 'primaryReadinessTagId', (SELECT primary_readiness_tag_id FROM public.tenant_quizzes WHERE id = p_quiz_id));
END $function$;

-- ══════════════════════════════════════════════════════════════════════════════
-- (7) PROPAGATION WORKER CRON — in-DB, credential-free, uniquely named, idempotent
-- ══════════════════════════════════════════════════════════════════════════════
CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $cron$
DECLARE
  c_job_name text := 'readiness_propagation_worker';
  c_schedule text := '* * * * *';
  c_command  text := 'SELECT public.readiness_process_propagation_batch();';
BEGIN
  PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname = c_job_name;
  PERFORM cron.schedule(c_job_name, c_schedule, c_command);
  RAISE NOTICE '090: scheduled in-DB readiness propagation worker cron % (%) -> %', c_job_name, c_schedule, c_command;
END
$cron$;

-- ── ROLLBACK (complete — restores exact pre-090 087 RPC; see docs/engineering/rollback_090_readiness_catalog_propagation.sql) ──
--   DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_propagation_worker'; END $r$;
--   DROP TRIGGER IF EXISTS trg_tag_readiness_propagation ON public.tenant_quiz_tags;
--   DROP FUNCTION IF EXISTS public.tenant_quiz_tags_emit_readiness_propagation();
--   DROP FUNCTION IF EXISTS public.readiness_process_propagation_batch(integer,integer,timestamptz,boolean);
--   DROP FUNCTION IF EXISTS public.readiness_reconcile_catalog(interval,integer,timestamptz);
--   DROP FUNCTION IF EXISTS public.readiness_emit_propagation_event(uuid,text,uuid,uuid);
--   DROP TABLE IF EXISTS public.readiness_propagation_events;
--   DROP INDEX IF EXISTS public.idx_tqt_updated_at; DROP INDEX IF EXISTS public.idx_tq_updated_at;
--   -- THEN re-create the EXACT pre-090 readiness_set_quiz_primary_tag (inline all-reps fan-out) + grants —
--   -- the full body is in docs/engineering/rollback_090_readiness_catalog_propagation.sql (do not skip).
--   -- 087/088/089 objects and all three other cron jobs are untouched by this rollback.
-- ─────────────────────────────────────────────────────────────────────────────
