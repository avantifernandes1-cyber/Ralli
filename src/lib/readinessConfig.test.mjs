import test from "node:test";
import assert from "node:assert/strict";
import {
  MIN_READINESS_TAGS, warningLabel, isValidReadinessTag, deriveSetupState,
  draftDesignationsFrom, isDraftDirty, setupBanner, canAccessReadinessSettings,
} from "./readinessConfig.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Helper to shape a tag-candidate row like the readiness_v2_tag_candidates RPC.
const tag = (o) => ({
  tagId: o.id, label: o.label ?? o.id, status: o.status ?? "active",
  countsTowardReadiness: o.designated ?? false, isRequired: o.required ?? false,
  activeQuizCount: o.quizzes ?? 0, distinctQuestionCount: o.questions ?? 0,
  coverageSufficient: (o.quizzes ?? 0) >= 1 && (o.questions ?? 0) >= 1,
  warnings: o.warnings ?? [],
});

test("isValidReadinessTag: active + coverage required", () => {
  ok("active+coverage → valid", isValidReadinessTag(tag({ id: "T1", designated: true, quizzes: 2, questions: 8 })));
  ok("archived → invalid", !isValidReadinessTag(tag({ id: "T2", status: "archived", quizzes: 2, questions: 8 })));
  ok("no coverage → invalid", !isValidReadinessTag(tag({ id: "T3", quizzes: 0, questions: 0 })));
});

test("deriveSetupState: zero readiness tags → incomplete", () => {
  const s = deriveSetupState({ tags: [tag({ id: "T1", quizzes: 2, questions: 8 })] }); // present but not designated
  ok("not complete", s.setupComplete === false);
  ok("cannot activate", s.canActivate === false);
  ok("valid count 0", s.validCount === 0);
  ok("reason mentions incomplete", /setup incomplete/i.test(s.reason));
});

test("deriveSetupState: one REQUIRED supported tag → complete (required-only rule)", () => {
  const s = deriveSetupState({ tags: [tag({ id: "T1", designated: true, required: true, quizzes: 2, questions: 8 })] });
  ok("one required supported → complete", s.setupComplete === true);
  ok("can activate", s.canActivate === true);
});

test("deriveSetupState: optional-only (no required) → incomplete", () => {
  const s = deriveSetupState({ tags: [
    tag({ id: "T1", designated: true, required: false, quizzes: 2, questions: 8 }),
    tag({ id: "T2", designated: true, required: false, quizzes: 1, questions: 4 }),
  ] });
  ok("not complete without a required area", s.setupComplete === false);
  ok("reason mentions required", /required/i.test(s.reason));
});

test("deriveSetupState: required + optional supported → complete", () => {
  const s = deriveSetupState({ tags: [
    tag({ id: "T1", designated: true, required: true, quizzes: 2, questions: 8 }),
    tag({ id: "T2", designated: true, required: true, quizzes: 1, questions: 4 }),
    tag({ id: "T3", designated: true, required: false, quizzes: 1, questions: 4 }),
  ] });
  ok("complete", s.setupComplete === true);
  ok("no reason", s.reason === null);
});

test("deriveSetupState: required tag unsupported → incomplete even with 2 valid", () => {
  const s = deriveSetupState({ tags: [
    tag({ id: "T1", designated: true, required: false, quizzes: 2, questions: 8 }),
    tag({ id: "T2", designated: true, required: false, quizzes: 1, questions: 4 }),
    tag({ id: "T3", designated: true, required: true, quizzes: 0, questions: 0 }), // required but no coverage
  ] });
  ok("valid still 2", s.validCount === 2);
  ok("required unsupported", s.requiredSupportedCount === 0 && s.requiredCount === 1);
  ok("incomplete", !s.setupComplete);
  ok("reason mentions required", /required/i.test(s.reason));
});

test("deriveSetupState: designated-but-unsupported counted honestly (missing≠valid)", () => {
  const s = deriveSetupState({ tags: [
    tag({ id: "T1", designated: true, quizzes: 2, questions: 8 }),
    tag({ id: "T2", designated: true, quizzes: 1, questions: 4 }),
    tag({ id: "T3", designated: true, quizzes: 0, questions: 0 }),
  ] });
  ok("unsupported designated counted", s.unsupportedDesignatedCount === 1);
  ok("valid excludes unsupported", s.validCount === 2);
});

test("draftDesignationsFrom: only designated rows, carries required flag", () => {
  const rows = [
    tag({ id: "T1", designated: true, required: true }),
    tag({ id: "T2", designated: false, required: true }),
    tag({ id: "T3", designated: true, required: false }),
  ];
  const d = draftDesignationsFrom(rows);
  ok("two designated", d.length === 2);
  ok("T1 required", d.find(x => x.tagId === "T1").required === true);
  ok("T3 optional", d.find(x => x.tagId === "T3").required === false);
  ok("T2 excluded", !d.find(x => x.tagId === "T2"));
});

test("isDraftDirty: detects add/remove/required change; stable when equal", () => {
  const rows = [tag({ id: "T1", designated: true, required: true }), tag({ id: "T2", designated: true, required: false })];
  const saved = [{ tagId: "T2", required: false }, { tagId: "T1", required: true }]; // same set, different order
  ok("equal (order-independent) → not dirty", isDraftDirty(rows, saved) === false);
  ok("required flip → dirty", isDraftDirty(rows, [{ tagId: "T1", required: false }, { tagId: "T2", required: false }]) === true);
  ok("removed tag → dirty", isDraftDirty(rows, [{ tagId: "T1", required: true }]) === true);
  ok("accepts snake_case saved shape", isDraftDirty(rows, [{ tag_id: "T2", is_required: false }, { tag_id: "T1", is_required: true }]) === false);
});

test("warningLabel: known codes mapped, unknown passthrough", () => {
  ok("archived mapped", /archived/i.test(warningLabel("archived_or_merged")));
  ok("no_active_quiz mapped", /no active quiz/i.test(warningLabel("no_active_quiz")));
  ok("unknown passthrough", warningLabel("weird_code") === "weird_code");
});

test("setupBanner: reflects complete/incomplete", () => {
  ok("complete banner", /ready to activate/i.test(setupBanner({ setupComplete: true })));
  ok("incomplete banner uses reason", setupBanner({ setupComplete: false, reason: "X incomplete" }) === "X incomplete");
});

test("canAccessReadinessSettings: manager + orgAdmin + platform admins allowed; learner denied", () => {
  ok("orgAdmin allowed", canAccessReadinessSettings("orgAdmin") === true);
  ok("manager allowed", canAccessReadinessSettings("manager") === true);
  ok("ralli_admin allowed", canAccessReadinessSettings("ralli_admin") === true);
  ok("superadmin allowed", canAccessReadinessSettings("superadmin") === true);
  ok("learner (user) denied", canAccessReadinessSettings("user") === false);
  ok("unknown role denied", canAccessReadinessSettings("guest") === false);
  ok("empty denied", canAccessReadinessSettings("") === false);
  ok("null denied", canAccessReadinessSettings(null) === false);
  ok("undefined denied", canAccessReadinessSettings(undefined) === false);
});

console.log(`readinessConfig.test.mjs: ${passed} assertions passed`);
