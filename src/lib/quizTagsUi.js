// ─────────────────────────────────────────────────────────────────────────────
// quizTagsUi — PURE (no React, no network) logic for the Manager Quiz Tags UI.
//
// Product decision: Ralli requires every saved quiz to carry at least one ACTIVE
// tag. There is no "intentionally Uncategorized" state. Display collapses to:
//   • tagged    — has ≥1 current tag
//   • untagged  — has no current tag (legacy/unclassified — "No tag assigned")
// These helpers DERIVE display state and decide which setQuizTags call a save
// makes. They never invent/auto-assign a tag and never revert a classified quiz.
// All identity is by stable tag id — never display label. Backend zero-tag
// historical envelopes (058/059) are untouched; this only governs create/edit.
// ─────────────────────────────────────────────────────────────────────────────
import { isRalliAdmin } from "./permissions.js";

export const CLASSIFICATION = {
  tagged: { key: "tagged", label: "Tagged" },
};

// ACTIVE-only classification. A quiz is "tagged" (green) iff it has ≥1 ACTIVE
// mapped tag. Archived mappings never make a quiz tagged. A quiz with zero
// active mapped tags is an invalid legacy exception ("tag_required") — NOT a
// normal category (there is no "No tag"/Uncategorized product state).
export function activeMappedTagIds(tagIds = [], catalogById) {
  return tagIds.filter((id) => catalogById.get(id)?.status === "active");
}
export function classificationFromActiveCount(activeCount) {
  return activeCount > 0 ? "tagged" : "tag_required";
}

// Order-independent id-set equality (tag identity is the stable id).
export function sameIdSet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

// UI capabilities from the caller's role. Mirrors the DB gates exactly:
//   governance (create/rename/archive/restore/merge) = ralli admin OR orgAdmin
//   assignment (set_quiz_tags)                        = governance OR manager
//   learners ('user' / no role)                       = nothing
export function tagCapabilities(role) {
  const isLearner = !role || role === "user";
  const canGovern = !isLearner && (isRalliAdmin(role) || role === "orgAdmin");
  const canAssign = !isLearner && (canGovern || role === "manager");
  return { isLearner, canGovern, canAssign, canAuthor: canAssign };
}

// Resolve a tag id to its canonical active display, following merged_into once
// (map rows never point at a merged source after a merge, but resolve defensively
// so history/edge data shows the honest active target, never a dangling source).
export function resolveTag(tagId, catalogById) {
  let t = catalogById.get(tagId);
  const seen = new Set();
  while (t && t.merged_into && !seen.has(t.id)) {
    seen.add(t.id);
    const next = catalogById.get(t.merged_into);
    if (!next) break;
    t = next;
  }
  return t || null;
}

// Build the builder's tag rows for a quiz's current selection:
//   selected  — {id,label,status,archived,removable} for each selected id
//   assignable — active, non-merged, not-already-selected tags (newly assignable)
// Archived tags that are already attached stay visible + removable but are NOT
// offered for new assignment.
export function buildBuilderTagRows(catalog, selectedIds) {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  const selected = selectedIds.map((id) => {
    const t = resolveTag(id, byId) || byId.get(id) || null;
    const archived = !t || t.status === "archived";
    return {
      id,
      label: t ? t.label : "(unknown tag)",
      status: t ? t.status : "unknown",
      archived,
      removable: true,
    };
  });
  const selectedSet = new Set(selectedIds);
  const assignable = catalog
    .filter((t) => t.status === "active" && !t.merged_into && !selectedSet.has(t.id))
    .map((t) => ({ id: t.id, label: t.label }));
  return { selected, assignable };
}

// Active subset of a selection (archived attached tags never count toward the
// requirement and are never submitted — set_quiz_tags accepts active ids only).
export function selectedActiveTagIds(catalog, selectedIds = []) {
  const byId = new Map(catalog.map((t) => [t.id, t]));
  return selectedIds.filter((id) => byId.get(id)?.status === "active");
}
export function hasActiveSelection(catalog, selectedIds = []) {
  return selectedActiveTagIds(catalog, selectedIds).length > 0;
}

// The hard save gate: every saved quiz needs ≥1 ACTIVE tag. Returns a message
// string when the requirement is unmet (block save before phase-1), else null.
export function tagRequirementError(catalog, selectedIds = []) {
  return hasActiveSelection(catalog, selectedIds) ? null : "Select at least one tag.";
}

// Decide the setQuizTags call a save should make — the ONLY place intent is
// computed. Submits ACTIVE ids only. First classification of an untagged quiz
// uses classify:true; later changes use classify:false. Never auto-invents tags.
//   returns { action:'none' } | { action:'classify'|'update', classify, tagIds }
export function computeSaveTagIntent({ wasClassified, initialTagIds = [], selectedTagIds = [], catalog = [] }) {
  const submit = selectedActiveTagIds(catalog, selectedTagIds);
  // No change at all (including untouched archived attachments) → no call, so an
  // existing archived association is preserved until the manager changes tags.
  if (sameIdSet(initialTagIds, selectedTagIds)) return { action: "none" };
  if (wasClassified) return { action: "update", classify: false, tagIds: submit };
  // First time this quiz is classified.
  if (submit.length > 0) return { action: "classify", classify: true, tagIds: submit };
  return { action: "none" };
}

// Whether the tag section has an actionable, unsaved change.
export function tagSectionTouched({ wasClassified, initialTagIds = [], selectedTagIds = [], catalog = [] }) {
  return computeSaveTagIntent({ wasClassified, initialTagIds, selectedTagIds, catalog }).action !== "none";
}

