// Focused unit tests for quizTagsUi pure logic. Run: node src/lib/quizTagsUi.test.mjs
import assert from "node:assert";
import {
  deriveClassificationState, sameIdSet, tagCapabilities, resolveTag,
  buildBuilderTagRows, computeSaveTagIntent, tagSectionTouched,
  quizTagModel, filterQuizzesByTag, tagUsageCounts, normalizeTagError,
  wouldInsertNewQuiz, savePayloadId,
} from "./quizTagsUi.js";

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("  ok:", name); };

// ── classification state derivation ──────────────────────────────────────────
t("legacy quiz (no watermark) is Awaiting", () => {
  assert.equal(deriveClassificationState(null, []), "awaiting");
  assert.equal(deriveClassificationState(null, ["t1"]), "awaiting"); // watermark dominates
});
t("classified with tags is Tagged", () => {
  assert.equal(deriveClassificationState("2026-01-01T00:00:00Z", ["t1"]), "tagged");
});
t("classified with zero tags is Uncategorized", () => {
  assert.equal(deriveClassificationState("2026-01-01T00:00:00Z", []), "uncategorized");
});

// ── save intent: the heart of the classify contract ──────────────────────────
t("untouched legacy quiz → no setQuizTags call (stays Awaiting)", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: [], markedUncategorized: false });
  assert.deepEqual(i, { action: "none" });
  assert.equal(tagSectionTouched({ wasClassified: false, initialTagIds: [], selectedTagIds: [], markedUncategorized: false }), false);
});
t("first tagged classification → classify:true with the selected ids", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: ["a", "b"], markedUncategorized: false });
  assert.deepEqual(i, { action: "classify", classify: true, tagIds: ["a", "b"] });
});
t("first explicit Uncategorized → classify:true with []", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: [], markedUncategorized: true });
  assert.deepEqual(i, { action: "classify", classify: true, tagIds: [] });
});
t("unclassified: tags added then all removed WITHOUT explicit Uncategorized → no call", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: [], markedUncategorized: false });
  assert.equal(i.action, "none"); // never accidentally classify
});
t("already-classified tag edit → update classify:false (future attempts only)", () => {
  const i = computeSaveTagIntent({ wasClassified: true, initialTagIds: ["a"], selectedTagIds: ["a", "b"], markedUncategorized: false });
  assert.deepEqual(i, { action: "update", classify: false, tagIds: ["a", "b"] });
});
t("already-classified unchanged set → no call", () => {
  assert.deepEqual(computeSaveTagIntent({ wasClassified: true, initialTagIds: ["b", "a"], selectedTagIds: ["a", "b"] }), { action: "none" });
});
t("already-classified detach-all → update classify:false [] (Uncategorized, never Awaiting)", () => {
  const i = computeSaveTagIntent({ wasClassified: true, initialTagIds: ["a"], selectedTagIds: [], markedUncategorized: false });
  assert.deepEqual(i, { action: "update", classify: false, tagIds: [] });
});
t("multi-tag assignment preserves all selected ids", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: ["x", "y", "z"], markedUncategorized: false });
  assert.deepEqual(i.tagIds, ["x", "y", "z"]);
});

// ── builder rows: archived visible-but-not-assignable, merged resolves ───────
t("archived selected tag is visible + removable but NOT in assignable list", () => {
  const catalog = [
    { id: "act", label: "Discovery", status: "active", merged_into: null },
    { id: "arc", label: "OldTopic", status: "archived", merged_into: null },
  ];
  const rows = buildBuilderTagRows(catalog, ["arc"]);
  assert.equal(rows.selected[0].archived, true);
  assert.equal(rows.selected[0].removable, true);
  assert.ok(!rows.assignable.find((a) => a.id === "arc"), "archived not assignable");
  assert.ok(rows.assignable.find((a) => a.id === "act"), "active is assignable");
});
t("merged tag resolves to its active target label", () => {
  const byId = new Map([
    ["src", { id: "src", label: "Obj", status: "archived", merged_into: "tgt" }],
    ["tgt", { id: "tgt", label: "Objections", status: "active", merged_into: null }],
  ]);
  assert.equal(resolveTag("src", byId).label, "Objections");
});

