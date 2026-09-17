-- ─────────────────────────────────────────────────────────────────────────────
-- SELF-CONTAINED ROLLBACK for migration 090 (readiness catalog/taxonomy propagation).
-- NOT a migration (lives outside supabase/migrations/ so it is never auto-applied).
-- Run once to fully revert 090: drops all 090 objects AND restores the EXACT pre-090
-- readiness_set_quiz_primary_tag (its original inline all-reps synchronous fan-out) with
-- its original SECURITY/grants. Preserves migrations 087/088/089 and all existing cron jobs.
-- Idempotent-ish: safe to re-run (uses IF EXISTS / CREATE OR REPLACE).
-- ─────────────────────────────────────────────────────────────────────────────
BEGIN;

-- (a) remove the 090 cron (only ours)
DO $r$ BEGIN PERFORM cron.unschedule(j.jobid) FROM cron.job j WHERE j.jobname='readiness_propagation_worker'; END $r$;

-- (b) drop 090 objects
DROP TRIGGER IF EXISTS trg_tag_readiness_propagation ON public.tenant_quiz_tags;
DROP FUNCTION IF EXISTS public.tenant_quiz_tags_emit_readiness_propagation();
DROP FUNCTION IF EXISTS public.readiness_process_propagation_batch(integer,integer,timestamptz,boolean);
DROP FUNCTION IF EXISTS public.readiness_reconcile_catalog(interval,integer,timestamptz);
DROP FUNCTION IF EXISTS public.readiness_emit_propagation_event(uuid,text,uuid,uuid);
DROP TABLE IF EXISTS public.readiness_propagation_events;
DROP INDEX IF EXISTS public.idx_tqt_updated_at;
DROP INDEX IF EXISTS public.idx_tq_updated_at;

-- (c) restore the EXACT pre-090 readiness_set_quiz_primary_tag body (verbatim from migration 087),
--     including its inline all-tenant-reps synchronous enqueue fan-out.
CREATE OR REPLACE FUNCTION public.readiness_set_quiz_primary_tag(p_quiz_id uuid, p_tag_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
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

  PERFORM public.enqueue_readiness_recalc(v_tenant, p.id, NULL, 'catalog_change', jsonb_build_object('quizId', p_quiz_id, 'primaryTag', p_tag_id))
  FROM public.profiles p WHERE p.tenant_id = v_tenant AND COALESCE(p.status,'active')<>'inactive' AND p.role='user';

  RETURN jsonb_build_object('quizId', p_quiz_id, 'primaryReadinessTagId', (SELECT primary_readiness_tag_id FROM public.tenant_quizzes WHERE id = p_quiz_id));
END $function$;

-- (d) restore the original 087 grants/security for the RPC
REVOKE ALL ON FUNCTION public.readiness_set_quiz_primary_tag(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.readiness_set_quiz_primary_tag(uuid,uuid) TO authenticated;

COMMIT;
