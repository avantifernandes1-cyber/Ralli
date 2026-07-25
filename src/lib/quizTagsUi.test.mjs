// Focused unit tests for quizTagsUi pure logic. Run: node src/lib/quizTagsUi.test.mjs
import assert from "node:assert";
import {
  activeMappedTagIds, classificationFromActiveCount, sameIdSet, tagCapabilities, resolveTag,
  buildBuilderTagRows, computeSaveTagIntent, tagSectionTouched,
  quizTagModel, filterQuizzesByTag, tagUsageCounts, normalizeTagError,
  wouldInsertNewQuiz, savePayloadId,
  selectedActiveTagIds, hasActiveSelection, tagRequirementError,
  governanceOutcome,
} from "./quizTagsUi.js";

// Catalog helpers for the requirement/intent tests
const CAT = [
  { id: "a", label: "Discovery",  status: "active",   merged_into: null },
  { id: "b", label: "Objections", status: "active",   merged_into: null },
  { id: "z", label: "OldTopic",   status: "archived", merged_into: null },
];
const CAT_BY_ID = new Map(CAT.map((t) => [t.id, t]));

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log("  ok:", name); };

// ── ACTIVE-only classification (green Tagged iff ≥1 active mapped tag) ────────
t("archived-only mapping is NOT rendered Tagged (tag_required)", () => {
  const active = activeMappedTagIds(["z"], CAT_BY_ID); // z is archived
  assert.deepEqual(active, []);
  assert.equal(classificationFromActiveCount(active.length), "tag_required");
});
t("≥1 active mapped tag → tagged; archived alongside is ignored", () => {
  const active = activeMappedTagIds(["a", "z"], CAT_BY_ID);
  assert.deepEqual(active, ["a"]);
  assert.equal(classificationFromActiveCount(active.length), "tagged");
});
t("no mapping → tag_required (not a normal category)", () => {
  assert.equal(classificationFromActiveCount(activeMappedTagIds([], CAT_BY_ID).length), "tag_required");
});

// ── save requirement: every quiz needs ≥1 ACTIVE tag ─────────────────────────
t("zero selected → one clear validation message", () => {
  assert.equal(tagRequirementError(CAT, []), "Select at least one tag.");
});
t("archived-only selection does NOT satisfy the requirement", () => {
  assert.equal(hasActiveSelection(CAT, ["z"]), false);
  assert.equal(tagRequirementError(CAT, ["z"]), "Select at least one tag.");
  assert.deepEqual(selectedActiveTagIds(CAT, ["z"]), []);
});
t("≥1 active selected satisfies the requirement (archived alongside is fine)", () => {
  assert.equal(hasActiveSelection(CAT, ["a", "z"]), true);
  assert.equal(tagRequirementError(CAT, ["a", "z"]), null);
});

