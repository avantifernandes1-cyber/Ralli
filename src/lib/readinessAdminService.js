/**
 * Readiness V2 — manager/admin configuration service (client entry point).
 *
 * Thin wrappers over the server-authoritative SECURITY DEFINER RPCs (migration
 * 087). This module NEVER computes readiness, validity, or coverage on the client
 * — every number, warning, and the setup-complete gate come from the server. It
 * only sends the designation payload and returns the RPC result verbatim.
 *
 * All RPCs enforce manager/orgAdmin (or ralli_admin) authorization server-side;
 * a learner/anon caller receives an error (never a silent empty success). Reads
 * are tenant-scoped by the server. No answer keys or question text are ever
 * returned by these RPCs.
 *
 * Error contract: { data, error } — an RPC error is returned, never swallowed.
 */

import { supabase } from "./supabase.js";

// Every active quiz tag + readiness-support metadata for the Settings surface.
export async function getTagCandidates() {
  const { data, error } = await supabase.rpc("readiness_v2_tag_candidates");
  return { data: data ?? null, error };
}

// Save the DRAFT designation set (does NOT activate). designations:
//   [{ tagId: uuid, required: boolean }, ...]
// threshold: optional 0..100 (defaults server-side to the tenant's current value).
export async function saveDraft(designations, threshold = null) {
  const { data, error } = await supabase.rpc("readiness_v2_save_draft", {
    p_designations: designations, p_threshold: threshold,
  });
  return { data: data ?? null, error };
}

// Validate a version's designation set (setup-complete gate + per-tag issues).
export async function validateConfig(versionId) {
  const { data, error } = await supabase.rpc("readiness_v2_validate", { p_version_id: versionId });
  return { data: data ?? null, error };
}

// Activate a valid draft (draft→active, supersede prior, effective-dated, audited).
// Shadow phase: this does NOT cut the live dashboard over to V2.
export async function activateConfig(versionId) {
  const { data, error } = await supabase.rpc("readiness_v2_activate", { p_version_id: versionId });
  return { data: data ?? null, error };
}

// Authorized internal legacy-vs-V2 comparison report (QA during shadow).
export async function compareLegacyV2(tenantId = null) {
  const { data, error } = await supabase.rpc("readiness_v2_compare", { p_tenant: tenantId });
  return { data: data ?? null, error };
}

// The caller's own readiness result (learner-safe; state + score only if Established).
export async function getMyResult() {
  const { data, error } = await supabase.rpc("readiness_v2_my_result");
  return { data: data ?? null, error };
}
