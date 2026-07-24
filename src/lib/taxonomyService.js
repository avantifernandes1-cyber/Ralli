// ─────────────────────────────────────────────────────────────────────────────
// taxonomyService — thin wrappers over the Quiz Taxonomy backend (migrations
// 058/059). Backend foundation only: NO UI and NO Heatmap aggregation consume
// these yet (that is the Phase-2 manager UX and Phase-3 analytics cutover).
//
// Governance (create/rename/archive/merge) is orgAdmin/ralli_admin-only and
// assignment (setQuizTags) is manager+, enforced server-side in the SECURITY
// DEFINER RPCs — these wrappers never gate; they just surface the RPC result and
// its error. Tenant isolation, case-insensitive dedupe, and immutable
// attempt-time snapshots are all enforced in the database.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "./supabase.js";

// ── Reads (managers/orgAdmin; RLS-gated) ─────────────────────────────────────

// Active + archived tenant tags (managers pick from `active`; archived shown for
// history/merge only). RLS restricts rows to the caller's tenant.
export async function listTenantQuizTags(tenantId, { includeArchived = false } = {}) {
  let q = supabase
    .from("tenant_quiz_tags")
    .select("id, label, normalized_label, status, merged_into, created_at")
    .eq("tenant_id", tenantId)
    .order("label", { ascending: true });
  if (!includeArchived) q = q.eq("status", "active");
  const { data, error } = await q;
  return { data: data ?? [], error };
}

// Current tag ids mapped to a quiz (for the builder's multi-select initial value).
export async function getQuizTagIds(quizId) {
  const { data, error } = await supabase
    .from("quiz_tag_map")
    .select("tag_id")
    .eq("quiz_id", quizId);
  return { data: (data ?? []).map(r => r.tag_id), error };
}

// ── Governance RPCs (orgAdmin / ralli_admin only — server-enforced) ──────────

export async function createQuizTag(label) {
  return supabase.rpc("create_quiz_tag", { p_label: label });
}

export async function renameQuizTag(tagId, label) {
  return supabase.rpc("rename_quiz_tag", { p_tag_id: tagId, p_label: label });
}

export async function archiveQuizTag(tagId) {
  return supabase.rpc("archive_quiz_tag", { p_tag_id: tagId });
}

// Un-archive a plain archived tag by its stable id (labels are globally reserved,
// so reusing an archived concept means restoring it — never minting a duplicate).
// Merged tags cannot be restored (their concept lives in the merge target).
export async function restoreQuizTag(tagId) {
  return supabase.rpc("restore_quiz_tag", { p_tag_id: tagId });
}

// Merge `sourceId` into `targetId`: repoints current mappings and archives the
// source with merged_into=target. Historical attribution is preserved (immutable
// attempt snapshots keep referencing the source and resolve forward).
export async function mergeQuizTags(sourceId, targetId) {
  return supabase.rpc("merge_quiz_tags", { p_source: sourceId, p_target: targetId });
}

// ── Assignment / classification RPC (manager+ — server-enforced) ─────────────

// Replace a quiz's current tag set. Classification is EXPLICIT (never inferred
// from array emptiness):
//   • Classify with tags:          setQuizTags(quiz, [t1,t2], true)
//   • Classify as Uncategorized:   setQuizTags(quiz, [], true)
//   • Update an already-classified quiz (attach/detach, incl. to zero):
//                                  setQuizTags(quiz, [...], false)   (never reverts to awaiting)
//   • Passive/no-op (do NOT finalize an untouched quiz): setQuizTags(quiz, [], false)
// The first classification (tagged or Uncategorized) inherits envelopes to the
// quiz's awaiting attempts once (migration 059). Returns { classification }.
export async function setQuizTags(quizId, tagIds, classify = false) {
  return supabase.rpc("set_quiz_tags", { p_quiz_id: quizId, p_tag_ids: tagIds, p_classify: classify });
}
