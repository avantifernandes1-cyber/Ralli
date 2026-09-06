import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isRalliLevel, assignableRoles, canManageTenant, canTransfer, canActOnMember, rpcSpec, friendlyError,
  reinvitePrefill,
} from "./lifecyclePolicy.js";

// ── role visibility ──────────────────────────────────────────────────────────
test("assignableRoles: orgAdmin may assign only user/manager", () => {
  assert.deepEqual(assignableRoles("orgAdmin"), ["user", "manager"]);
});
test("assignableRoles: Ralli admin may assign user/manager/orgAdmin", () => {
  assert.deepEqual(assignableRoles("ralli_admin"), ["user", "manager", "orgAdmin"]);
  assert.deepEqual(assignableRoles("superadmin"), ["user", "manager", "orgAdmin"]);
});
test("assignableRoles: NEVER exposes ralli_admin or superadmin as assignable", () => {
  for (const r of ["orgAdmin", "ralli_admin", "superadmin", "manager", "user", undefined]) {
    const roles = assignableRoles(r);
    assert.ok(!roles.includes("ralli_admin"), `ralli_admin leaked for ${r}`);
    assert.ok(!roles.includes("superadmin"), `superadmin leaked for ${r}`);
  }
});
test("assignableRoles: non-admins get nothing", () => {
  assert.deepEqual(assignableRoles("manager"), []);
  assert.deepEqual(assignableRoles("user"), []);
  assert.deepEqual(assignableRoles(undefined), []);
});

// ── authorization gating ─────────────────────────────────────────────────────
test("isRalliLevel", () => {
  assert.equal(isRalliLevel("ralli_admin"), true);
  assert.equal(isRalliLevel("superadmin"), true);
  assert.equal(isRalliLevel("orgAdmin"), false);
  assert.equal(isRalliLevel("user"), false);
});
test("canManageTenant: Ralli admin manages any tenant", () => {
  assert.equal(canManageTenant({ role: "ralli_admin", orgId: null }, "T-any"), true);
});
test("canManageTenant: orgAdmin manages only their OWN tenant", () => {
  assert.equal(canManageTenant({ role: "orgAdmin", orgId: "T-A" }, "T-A"), true);
  assert.equal(canManageTenant({ role: "orgAdmin", orgId: "T-A" }, "T-B"), false); // cross-tenant denied
  assert.equal(canManageTenant({ role: "orgAdmin", orgId: null }, "T-A"), false);
});
test("canManageTenant: plain user / null operator cannot manage", () => {
  assert.equal(canManageTenant({ role: "user", orgId: "T-A" }, "T-A"), false);
  assert.equal(canManageTenant(null, "T-A"), false);
});
test("canTransfer: Ralli-admin only", () => {
  assert.equal(canTransfer("ralli_admin"), true);
  assert.equal(canTransfer("superadmin"), true);
  assert.equal(canTransfer("orgAdmin"), false); // transfer is not exposed to org admins
  assert.equal(canTransfer("user"), false);
});
test("canActOnMember: cannot act on self (no self-escalation / self-removal)", () => {
  const op = { id: "u1", role: "orgAdmin", orgId: "T-A" };
  assert.equal(canActOnMember(op, { id: "u1" }), false); // self
  assert.equal(canActOnMember(op, { id: "u2" }), true);
  assert.equal(canActOnMember(null, { id: "u2" }), false);
});

