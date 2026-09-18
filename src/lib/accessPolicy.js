/**
 * Account access policy — pure, dependency-free (safe under `node --test`).
 *
 * Fail-closed gate deciding whether an authenticated account may ENTER the app after its profile is
 * fetched at login or session restore. A deactivated (removed) account keeps a profile row but with
 * status != 'active' (removal sets status='inactive', tenant_id=NULL), so it must be blocked from the app
 * entirely — not dropped into a tenant-less shell.
 *
 * Distinguishing the account states (all decided from the fetched profile; never widens RLS):
 *   - active + tenant                       → normal member/orgAdmin        → ALLOW
 *   - active + no tenant + ralli_admin/superadmin → platform admin          → ALLOW (admin console)
 *   - active + no tenant + user/manager     → NEW user awaiting invitation  → ALLOW (tenant-less shell)
 *   - inactive / suspended / invited (any)  → deactivated / not-yet-active  → BLOCK
 *
 * Only status === 'active' may enter. This keeps every legitimate tenant-less flow (new signup awaiting an
 * invite, Ralli admins, in-flight transfers which end 'active') working, while blocking removed accounts.
 * `no-profile` is NOT a block — the caller may still create one via ensure_self_profile (new signup).
 */

export const DEACTIVATED_MESSAGE =
  "Your account has been deactivated. Contact your organization administrator or accept a new invitation to regain access.";

/**
 * @param {{status?: string}|null|undefined} profile - normalized user object or raw profile row
 * @returns {{ allow: boolean, blocked: boolean, reason: 'active'|'deactivated'|'no-profile' }}
 */
export function evaluateAccountAccess(profile) {
  if (!profile) return { allow: false, blocked: false, reason: "no-profile" };
  const status = profile.status ?? "active";
  if (status === "active") return { allow: true, blocked: false, reason: "active" };
  // Any non-active status (inactive / suspended / invited) is fail-closed: no app access.
  return { allow: false, blocked: true, reason: "deactivated" };
}

/** Convenience predicate: may this fetched profile enter the app? */
export function isAccountActive(profile) {
  return evaluateAccountAccess(profile).allow;
}
