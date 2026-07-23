-- ─────────────────────────────────────────────────────────────────────────────
-- Readiness versioning — Phase 1 (corrected): hardened enqueue function ONLY.
-- No triggers attached; no worker. Retries ONLY on the expected coalescing
-- index (uq_recalc_live_job); any other unique violation is re-raised. A bounded
-- loop guard prevents any possibility of an infinite loop.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION enqueue_readiness_recalc(
  p_tenant uuid, p_user uuid, p_version uuid, p_reason text, p_source jsonb DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_target     text := COALESCE(p_version::text, 'ACTIVE');
  v_is_rep     boolean;
  v_constraint text;
  v_guard      int := 0;
BEGIN
  IF p_tenant IS NULL OR p_user IS NULL THEN RETURN; END IF;

  -- Population guard: ACTIVE REP of this exact tenant only.
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = p_user AND p.tenant_id = p_tenant
      AND COALESCE(p.status,'active') <> 'inactive'
      AND p.role NOT IN ('orgAdmin','ralli_admin','superadmin')
  ) INTO v_is_rep;
  IF NOT v_is_rep THEN RETURN; END IF;

  LOOP
    v_guard := v_guard + 1;
    IF v_guard > 5 THEN
      RAISE EXCEPTION 'enqueue_readiness_recalc: coalescing did not converge for %/%/%', p_tenant, p_user, v_target;
    END IF;

    UPDATE public.readiness_recalc_queue
       SET reason = p_reason,
           source_ref = COALESCE(p_source, source_ref),
           updated_at = now(),
           rerun_requested = rerun_requested OR (status = 'processing'),
           next_attempt_at = LEAST(next_attempt_at, now())
     WHERE tenant_id = p_tenant AND user_id = p_user AND target_key = v_target
       AND status IN ('pending','processing');
    IF FOUND THEN RETURN; END IF;

    BEGIN
      INSERT INTO public.readiness_recalc_queue (tenant_id, user_id, formula_version_id, reason, source_ref)
      VALUES (p_tenant, p_user, p_version, p_reason, p_source);
      RETURN;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      -- Only the live-job coalescing index is a benign race → retry the UPDATE.
      -- Any other unique violation (e.g. tenant+idempotency_key) is a real error.
      IF v_constraint IS DISTINCT FROM 'uq_recalc_live_job' THEN
        RAISE;
      END IF;
      -- else: loop back and UPDATE the row the concurrent txn inserted.
    END;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION enqueue_readiness_recalc(uuid,uuid,uuid,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION enqueue_readiness_recalc(uuid,uuid,uuid,text,jsonb) FROM anon, authenticated;

-- Deferred (documented, NOT created in Phase 1): AFTER triggers calling this fn,
-- deriving tenant/user from the canonical NEW row, on quiz_attempts,
-- lesson_completions, game_answers, game_sessions(status), tenant_assignments,
-- tenant_quizzes/lessons/courses(status/catalog), profiles(status/role), team
-- membership — see the full coverage list in the design.

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS enqueue_readiness_recalc(uuid,uuid,uuid,text,jsonb);
