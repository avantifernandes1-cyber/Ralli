import test from "node:test";
import assert from "node:assert/strict";
import { median, computeRecognitions, formatAccuracyPct, partitionIndividuals, partitionTeams } from "./ralliLeaderboardView.js";

const row = (o) => ({ enough_data: true, rank: null, adjusted_accuracy: 0.5, median_norm_speed: null, ...o });

test("median handles odd/even/empty and ignores non-finite", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, NaN, 3]), 2);
});

test("recognitions: <2 eligible → not enough (no badges)", () => {
  const r = computeRecognitions([row({ player_id: "a", rank: 1 })]);
  assert.equal(r.notEnough, true);
  assert.equal(r.mostAccuratePlayerId, null);
  assert.equal(r.fastAndAccurateIds.size, 0);
});

test("Most Accurate = server rank 1 among eligible; raw is irrelevant to selection", () => {
  const rows = [
    row({ player_id: "a", rank: 2, adjusted_accuracy: 0.70 }),
    row({ player_id: "b", rank: 1, adjusted_accuracy: 0.80 }),
  ];
  const r = computeRecognitions(rows);
  assert.equal(r.mostAccuratePlayerId, "b");
});

test("Fast and Accurate: needs adj ≥ eligible median AND valid speed AND speed better than eligible median speed", () => {
  const rows = [
    row({ player_id: "a", rank: 1, adjusted_accuracy: 0.90, median_norm_speed: 0.20 }), // fast + accurate
    row({ player_id: "b", rank: 2, adjusted_accuracy: 0.80, median_norm_speed: 0.60 }), // accurate but slow
    row({ player_id: "c", rank: 3, adjusted_accuracy: 0.40, median_norm_speed: 0.10 }), // fast but not accurate
    row({ player_id: "d", rank: 4, adjusted_accuracy: 0.70, median_norm_speed: null }), // no speed sample
  ];
  const r = computeRecognitions(rows);
  // eligible medians: adj median of [.9,.8,.4,.7] = (.7+.8)/2 = .75 ; speed median of [.2,.6,.1] = .2
  // a: adj .9≥.75 & speed .2<.2? no (strictly less) → NOT fast. Adjust expectation:
  assert.equal(r.fastAndAccurateIds.has("a"), false); // .2 is not < median .2
  assert.equal(r.fastAndAccurateIds.has("b"), false);
  assert.equal(r.fastAndAccurateIds.has("c"), false); // not accurate enough
  assert.equal(r.fastAndAccurateIds.has("d"), false); // no speed
});

test("Fast and Accurate: a clearly fast+accurate learner is recognized", () => {
  const rows = [
    row({ player_id: "a", rank: 1, adjusted_accuracy: 0.90, median_norm_speed: 0.10 }),
    row({ player_id: "b", rank: 2, adjusted_accuracy: 0.85, median_norm_speed: 0.50 }),
    row({ player_id: "c", rank: 3, adjusted_accuracy: 0.80, median_norm_speed: 0.60 }),
  ];
  // adj median = .85 ; speed median = .5 ; a: .9≥.85 & .1<.5 → fast+accurate
  const r = computeRecognitions(rows);
  assert.equal(r.fastAndAccurateIds.has("a"), true);
  assert.equal(r.fastAndAccurateIds.has("b"), false); // .5 not < .5
  assert.equal(r.mostAccuratePlayerId, "a");
});

test("ineligible rows never receive recognitions", () => {
  const rows = [
    row({ player_id: "a", rank: 1, adjusted_accuracy: 0.90, median_norm_speed: 0.10 }),
    row({ player_id: "b", rank: 2, adjusted_accuracy: 0.85, median_norm_speed: 0.50 }),
    row({ player_id: "x", enough_data: false, adjusted_accuracy: 0.99, median_norm_speed: 0.01 }),
  ];
  const r = computeRecognitions(rows);
  assert.equal(r.fastAndAccurateIds.has("x"), false);
  assert.notEqual(r.mostAccuratePlayerId, "x");
});

test("formatAccuracyPct", () => {
  assert.equal(formatAccuracyPct(0.8571), "85.7%");
  assert.equal(formatAccuracyPct(1), "100.0%");
  assert.equal(formatAccuracyPct(null), "—");
});

test("partitionIndividuals splits ranked vs not-enough and orders ranked by rank", () => {
  const rows = [
    row({ player_id: "a", rank: 2 }),
    row({ player_id: "b", rank: 1 }),
    row({ player_id: "c", enough_data: false, rank: null }),
  ];
  const { ranked, pending } = partitionIndividuals(rows);
  assert.deepEqual(ranked.map((r) => r.player_id), ["b", "a"]);
  assert.deepEqual(pending.map((r) => r.player_id), ["c"]);
});

test("partitionTeams splits ranked vs not-enough", () => {
  const rows = [
    { team_id: "t1", enough_data: true, rank: 1 },
    { team_id: "t2", enough_data: false, rank: null },
  ];
  const { ranked, pending } = partitionTeams(rows);
  assert.equal(ranked.length, 1);
  assert.equal(pending.length, 1);
});
