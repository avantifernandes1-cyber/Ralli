// Tests for the fail-closed account-access policy (Issue 1: deactivated accounts must not enter the app).

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateAccountAccess, isAccountActive, DEACTIVATED_MESSAGE } from "./accessPolicy.js";

test("deactivated (removed) account is BLOCKED", () => {
  // removal sets status='inactive', tenant_id=NULL
  const r = evaluateAccountAccess({ status: "inactive", orgId: null, role: "user" });
  assert.equal(r.allow, false);
  assert.equal(r.blocked, true);
  assert.equal(r.reason, "deactivated");
});

test("suspended and invited statuses are BLOCKED (fail-closed on any non-active)", () => {
  for (const status of ["suspended", "invited"]) {
    const r = evaluateAccountAccess({ status });
    assert.equal(r.blocked, true, `${status} must be blocked`);
    assert.equal(r.allow, false);
  }
});

test("active member with a tenant is ALLOWED", () => {
  const r = evaluateAccountAccess({ status: "active", orgId: "T-A", role: "user" });
  assert.equal(r.allow, true);
  assert.equal(r.blocked, false);
});

test("NEW user awaiting an invitation (active, no tenant) is ALLOWED — not blocked", () => {
  const r = evaluateAccountAccess({ status: "active", orgId: null, role: "user" });
  assert.equal(r.allow, true);
  assert.equal(r.blocked, false);
});

test("Ralli admin (active, tenant-less) is ALLOWED", () => {
  const r = evaluateAccountAccess({ status: "active", orgId: null, role: "ralli_admin" });
  assert.equal(r.allow, true);
});

test("a just-transferred/reactivated account ends 'active' → ALLOWED", () => {
  assert.equal(isAccountActive({ status: "active", orgId: "T-B", role: "manager" }), true);
});

test("missing profile is NOT a block (caller may create it via ensure_self_profile)", () => {
  const r = evaluateAccountAccess(null);
  assert.equal(r.blocked, false);
  assert.equal(r.allow, false);
  assert.equal(r.reason, "no-profile");
});

test("status defaults to active when absent (normalized objects always carry status)", () => {
  assert.equal(isAccountActive({ orgId: "T-A" }), true);
});

test("deactivation message is customer-safe (no codes/table names)", () => {
  assert.match(DEACTIVATED_MESSAGE, /deactivated/i);
  assert.doesNotMatch(DEACTIVATED_MESSAGE, /profiles|tenant_id|RLS|null|status/i);
});