// ── RPC routing (exact fn + args) ────────────────────────────────────────────
test("rpcSpec: removeFromOrg", () => {
  assert.deepEqual(rpcSpec("removeFromOrg", { userId: "u2" }),
    { fn: "readiness_lifecycle_remove_member", args: { p_user: "u2" } });
});
test("rpcSpec: changeRole", () => {
  assert.deepEqual(rpcSpec("changeRole", { userId: "u2", role: "manager" }),
    { fn: "readiness_lifecycle_change_role", args: { p_user: "u2", p_role: "manager" } });
});
test("rpcSpec: reactivate", () => {
  assert.deepEqual(rpcSpec("reactivate", { userId: "u2", tenantId: "T-B", role: "user" }),
    { fn: "readiness_lifecycle_reactivate_member", args: { p_user: "u2", p_tenant: "T-B", p_role: "user" } });
});
test("rpcSpec: transfer", () => {
  assert.deepEqual(rpcSpec("transfer", { userId: "u2", tenantId: "T-B", role: "manager" }),
    { fn: "readiness_lifecycle_transfer_member", args: { p_user: "u2", p_new_tenant: "T-B", p_role: "manager" } });
});
test("rpcSpec: removeFromTeam detaches team only (p_team_id null), never the org RPC", () => {
  const spec = rpcSpec("removeFromTeam", { userId: "u2" });
  assert.equal(spec.fn, "assign_member_team");
  assert.equal(spec.args.p_team_id, null);
  assert.notEqual(spec.fn, "readiness_lifecycle_remove_member"); // team remove ≠ org remove
});
test("rpcSpec: unknown action throws", () => {
  assert.throws(() => rpcSpec("nuke", {}), /unknown action/);
});

// ── reinvite prefill (role stays within the caller's allowed set — #7) ────────
test("reinvitePrefill: keeps the previous role when the operator may assign it", () => {
  assert.deepEqual(reinvitePrefill({ email: "x@e.co", previous_role: "manager" }, "orgAdmin"),
    { email: "x@e.co", role: "manager" });
});
test("reinvitePrefill: clamps a non-assignable previous role to 'user' (orgAdmin cannot assign orgAdmin)", () => {
  assert.deepEqual(reinvitePrefill({ email: "x@e.co", previous_role: "orgAdmin" }, "orgAdmin"),
    { email: "x@e.co", role: "user" });
});
test("reinvitePrefill: NEVER yields a role outside assignableRoles(operator)", () => {
  for (const opRole of ["orgAdmin", "ralli_admin", "superadmin"]) {
    for (const prev of ["user", "manager", "orgAdmin", "ralli_admin", "superadmin", undefined]) {
      const { role } = reinvitePrefill({ email: "e", previous_role: prev }, opRole);
      assert.ok(assignableRoles(opRole).includes(role), `leaked ${role} for op=${opRole} prev=${prev}`);
    }
  }
});
test("reinvitePrefill: a Ralli admin may keep an orgAdmin previous role", () => {
  assert.deepEqual(reinvitePrefill({ email: "x@e.co", previous_role: "orgAdmin" }, "ralli_admin"),
    { email: "x@e.co", role: "orgAdmin" });
});
test("reinvitePrefill: missing member → empty email, safe default role", () => {
  assert.deepEqual(reinvitePrefill(null, "orgAdmin"), { email: "", role: "user" });
});

// ── error surfacing ──────────────────────────────────────────────────────────
test("friendlyError: stale-state 40001 (code or message) → refresh & retry", () => {
  assert.match(friendlyError({ code: "40001", message: "..." }), /refresh and try again/i);
  assert.match(friendlyError({ message: "…(authorization stale); retry" }), /refresh and try again/i);
  assert.match(friendlyError({ message: "locked status inactive is not in the allowed set" }), /refresh and try again/i);
});
test("friendlyError: not authorized (cross-tenant / unauthorized)", () => {
  assert.match(friendlyError({ message: "readiness_lifecycle: not authorized" }), /not authorized/i);
});
test("friendlyError: self-removal", () => {
  assert.match(friendlyError({ message: "remove_member: cannot remove self" }), /can't remove yourself/i);
});
test("friendlyError: detached member", () => {
  assert.match(friendlyError({ message: "transfer_member: member is detached; use reactivate_member" }), /isn't currently in this organization/i);
});
test("friendlyError: null when no error", () => {
  assert.equal(friendlyError(null), null);
  assert.equal(friendlyError(undefined), null);
});