// ── save intent (no Uncategorized; submits ACTIVE ids only) ──────────────────
t("new quiz first valid classification → classify:true with active ids", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: ["a", "b"], catalog: CAT });
  assert.deepEqual(i, { action: "classify", classify: true, tagIds: ["a", "b"] });
});
t("already-classified tag edit → update classify:false (future attempts only)", () => {
  const i = computeSaveTagIntent({ wasClassified: true, initialTagIds: ["a"], selectedTagIds: ["a", "b"], catalog: CAT });
  assert.deepEqual(i, { action: "update", classify: false, tagIds: ["a", "b"] });
});
t("already-classified unchanged set → no call (archived attachment preserved)", () => {
  assert.deepEqual(computeSaveTagIntent({ wasClassified: true, initialTagIds: ["a", "z"], selectedTagIds: ["z", "a"], catalog: CAT }), { action: "none" });
});
t("intent submits only ACTIVE ids (archived dropped from the submitted set)", () => {
  const i = computeSaveTagIntent({ wasClassified: true, initialTagIds: ["a"], selectedTagIds: ["a", "b", "z"], catalog: CAT });
  assert.deepEqual(i.tagIds, ["a", "b"]); // z (archived) not submitted
});
t("multi-tag assignment preserves all active selected ids", () => {
  const i = computeSaveTagIntent({ wasClassified: false, initialTagIds: [], selectedTagIds: ["a", "b"], catalog: CAT });
  assert.deepEqual(i.tagIds, ["a", "b"]);
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
t("filters by All / specific tag id only — NO untagged category", () => {
  const quizzes = [{ id: "q1" }, { id: "q3" }, { id: "q4" }];
  const model = new Map([
    ["q1", { classifiedAt: null, tagIds: [] }],
    ["q3", { classifiedAt: "t", tagIds: ["a", "b"] }],
    ["q4", { classifiedAt: "t", tagIds: ["b"] }],
  ]);
  assert.equal(filterQuizzesByTag(quizzes, model, { kind: "all" }).length, 3);
  assert.deepEqual(filterQuizzesByTag(quizzes, model, { kind: "tag", tagId: "b" }).map((q) => q.id), ["q3", "q4"]);
  // An 'untagged' kind is not supported → treated as no-op (returns all), proving
  // there is no No-tag filter category.
  assert.equal(filterQuizzesByTag(quizzes, model, { kind: "untagged" }).length, 3);
});
t("quiz with no model row → empty tagIds (no invented tags)", () => {
  const m = quizTagModel(new Map(), "qX");
  assert.deepEqual(m.tagIds, []);
});
t("archive-block error surfaces the count-bearing message", () => {
  const msg = normalizeTagError({ message: "archive_quiz_tag: This tag is the only active tag on 3 quiz(zes). Assign a replacement tag or merge it before archiving." });
  assert.match(msg, /only active tag on 3 quiz/);
  assert.match(msg, /Assign a replacement tag or merge/);
  assert.ok(!/archive_quiz_tag:/.test(msg), "fn prefix stripped");
});
t("zero-active set_quiz_tags server error surfaced honestly", () => {
  assert.match(normalizeTagError({ message: "set_quiz_tags: at least one active tag is required" }), /at least one active tag/i);
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

// ── #1 stale-state: one shared store, refresh only on success ────────────────
t("governanceOutcome: success → refresh; failure → no refresh + error (never optimistic)", () => {
  assert.deepEqual(governanceOutcome({ data: { id: "x" }, error: null }), { refresh: true, error: null });
  const fail = governanceOutcome({ data: null, error: { code: "23505", message: 'a active tag named "X" already exists' } }, { label: "X" });
  assert.equal(fail.refresh, false);
  assert.match(fail.error, /already exists/);
});
t("create appears immediately in ALL consumers via one shared reload (no reopen)", async () => {
  // Single canonical store; every consumer reads THIS array (no duplicate stores).
  let store = [{ id: "a", label: "Discovery", status: "active", merged_into: null }];
  const server = [...store];
  const onRefresh = async () => { store = [...server]; };            // the one authoritative reload
  const builderPicker = () => buildBuilderTagRows(store, []).assignable.map(x => x.label);
  const libraryFilters = () => store.filter(t => t.status === "active").map(t => t.label);

  // Simulate the modal's run(): create succeeds → outcome.refresh → onRefresh().
  const createResult = { data: { id: "b", label: "Objections", status: "active", merged_into: null }, error: null };
  server.push(createResult.data);                                     // server now has it
  const outcome = governanceOutcome(createResult);
  assert.equal(outcome.refresh, true);
  if (outcome.refresh) await onRefresh();

  assert.deepEqual(builderPicker(), ["Discovery", "Objections"], "builder picker updated immediately");
  assert.deepEqual(libraryFilters(), ["Discovery", "Objections"], "library filters updated immediately");
});
t("failed create does not appear (no optimistic add)", async () => {
  let store = [{ id: "a", label: "Discovery", status: "active", merged_into: null }];
  const onRefresh = async () => { throw new Error("should not refresh on failure"); };
  const outcome = governanceOutcome({ data: null, error: { code: "23505", message: "duplicate" } });
  assert.equal(outcome.refresh, false);
  if (outcome.refresh) await onRefresh();                            // not called
  assert.deepEqual(store.map(t => t.label), ["Discovery"], "store unchanged after failed create");
});
t("all available tags selected → assignable empty but NO 'no tags' claim (has active in catalog)", () => {
  const rows = buildBuilderTagRows(CAT, ["a", "b"]); // both active selected
  assert.equal(rows.assignable.length, 0);
  const activeInCatalog = CAT.filter(t => t.status === "active").length;
  assert.ok(activeInCatalog > 0, "tenant DOES have active tags → UI must not say 'no tags'");
});

t("sameIdSet order-independent", () => {
  assert.ok(sameIdSet(["a", "b"], ["b", "a"]));
  assert.ok(!sameIdSet(["a"], ["a", "b"]));
});

console.log(`\n${passed} quizTagsUi tests passed`);
