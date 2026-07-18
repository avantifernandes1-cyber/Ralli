-- ============================================================
-- 031_tenant_settings_org_admin_update.sql
-- ============================================================
-- BUG FIX: orgAdmin silently blocked from updating tenant_settings.
--
-- Root cause:
--   004_tenant_provisioning.sql created "tenant_settings_update" allowing
--   only is_ralli_admin(). Two app code paths call direct UPDATE as orgAdmin:
--
--   1. OrgSetupScreen.handleSaveBranding  — writes branding.primaryColor
--   2. OrgSetupScreen.handleSaveFeatures  — writes features (onboarding)
--   3. App.handleSaveRolePermissions       — writes role_permissions (Settings)
--
--   Supabase RLS silently drops UPDATE rows that fail policy, returning no error.
--   All three writes appeared to succeed in the client but persisted nothing.
--
-- Fix: add a second UPDATE policy scoped to the orgAdmin's own tenant.
-- RLS policies on the same table are OR-combined, so ralli_admin keeps working.
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'tenant_settings'
      AND policyname = 'tenant_settings_update_org_admin'
  ) THEN
    CREATE POLICY "tenant_settings_update_org_admin"
      ON tenant_settings
      FOR UPDATE
      TO authenticated
      USING (
        tenant_id = get_my_tenant_id()
        AND get_my_role() = 'orgAdmin'
      )
      WITH CHECK (
        tenant_id = get_my_tenant_id()
        AND get_my_role() = 'orgAdmin'
      );
  END IF;
END $$;
