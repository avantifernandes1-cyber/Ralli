/**
 * Ralli Member-Lifecycle Service — thin Supabase shell over the pure lifecyclePolicy.
 *
 * The DATABASE is the security authority (readiness_lifecycle_authz gates every RPC). This module only
 * routes the approved calls and normalizes errors; all routing/role/authz decisions live in lifecyclePolicy
 * (pure, unit-tested). Re-exports the policy helpers so callers import from one place.
 *
 * @module lifecycleService
 */

import { supabase } from "./supabase.js";
import { rpcSpec, friendlyError } from "./lifecyclePolicy.js";

export {
  isRalliLevel, assignableRoles, canManageTenant, canTransfer, canActOnMember, friendlyError, rpcSpec,
  reinvitePrefill,
} from "./lifecyclePolicy.js";

async function run(action, params) {
  const { fn, args } = rpcSpec(action, params);
  const { data, error } = await supabase.rpc(fn, args);
  return { data: error ? null : data, error: friendlyError(error) };
}

/** Remove a member from the ENTIRE organization (deactivate + detach; history preserved; reinvitable). */
export const removeFromOrg = (userId) => run("removeFromOrg", { userId });

/** Change a member's role within their tenant (role must be in assignableRoles(operatorRole)). */
export const changeRole = (userId, role) => run("changeRole", { userId, role });

/** Reactivate a DETACHED (removed) member into a tenant with an explicit role (Ralli-admin direct path). */
export const reactivateMember = (userId, tenantId, role) => run("reactivate", { userId, tenantId, role });

/** Transfer a member from their current org to another (Ralli-admin only). */
export const transferMember = (userId, newTenantId, role) => run("transfer", { userId, tenantId: newTenantId, role });

/** Remove a member from a TEAM only (stays in the organization). */
export const removeFromTeam = (userId) => run("removeFromTeam", { userId });

/** Ralli-admin only: list globally detached/removed users (no organization) available to reactivate. */
export async function listDetachedUsers() {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, name, email, role, status")
    .is("tenant_id", null)
    .in("status", ["inactive", "invited"])
    .order("name");
  return { data: error ? null : (data ?? []), error: friendlyError(error) };
}

/**
 * Tenant-scoped Deactivated Users: members previously REMOVED from a specific org, with previous role and
 * removal date. This is the ONLY path an orgAdmin uses — it routes through the authorized SECDEF reader
 * (readiness_list_deactivated_members), which enforces tenant authorization and returns only 'removed'
 * (never 'transferred') members. It NEVER touches the global detached-user query above. Pass null to let the
 * database default to the caller's own tenant.
 */
export async function listDeactivatedMembers(tenantId = null) {
  const { data, error } = await supabase.rpc("readiness_list_deactivated_members", { p_tenant: tenantId });
  // Degrade gracefully if migration 093 is not yet applied to this environment (RPC absent): show an empty
  // list, no error. Once 093 is live the RPC exists and this branch never triggers.
  if (error && (error.code === "PGRST202" || error.code === "42883"
      || /Could not find the function|does not exist/i.test(error.message || ""))) {
    return { data: [], error: null };
  }
  return { data: error ? null : (data ?? []), error: friendlyError(error) };
}
