-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli: Fix tenants_update_admin RLS policy
-- Run after 027_point_events_idempotency.sql
--
-- Root cause:
--   003_fix_rls.sql recreated "tenants_update_admin" with:
--     USING (get_my_role() = 'ralli_admin')
--   This excludes the legacy 'superadmin' role alias. Any Ralli Admin whose
--   profile row has role = 'superadmin' is silently denied on direct UPDATE
--   to the tenants table, even though RPCs and all other policies accept
--   'superadmin' via is_ralli_admin().
--
-- Fix:
--   Replace with is_ralli_admin() — the same helper used everywhere else in
--   the schema. Covers both 'ralli_admin' and 'superadmin'. Add explicit
--   WITH CHECK for clarity (Postgres uses USING as default, but being
--   explicit prevents future confusion).
--
-- Tenant isolation: unchanged. Only ralli_admin/superadmin can update any
-- tenant row. Org members have no UPDATE policy on tenants and are unaffected.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenants_update_admin" ON tenants;

CREATE POLICY "tenants_update_admin" ON tenants
  FOR UPDATE TO authenticated
  USING     (is_ralli_admin())
  WITH CHECK (is_ralli_admin());
