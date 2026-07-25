-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 061 — Honest merged-tag collision messages (error handling ONLY)
--
-- create_quiz_tag / rename_quiz_tag reserve a normalized label across ALL statuses
-- (unchanged), but their collision error was misleading: a MERGED tag (archived +
-- merged_into set) was reported as "archived — restore it", even though merged
-- tags intentionally cannot be restored or recreated. This migration replaces
-- ONLY the collision error handling so the server response is honest per kind:
--   • active   → "A tag named "X" already exists."
--   • archived → "A tag with this name is archived. Restore it instead of creating a duplicate."
--   • merged   → "<Source> was merged into <Target> and cannot be recreated. Use <Target> instead."
--
-- NO data changes, NO RLS changes, NO taxonomy behavior changes: the reservation
-- (reject on any collision), the insert/update, returns, grants, roles and
-- search_path='' are all identical to migration 058. Does NOT edit 058.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.create_quiz_tag(p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_norm text; v_id uuid;
        v_existing_status text; v_existing_merged uuid; v_existing_label text; v_target_label text;
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
  -- Reserved across ALL statuses (unchanged). Honest message per collision kind.
  SELECT status, merged_into, label INTO v_existing_status, v_existing_merged, v_existing_label
    FROM public.tenant_quiz_tags WHERE tenant_id = v_tenant AND normalized_label = v_norm;
  IF v_existing_status IS NOT NULL THEN
    IF v_existing_merged IS NOT NULL THEN
      SELECT label INTO v_target_label FROM public.tenant_quiz_tags WHERE id = v_existing_merged;
      RAISE EXCEPTION 'create_quiz_tag: % was merged into % and cannot be recreated. Use % instead.',
        v_existing_label, v_target_label, v_target_label USING ERRCODE = 'unique_violation';
    ELSIF v_existing_status = 'archived' THEN
      RAISE EXCEPTION 'create_quiz_tag: A tag with this name is archived. Restore it instead of creating a duplicate.'
        USING ERRCODE = 'unique_violation';
    ELSE
      RAISE EXCEPTION 'create_quiz_tag: A tag named "%" already exists.', btrim(p_label)
        USING ERRCODE = 'unique_violation';
    END IF;
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

CREATE OR REPLACE FUNCTION public.rename_quiz_tag(p_tag_id uuid, p_label text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE v_uid uuid := auth.uid(); v_role text; v_tenant uuid; v_tag_tenant uuid; v_norm text;
        v_c_status text; v_c_merged uuid; v_c_label text; v_target_label text;
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
  -- Reserved across ALL statuses (unchanged). Honest message per collision kind.
  SELECT status, merged_into, label INTO v_c_status, v_c_merged, v_c_label
    FROM public.tenant_quiz_tags
    WHERE tenant_id = v_tag_tenant AND normalized_label = v_norm AND id <> p_tag_id;
  IF v_c_status IS NOT NULL THEN
    IF v_c_merged IS NOT NULL THEN
      SELECT label INTO v_target_label FROM public.tenant_quiz_tags WHERE id = v_c_merged;
      RAISE EXCEPTION 'rename_quiz_tag: % was merged into % and cannot be recreated. Use % instead.',
        v_c_label, v_target_label, v_target_label USING ERRCODE = 'unique_violation';
    ELSIF v_c_status = 'archived' THEN
      RAISE EXCEPTION 'rename_quiz_tag: A tag with this name is archived. Restore it instead of creating a duplicate.'
        USING ERRCODE = 'unique_violation';
    ELSE
      RAISE EXCEPTION 'rename_quiz_tag: A tag named "%" already exists.', btrim(p_label)
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  UPDATE public.tenant_quiz_tags SET label = btrim(p_label), updated_at = now() WHERE id = p_tag_id;
  RETURN (SELECT jsonb_build_object('id', t.id, 'label', t.label,
                                    'normalized_label', t.normalized_label, 'status', t.status)
          FROM public.tenant_quiz_tags t WHERE t.id = p_tag_id);
END $$;
REVOKE ALL ON FUNCTION public.rename_quiz_tag(uuid, text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rename_quiz_tag(uuid, text) TO authenticated;

-- ── ROLLBACK ──────────────────────────────────────────────────────────────────
-- Restore the 058 create_quiz_tag / rename_quiz_tag bodies (only the collision
-- error text differs). No data/RLS/behavior to reverse. Never weaken 056/057.