// Per-quiz tag model (raw current mappings). Callers derive the active-only
// display via activeMappedTagIds(model.tagIds, catalogById).
export function quizTagModel(modelByQuiz, quizId) {
  const m = modelByQuiz.get(quizId);
  return { classifiedAt: m ? m.classifiedAt : null, tagIds: m ? m.tagIds : [] };
}

// Stable-ID library filtering. filter = {kind:'all'|'tag', tagId?}. There is no
// "No tag"/untagged category — untagged quizzes are invalid exceptions, not a
// filterable product state. Filtering by an active tag id matches mapped quizzes.
export function filterQuizzesByTag(quizzes, modelByQuiz, filter) {
  if (!filter || filter.kind === "all") return quizzes;
  return quizzes.filter((quiz) => {
    const { tagIds } = quizTagModel(modelByQuiz, quiz.id);
    if (filter.kind === "tag") return tagIds.includes(filter.tagId); // stable id, never label
    return true;
  });
}

// ── Quiz-save completion flow (shared, tested) ───────────────────────────────
// One success message, create vs update by whether the editor opened on an
// existing quiz.
export function quizSaveSuccessMessage(existingQuizId) {
  return existingQuizId ? "Quiz updated successfully." : "Quiz created successfully.";
}
// Re-entrancy guard: a second Save while one is in flight is ignored (one save
// sequence per double-click).
export function canBeginSave({ canSave, saving }) {
  return !!canSave && !saving;
}
// Pure model of the two-phase save outcome — mirrors the builder's handleSave so
// the routing rules are unit-testable: navigate + one success ONLY when content
// AND (required) tags both saved; any failure stays in the editor with no
// success and no navigation.
export function saveFlowResult({ contentOk, tagRequired = false, tagFailed = false }) {
  if (!contentOk)              return { success: false, navigate: false, stayInEditor: true, reason: "content_error" };
  if (tagRequired && tagFailed) return { success: false, navigate: false, stayInEditor: true, reason: "tag_error" };
  return { success: true, navigate: true, stayInEditor: false, reason: "ok" };
}

// Mirrors upsertQuiz's new-vs-existing detection: a non-UUID id (temp Date.now(),
// "quiz_*", missing) INSERTs; a UUID UPDATEs. The builder adopts the canonical
// UUID after the first successful save so any retry UPDATEs (never duplicates).
const QUIZ_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function wouldInsertNewQuiz(id) {
  return !id || !QUIZ_UUID_RE.test(String(id));
}
// The id a save should submit: prefer the adopted canonical id so a retry after a
// partial (content-saved, tags-failed) outcome never creates a second quiz.
export function savePayloadId({ savedQuizId, initialQuizId, fallbackId }) {
  return savedQuizId ?? initialQuizId ?? fallbackId;
}

// Usage counts per tag id derived from the quiz→tag map rows (safe: counts only).
export function tagUsageCounts(quizTagMapRows = []) {
  const counts = new Map();
  for (const r of quizTagMapRows) counts.set(r.tag_id, (counts.get(r.tag_id) || 0) + 1);
  return counts;
}

// Outcome of a governance RPC (create/rename/archive/restore/merge): refresh the
// shared catalog ONLY on success (never optimistically show a failed action);
// otherwise surface a normalized, retryable error. Used by the Tag manager so
// every action goes through one refresh path and a failure never appears.
export function governanceOutcome(result, ctx) {
  if (result && result.error) return { refresh: false, error: normalizeTagError(result.error, ctx) };
  return { refresh: true, error: null };
}

// Map a Supabase/Postgres RPC error to an honest, actionable message. Never
// swallows an error into a success. Archived-label collisions point to Restore.
export function normalizeTagError(error, context = {}) {
  if (!error) return null;
  const msg = String(error.message || error.msg || "").toLowerCase();
  const code = error.code || error.errorCode;
  // Merged-tag collision is checked FIRST — a merged tag is archived, but it must
  // point the user to the merge target (it can never be restored/recreated),
  // never to Restore. The server (migration 061) sends the honest, label-bearing
  // sentence; surface it verbatim (minus the SQL function prefix).
  if (msg.includes("was merged into") && msg.includes("cannot be recreated")) {
    return String(error.message).replace(/^[a-z_]+:\s*/i, "");
  }
  const isDup = code === "23505" || msg.includes("already exists") || msg.includes("duplicate");
  if (isDup) {
    if (msg.includes("archived")) {
      return `A tag with this name is archived. Restore it instead of creating a duplicate.`;
    }
    return `A tag named "${context.label ?? "that"}" already exists.`;
  }
  if (code === "23503" || msg.includes("foreign key")) {
    return `That tag is referenced by history and can't be removed. Archive or merge it instead.`;
  }
  if (msg.includes("merged tag cannot be restored")) {
    return `A merged tag can't be restored — its concept now lives in the merge target.`;
  }
  if (msg.includes("must be an active tag") || msg.includes("already-merged")) {
    return `Merge needs two active tags (an archived or already-merged tag can't be a merge target).`;
  }
  if (msg.includes("insufficient role") || msg.includes("only orgadmin") || msg.includes("only ralli")) {
    return `You don't have permission for that action.`;
  }
  if (msg.includes("only active tag on")) {
    // archive_quiz_tag block — keep the count-bearing wording (strip the fn prefix).
    return String(error.message).replace(/^[a-z_]+:\s*/i, "");
  }
  if (msg.includes("at least one active tag is required")) {
    return `Select at least one active tag before saving.`;
  }
  if (msg.includes("cannot assign tags to an unclassified quiz")) {
    return `Add at least one active tag to classify this quiz.`;
  }
  // Fall back to the server message (trimmed of the SQL function prefix).
  const raw = String(error.message || "Something went wrong. Please try again.");
  return raw.replace(/^[a-z_]+:\s*/i, "");
}