// ── capabilities / role behavior ─────────────────────────────────────────────
t("learner sees NO authoring controls", () => {
  const c = tagCapabilities("user");
  assert.deepEqual(c, { isLearner: true, canGovern: false, canAssign: false, canAuthor: false });
});
t("orgAdmin governs + assigns", () => {
  const c = tagCapabilities("orgAdmin");
  assert.equal(c.canGovern, true); assert.equal(c.canAssign, true);
});
t("ralli_admin governs + assigns", () => {
  assert.equal(tagCapabilities("ralli_admin").canGovern, true);
});
t("manager assigns but does NOT govern", () => {
  const c = tagCapabilities("manager");
  assert.equal(c.canAssign, true); assert.equal(c.canGovern, false);
});

// ── stable-id filtering ──────────────────────────────────────────────────────
t("filters by All / Awaiting / Uncategorized / specific tag id", () => {
  const quizzes = [{ id: "q1" }, { id: "q2" }, { id: "q3" }, { id: "q4" }];
  const model = new Map([
    ["q1", { classifiedAt: null, tagIds: [] }],                 // awaiting
    ["q2", { classifiedAt: "t", tagIds: [] }],                  // uncategorized
    ["q3", { classifiedAt: "t", tagIds: ["a", "b"] }],          // tagged a,b
    ["q4", { classifiedAt: "t", tagIds: ["b"] }],               // tagged b
  ]);
  assert.equal(filterQuizzesByTag(quizzes, model, { kind: "all" }).length, 4);
  assert.deepEqual(filterQuizzesByTag(quizzes, model, { kind: "awaiting" }).map((q) => q.id), ["q1"]);
  assert.deepEqual(filterQuizzesByTag(quizzes, model, { kind: "uncategorized" }).map((q) => q.id), ["q2"]);
  assert.deepEqual(filterQuizzesByTag(quizzes, model, { kind: "tag", tagId: "b" }).map((q) => q.id), ["q3", "q4"]);
  assert.deepEqual(filterQuizzesByTag(quizzes, model, { kind: "tag", tagId: "a" }).map((q) => q.id), ["q3"]);
});
t("quiz with no model row defaults to Awaiting (no invented tags)", () => {
  const m = quizTagModel(new Map(), "qX");
  assert.equal(m.state, "awaiting");
  assert.deepEqual(m.tagIds, []);
});
t("usage counts from map rows", () => {
  const c = tagUsageCounts([{ tag_id: "a" }, { tag_id: "a" }, { tag_id: "b" }]);
  assert.equal(c.get("a"), 2); assert.equal(c.get("b"), 1);
});

// ── error normalization (retryable, honest) ──────────────────────────────────
t("duplicate active label error", () => {
  assert.match(normalizeTagError({ code: "23505", message: 'create_quiz_tag: a active tag named "Discovery" already exists' }, { label: "Discovery" }), /already exists/);
});
t("archived label collision points to Restore", () => {
  assert.match(normalizeTagError({ code: "23505", message: 'a archived tag named "X" already exists — restore it instead' }), /Restore it instead/i);
});
t("merged tag cannot be restored", () => {
  assert.match(normalizeTagError({ message: "restore_quiz_tag: a merged tag cannot be restored" }), /merged tag can't be restored/i);
});
t("permission error is honest", () => {
  assert.match(normalizeTagError({ message: "set_quiz_tags: insufficient role to assign quiz tags" }), /permission/i);
});
t("null error → null (no false failure)", () => {
  assert.equal(normalizeTagError(null), null);
});

// ── save-flow: partial failure retry never duplicates the quiz ───────────────
t("new quiz uses a temp id (INSERT) then adopts the canonical UUID (UPDATE on retry)", () => {
  const tempId = String(Date.now());
  assert.equal(wouldInsertNewQuiz(tempId), true, "temp id → INSERT (new)");
  // first save submits the temp id
  assert.equal(savePayloadId({ savedQuizId: null, initialQuizId: null, fallbackId: tempId }), tempId);
  // after phase-1 success the builder adopts the DB UUID
  const canonical = "11111111-2222-3333-4444-555555555555";
  assert.equal(wouldInsertNewQuiz(canonical), false, "canonical UUID → UPDATE (no duplicate)");
  // retry submits the canonical id → UPDATE, not a second INSERT
  assert.equal(savePayloadId({ savedQuizId: canonical, initialQuizId: null, fallbackId: tempId }), canonical);
});
t("editing an existing quiz always UPDATEs (never inserts a duplicate)", () => {
  const existing = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(wouldInsertNewQuiz(existing), false);
  assert.equal(savePayloadId({ savedQuizId: null, initialQuizId: existing, fallbackId: "x" }), existing);
});

t("sameIdSet order-independent", () => {
  assert.ok(sameIdSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameIdSet(["a"], ["a", "b"]));
});

console.log(`\n${passed} quizTagsUi tests passed`);
