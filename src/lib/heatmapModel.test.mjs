import test from "node:test";
import assert from "node:assert/strict";
import {
  shapeHeatmap, hasVerifiedEvidence, cellScore, cellEntry,
  repTopicsFromHeatmap, ownTopicsFromHeatmap, coverageLine, thresholdNote,
} from "./heatmapModel.js";

let passed = 0;
const ok = (name, cond) => { assert.ok(cond, name); passed++; };

// Manager-shaped RPC payload mirroring the 062 SQL fixture (TA, threshold 70):
//  Discovery(A): L1=90 n2, L2=50 n1  · Pricing(B): L1=40  · Objection(C): L1=100
const RPC = {
  topics: [
    { tagId: "B", label: "Pricing",   avgScore: 40,  measuredLearners: 1, learnersNoData: 2, repsBelow: 1, repsAbove: 0,
      repScores: [{ userId: "L1", score: 40, n: 1, passed: 0 }] },
    { tagId: "A", label: "Discovery", avgScore: 70,  measuredLearners: 2, learnersNoData: 1, repsBelow: 1, repsAbove: 1,
      repScores: [{ userId: "L2", score: 50, n: 1, passed: 0 }, { userId: "L1", score: 90, n: 2, passed: 2 }] },
    { tagId: "C", label: "Objection", avgScore: 100, measuredLearners: 1, learnersNoData: 2, repsBelow: 0, repsAbove: 1,
      repScores: [{ userId: "L1", score: 100, n: 1, passed: 1 }] },
    // No-verified-evidence active topic: null score, empty repScores.
    { tagId: "D", label: "Retention", avgScore: null, measuredLearners: 0, learnersNoData: 3, repsBelow: 0, repsAbove: 0,
      repScores: [] },
  ],
  learners: [{ userId: "L1", name: "L1" }, { userId: "L2", name: "L2" }, { userId: "L4", name: "L4" }],
  meta: { tenantId: "TA", totalActiveLearners: 3, measuredLearners: 2, totalAttempts: 7,
          verifiedAttributed: 5, legacyExcluded: 1, awaitingClassification: 1,
          threshold: 70, thresholdSource: "tenant_settings" },
};

test("heatmapModel", () => {
  const s = shapeHeatmap(RPC);

  // shapeHeatmap keeps tagId identity and mirrors label into `topic`
  ok("topic count", s.topics.length === 4);
  const A = s.topics.find(t => t.tagId === "A");
  ok("A topic mirrors label", A.topic === "Discovery" && A.label === "Discovery");
  ok("A avg", A.avgScore === 70);
  ok("meta threshold + source", s.meta.threshold === 70 && s.meta.thresholdSource === "tenant_settings");
  ok("meta coverage numbers", s.meta.verifiedAttributed === 5 && s.meta.legacyExcluded === 1 && s.meta.awaitingClassification === 1);

  // No-data topic: avgScore stays null (never coerced to 0), empty repScores.
  const D = s.topics.find(t => t.tagId === "D");
  ok("no-data topic avgScore null", D.avgScore === null);
  ok("no-data topic measured 0 + empty repScores", D.measuredLearners === 0 && D.repScores.length === 0);

  // learners carry a truthful name from the RPC (incl. the no-data learner L4)
  ok("learner L4 present with name", s.learners.find(l => l.userId === "L4")?.name === "L4");

  // hasVerifiedEvidence keys on meta, not topic presence (no-data topics exist)
  ok("has evidence true", hasVerifiedEvidence(s) === true);
  ok("no evidence when verified=0 even if topics exist",
     hasVerifiedEvidence(shapeHeatmap({ topics: [D], learners: [{ userId: "L1", name: "x" }], meta: { verifiedAttributed: 0 } })) === false);

  // cellScore: present → number; absent → null (renders — never 0)
  ok("cell L1/A = 90", cellScore(A, "L1") === 90);
  ok("cell L2/A = 50", cellScore(A, "L2") === 50);
  ok("cell missing → null", cellScore(A, "GHOST") === null);
  const B = s.topics.find(t => t.tagId === "B");
  ok("cell L2/B missing → null (not 0)", cellScore(B, "L2") === null);
  ok("no-data cell → null", cellScore(D, "L1") === null);
  ok("cellEntry has n", cellEntry(A, "L1").n === 2);

  // rep drill-down for L1 (manager matrix → one rep), sorted weakest-first
  const l1 = repTopicsFromHeatmap(s, "L1");
  ok("L1 rep topics count", l1.length === 3);
  ok("L1 rep sorted weakest-first", l1[0].topic === "Pricing" && l1[2].topic === "Objection");
  const l1A = l1.find(t => t.tagId === "A");
  ok("L1/A cell score 90 n2 (attempt-time, not current map)", l1A.avgScore === 90 && l1A.attempts === 2);

  // rep drill-down for L2 → only Discovery (its only data), score 50
  const l2 = repTopicsFromHeatmap(s, "L2");
  ok("L2 rep only Discovery", l2.length === 1 && l2[0].tagId === "A" && l2[0].avgScore === 50);

  // a learner with no verified data → empty rep topics (column still exists elsewhere)
  ok("ghost rep empty", repTopicsFromHeatmap(s, "GHOST").length === 0);

  // learner scope: single-learner payload → own topics
  const ownRpc = {
    topics: [
      { tagId: "A", label: "Discovery", avgScore: 90, repScores: [{ userId: "L1", score: 90, n: 2, passed: 2 }] },
      { tagId: "B", label: "Pricing",   avgScore: 40, repScores: [{ userId: "L1", score: 40, n: 1, passed: 0 }] },
      // relevant-to-learner but no verified evidence → must be skipped in the card
      { tagId: "E", label: "Legacyish", avgScore: null, repScores: [] },
    ],
    learners: [{ userId: "L1", name: "L1" }],
    meta: { threshold: 70, thresholdSource: "tenant_settings", verifiedAttributed: 4 },
  };
  const own = ownTopicsFromHeatmap(shapeHeatmap(ownRpc));
  ok("own skips no-verified-evidence topic", own.length === 2 && !own.find(t => t.tagId === "E"));
  ok("own topics sorted weakest-first", own[0].topic === "Pricing" && own[1].topic === "Discovery");
  ok("own Discovery avg 90 n2 (parity with manager cell)", own.find(t => t.tagId === "A").avgScore === 90 && own.find(t => t.tagId === "A").attempts === 2);

  // coverage line — live values, correct pluralization
  ok("coverage line", coverageLine(s.meta) === "5 verified attempts included · 1 legacy attempt excluded · 1 awaiting classification");
  ok("coverage singular verified", coverageLine({ verifiedAttributed: 1, legacyExcluded: 0, awaitingClassification: 0 }) === "1 verified attempt included · 0 legacy attempts excluded · 0 awaiting classification");

  // threshold note is explicit about source
  ok("threshold note tenant", thresholdNote(s.meta) === "Threshold 70% (tenant setting)");
  ok("threshold note default", thresholdNote({ threshold: 80, thresholdSource: "default" }) === "Threshold 80% (default)");

  // robustness: junk input never throws, yields empty shape
  const empty = shapeHeatmap(null);
  ok("null rpc → empty", empty.topics.length === 0 && empty.learners.length === 0 && empty.meta.thresholdSource === "default");
});

test("summary", () => { console.log(`\n${passed} heatmapModel assertions passed`); });
