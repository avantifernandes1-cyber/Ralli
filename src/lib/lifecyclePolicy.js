/**
 * Ralli Member-Lifecycle POLICY — pure, dependency-free helpers (no Supabase import).
 *
 * These encode the UI's authorization/role-visibility rules and the exact RPC routing for the live
 * migration-091 lifecycle RPCs. They mirror the backend contract and NEVER widen it — the database
 * (readiness_lifecycle_authz) remains the security authority. Kept import-free so they run under
 * `node --test` without Vite's import.meta.env.
 *
 * @module lifecyclePolicy
 */

export function isRalliLevel(operatorRole) {
  return operatorRole === "ralli_admin" || operatorRole === "superadmin";
}

/**
 * Roles this operator may ASSIGN. Product decision: orgAdmin → {user, manager}; Ralli → {user, manager, orgAdmin}.
 * `ralli_admin` / `superadmin` are NEVER assignable through the lifecycle RPCs.
 */
export function assignableRoles(operatorRole) {
  if (isRalliLevel(operatorRole)) return ["user", "manager", "orgAdmin"];
  if (operatorRole === "orgAdmin") return ["user", "manager"];
  return [];
}

/** Whether the operator may manage members of `targetTenantId` (mirrors readiness_lifecycle_authz). */
export function canManageTenant(operator, targetTenantId) {
  if (!operator) return false;
  if (isRalliLevel(operator.role)) return true;
  return operator.role === "orgAdmin" && !!operator.orgId && operator.orgId === targetTenantId;
}

/** Transfer needs authorization over BOTH tenants ⇒ Ralli-admin only. */
export function canTransfer(operatorRole) {
  return isRalliLevel(operatorRole);
}

/** May the operator act on this specific member row? (no self-removal / no self-role-change). */
export function canActOnMember(operator, member) {
  if (!operator || !member) return false;
  return operator.id !== member.id;
}

/**
 * PURE RPC routing: given a UI action + params, return the exact { fn, args } to send to supabase.rpc.
 * Centralizing this makes routing unit-testable without a live client.
 */
export function rpcSpec(action, params = {}) {
  switch (action) {
    case "removeFromOrg":
      return { fn: "readiness_lifecycle_remove_member", args: { p_user: params.userId } };
    case "changeRole":
      return { fn: "readiness_lifecycle_change_role", args: { p_user: params.userId, p_role: params.role } };
    case "reactivate":
      return { fn: "readiness_lifecycle_reactivate_member", args: { p_user: params.userId, p_tenant: params.tenantId, p_role: params.role } };
    case "transfer":
      return { fn: "readiness_lifecycle_transfer_member", args: { p_user: params.userId, p_new_tenant: params.tenantId, p_role: params.role } };
    case "removeFromTeam":
      return { fn: "assign_member_team", args: { p_user_id: params.userId, p_team_id: null } };
    default:
      throw new Error(`lifecyclePolicy.rpcSpec: unknown action "${action}"`);
  }
}

/**
 * Reinvite prefill for a deactivated member. Returns the email to invite and a role that is ALWAYS within
 * the operator's assignable set (#7): the member's previous role if the operator may assign it, else 'user'
 * (or the first allowed role). The invite form's role picker must likewise use assignableRoles(operatorRole)
 * — the record's previous_role never widens what the caller can assign.
 */
export function reinvitePrefill(member, operatorRole) {
  const allowed = assignableRoles(operatorRole);
  const prev = member && member.previous_role;
  const role = allowed.includes(prev)
    ? prev
    : (allowed.includes("user") ? "user" : (allowed[0] || "user"));
  return { email: (member && member.email) || "", role };
}

/** Map a Postgres/PostgREST RPC error to a short, honest, user-facing message (or null when there's none). */
export function friendlyError(error) {
  if (!error) return null;
  const code = error.code || "";
  const msg = String(error.message || "");
  if (code === "40001" || /changed concurrently|authorization stale|not in the allowed set|expected (status|role|tenant)/i.test(msg)) {
    return "This member changed since the page loaded — refresh and try again.";
  }
  if (/not authorized/i.test(msg)) return "You're not authorized to perform this action.";
  if (/cannot remove self/i.test(msg)) return "You can't remove yourself.";
  if (/already detached|member is detached|has no tenant/i.test(msg)) return "This member isn't currently in this organization.";
  if (/illegal role|allowed set/i.test(msg)) return "That role can't be assigned here.";
  return msg || "The action failed. Please try again.";
}
