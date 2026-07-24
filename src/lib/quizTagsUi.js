// ─────────────────────────────────────────────────────────────────────────────
// quizTagsUi — PURE (no React, no network) logic for the Manager Quiz Tags UI.
//
// The classification model is server-authoritative (migrations 058/059):
//   • awaiting       — tags_classified_at IS NULL (no decision made yet)
//   • tagged         — classified AND ≥1 current tag
//   • uncategorized  — classified AND zero current tags (an intentional choice)
// These helpers only DERIVE display state and decide which setQuizTags call (if
// any) a save should make. They never invent tags and never revert a classified
// quiz to awaiting. All identity is by stable tag id — never display label.
// ─────────────────────────────────────────────────────────────────────────────
import { isRalliAdmin } from "./permissions.js";

export const CLASSIFICATION = {
  awaiting:      { key: "awaiting",      label: "Awaiting classification" },
  tagged:        { key: "tagged",        label: "Tagged" },
  uncategorized: { key: "uncategorized", label: "Uncategorized" },
};

// Derive the classification state from the two server-authoritative signals.
export function deriveClassificationState(tagsClassifiedAt, currentTagIds) {
  if (!tagsClassifiedAt) return "awaiting";
  return (currentTagIds && currentTagIds.length > 0) ? "tagged" : "uncategorized";
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

// Decide the setQuizTags call a save should make — the ONLY place that intent is
// computed. Never classifies an untouched/legacy quiz; never reverts to awaiting.
//   returns { action:'none' } | { action:'classify'|'update', classify, tagIds }
export function computeSaveTagIntent({ wasClassified, initialTagIds = [], selectedTagIds = [], markedUncategorized = false }) {
  if (wasClassified) {
    // Already classified: only tag membership changes; never re-classify, never
    // revert to awaiting. Detaching all tags is a valid (classify:false) update
    // to Uncategorized. No-op when the set is unchanged.
    if (sameIdSet(initialTagIds, selectedTagIds)) return { action: "none" };
    return { action: "update", classify: false, tagIds: [...selectedTagIds] };
  }
  // Not yet classified: the FIRST explicit decision classifies (once).
  if (markedUncategorized) return { action: "classify", classify: true, tagIds: [] };
  if (selectedTagIds.length > 0) return { action: "classify", classify: true, tagIds: [...selectedTagIds] };
  // Untouched, or tags added then all removed without an explicit Uncategorized
  // decision → no call; the quiz stays Awaiting classification.
  return { action: "none" };
}

// Whether the tag section has an actionable, unsaved change (drives "unsaved
// tags" hinting; independent of the quiz-content dirty state).
export function tagSectionTouched({ wasClassified, initialTagIds = [], selectedTagIds = [], markedUncategorized = false }) {
  return computeSaveTagIntent({ wasClassified, initialTagIds, selectedTagIds, markedUncategorized }).action !== "none";
}

// Per-quiz classification/tag model, defaulting a quiz with no row to awaiting
// (existing quizzes are Awaiting until a manager classifies them).
export function quizTagModel(modelByQuiz, quizId) {
  const m = modelByQuiz.get(quizId);
  const classifiedAt = m ? m.classifiedAt : null;
  const tagIds = m ? m.tagIds : [];
  return { classifiedAt, tagIds, state: deriveClassificationState(classifiedAt, tagIds) };
}

// Stable-ID library filtering. filter = {kind:'all'|'awaiting'|'uncategorized'|'tag', tagId?}
export function filterQuizzesByTag(quizzes, modelByQuiz, filter) {
  if (!filter || filter.kind === "all") return quizzes;
  return quizzes.filter((quiz) => {
    const { state, tagIds } = quizTagModel(modelByQuiz, quiz.id);
    if (filter.kind === "awaiting") return state === "awaiting";
    if (filter.kind === "uncategorized") return state === "uncategorized";
    if (filter.kind === "tag") return tagIds.includes(filter.tagId); // stable id, never label
    return true;
  });
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

// Map a Supabase/Postgres RPC error to an honest, actionable message. Never
// swallows an error into a success. Archived-label collisions point to Restore.
export function normalizeTagError(error, context = {}) {
  if (!error) return null;
  const msg = String(error.message || error.msg || "").toLowerCase();
  const code = error.code || error.errorCode;
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
  if (msg.includes("cannot assign tags to an unclassified quiz")) {
    return `Make an explicit classification decision (add a tag or Mark as Uncategorized) first.`;
  }
  // Fall back to the server message (trimmed of the SQL function prefix).
  const raw = String(error.message || "Something went wrong. Please try again.");
  return raw.replace(/^[a-z_]+:\s*/i, "");
}
