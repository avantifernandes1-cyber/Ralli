-- Migration 026: tenant_assignments — add UPDATE RLS policy
--
-- The original migration (017) only created SELECT, INSERT, and DELETE policies.
-- No UPDATE policy exists, so assignments cannot be edited (due date, required
-- flag, etc.) — only deleted and recreated. This migration adds the UPDATE
-- policy consistent with the existing INSERT/DELETE access model.
--
-- Note: duplicate prevention is handled at the application layer in
-- createAssignment (contentService.js) via a pre-insert dedup query using
-- JSONB path filtering on assigned_to. A DB-level UNIQUE constraint on
-- (tenant_id, content_type, content_id, assigned_to) is not feasible because
-- Postgres does not support UNIQUE on JSONB columns directly.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tenant_assignments'
      AND policyname = 'tenant_assignments_update'
  ) THEN
    CREATE POLICY "tenant_assignments_update"
      ON public.tenant_assignments FOR UPDATE TO authenticated
      USING (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      )
      WITH CHECK (
        get_my_role() IN ('ralli_admin', 'orgAdmin', 'manager')
        AND (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id())
      );
  END IF;
END $$;
