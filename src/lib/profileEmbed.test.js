// Regression test for the production login incident: the `getProfile` tenants embed.
//
// Migration 093 added `tenant_memberships` (FKs to BOTH profiles and tenants), so PostgREST
// now detects a second (many-to-many) profiles↔tenants relationship. An unqualified
// `tenants(...)` embed became ambiguous (PGRST201 / HTTP 300), which made getProfile fail and
// broke account boot for every authenticated user. The fix names the direct FK
// (`tenants!profiles_tenant_id_fkey`). This test locks that in and guards against a regression
// back to the ambiguous form, and pins the tenant→user-object shape mapping.
//
// The Supabase client can't be imported headless (it needs Vite's import.meta.env), and
// `mock.module` requires a flag `npm test` does not pass — so this asserts on the module source
// (the exact query getProfile sends) plus the pure buildUserObject mapping.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("./profileService.js", import.meta.url)), "utf8");

// Isolate the getProfile function body so assertions can't be satisfied by another function.
function getProfileBody(source) {
  const start = source.indexOf("export async function getProfile(");
  assert.ok(start !== -1, "getProfile function exists");
  const next = source.indexOf("\nexport ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("getProfile embeds tenants via the direct FK profiles_tenant_id_fkey (not the ambiguous bare embed)", () => {
  const body = getProfileBody(src);
  // MUST name the FK to disambiguate the profiles↔tenants relationship introduced by 093.
  assert.match(body, /\.select\(\s*"\*,\s*tenants!profiles_tenant_id_fkey\(id, name, slug, plan\)"\s*\)/,
    "getProfile must select the FK-qualified tenants embed");
  // MUST NOT contain the bare, now-ambiguous embed form (the exact regression that broke login).
  assert.doesNotMatch(body, /tenants\(id, name, slug, plan\)/,
    "getProfile must not use the unqualified tenants(...) embed");
  // The embed still queries the profiles table and returns the normalized object.
  assert.match(body, /\.from\("profiles"\)/, "queries profiles");
  assert.match(body, /return buildUserObject\(data\)/, "returns the normalized user object");
});

test("buildUserObject maps the joined tenant to the same user-object shape (orgId / orgName)", () => {
  // The disambiguation does not change the returned tenant fields (id, name, slug, plan), so the
  // mapping is unchanged. Pin it here so the shape can't silently drift.
  assert.match(src, /orgId:\s*row\.tenant_id\s*\?\?\s*null/, "tenant_id → orgId");
  assert.match(src, /orgName:\s*row\.tenants\?\.name\s*\?\?\s*null/, "joined tenants.name → orgName");
  // The embed selects exactly the fields buildUserObject/consumers rely on.
  const body = getProfileBody(src);
  for (const field of ["id", "name", "slug", "plan"]) {
    assert.ok(body.includes(field), `embed selects tenants.${field}`);
  }
});
