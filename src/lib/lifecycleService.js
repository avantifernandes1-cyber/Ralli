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
