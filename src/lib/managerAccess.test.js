// Regression tests for the "promote User → Manager → refresh → empty sidebar" bug (Issue 1).
//
// Root cause: when a tenant has saved role_permissions in tenant_settings, App's DB-merge rebuilt
// rolePermissions with ONLY {user, orgAdmin} and DROPPED `manager`. rolePermissions.manager then being
// undefined made perm("features", …) false for every nav item → empty sidebar for a Manager. The role
// change itself (readiness_lifecycle_change_role) is correct and 092 is not involved.
//
// These assert: (a) the permissions model has a complete `manager` profile; (b) hasPermission grants a
// manager the nav features but NOT admin-only settings; (c) loadRolePermissions always includes manager;
// and (d) App's DB role_permissions merge now includes a manager branch (source-level guard so the drop
// can't regress). rankd-app.jsx can't be imported headless, so (d) is a source assertion.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLE_PERMISSIONS, loadRolePermissions, hasPermission } from "./permissions.js";

const NAV_FEATURES = ["home", "games", "learn", "battlecards", "settings"];

test("manager has a complete features profile covering the nav items", () => {
  const m = DEFAULT_ROLE_PERMISSIONS.manager;
  assert.ok(m && m.features && m.actions, "manager role defined");
  for (const f of NAV_FEATURES) assert.equal(m.features[f], true, `manager can see ${f}`);
});

test("hasPermission: a manager sees nav features but NOT admin-only manageSettings", () => {
  const rp = DEFAULT_ROLE_PERMISSIONS;
  for (const f of NAV_FEATURES) {
    assert.equal(hasPermission(rp, "manager", "features", f), true, `manager feature ${f}`);
  }
  assert.equal(hasPermission(rp, "manager", "actions", "manageSettings"), false, "manager cannot manageSettings");
  // Learn authority mirrors orgAdmin (assign/edit), per the backend RLS contract.
  assert.equal(hasPermission(rp, "manager", "actions", "assign"), true, "manager can assign");
});

test("an undefined manager profile yields NO access (reproduces the empty-sidebar cause)", () => {
  const broken = { user: DEFAULT_ROLE_PERMISSIONS.user, orgAdmin: DEFAULT_ROLE_PERMISSIONS.orgAdmin }; // manager dropped
  for (const f of NAV_FEATURES) {
    assert.equal(hasPermission(broken, "manager", "features", f), false, `dropped manager → ${f} hidden`);
  }
});

test("loadRolePermissions always includes a manager profile (defaults or merged)", () => {
  const rp = loadRolePermissions(undefined); // no saved tenant perms → defaults
  assert.ok(rp.manager && rp.manager.features, "loadRolePermissions includes manager");
  for (const f of NAV_FEATURES) assert.equal(rp.manager.features[f], true);
});

test("App DB role_permissions merge includes a manager branch (guards the fix)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../rankd-app.jsx", import.meta.url)), "utf8");
  // Locate the setRolePermissions merge fed by the DB (`db.<role>?.features`).
  const start = src.indexOf("const db = ts.role_permissions;");
  assert.ok(start !== -1, "DB role_permissions merge exists");
  const block = src.slice(start, start + 1200);
  assert.match(block, /manager:\s*\{[\s\S]*DEFAULT_ROLE_PERMISSIONS\.manager\.features[\s\S]*db\.manager\?\.features/,
    "merge rebuilds the manager branch from defaults + db.manager");
  assert.match(block, /DEFAULT_ROLE_PERMISSIONS\.manager\.actions[\s\S]*db\.manager\?\.actions/,
    "merge rebuilds manager actions too");
});

test("a manager is not treated as an admin-type user (no org-admin controls)", () => {
  const src = readFileSync(fileURLToPath(new URL("../../rankd-app.jsx", import.meta.url)), "utf8");
  // isAdminType excludes manager; Settings routes a manager to UserSettingsScreen, not OrgAdminSettingsScreen.
  assert.match(src, /const isAdminType\s*=\s*isSuperAdmin \|\| isOrgAdmin;/, "isAdminType excludes manager");
  assert.match(src, /if \(isOrgAdmin\)\s*return <OrgAdminSettingsScreen/, "org-admin settings gated on isOrgAdmin only");
});
