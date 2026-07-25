/**
 * Knowledge Heatmap — pure shaping helpers over the canonical
 * get_knowledge_heatmap() RPC (migration 062).
 *
 * There is exactly ONE aggregation source: the RPC. These helpers only reshape
 * its output for the manager matrix, the learner "Knowledge by Topic" list, and
 * the manager rep drill-down — they never re-aggregate scores from raw attempts
 * or the mutable quiz_tag_map. Stable `tagId` is the identity for keys/filtering;
 * `label` is display-only. No thresholds are invented here — the RPC returns the
 * threshold and its source.
 */

// Normalize the raw RPC payload into a stable, defaulted shape.
export function shapeHeatmap(rpc) {
  const topics = Array.isArray(rpc?.topics) ? rpc.topics : [];
  const learners = Array.isArray(rpc?.learners) ? rpc.learners : [];
  const meta = rpc?.meta ?? {};
  return {
    topics: topics.map(t => ({
      tagId:            t.tagId,
      // `topic` mirrors `label` so existing render code keyed on `.topic` keeps
      // working, but identity/keys must use `tagId`.
      topic:            t.label,
      label:            t.label,
      avgScore:         numOrNull(t.avgScore),
      measuredLearners: int0(t.measuredLearners),
      learnersNoData:   int0(t.learnersNoData),
      repsBelow:        int0(t.repsBelow),
      repsAbove:        int0(t.repsAbove),
      repScores:        (Array.isArray(t.repScores) ? t.repScores : []).map(r => ({
        userId: r.userId,
        score:  numOrNull(r.score),
        n:      int0(r.n),
        passed: int0(r.passed),
      })),
    })),
    learners: learners.map(l => ({ userId: l.userId })),
    meta: {
      totalActiveLearners:    int0(meta.totalActiveLearners),
      measuredLearners:       int0(meta.measuredLearners),
      totalAttempts:          int0(meta.totalAttempts),
      verifiedAttributed:     int0(meta.verifiedAttributed),
      legacyExcluded:         int0(meta.legacyExcluded),
      awaitingClassification: int0(meta.awaitingClassification),
      threshold:              numOrNull(meta.threshold),
      thresholdSource:        meta.thresholdSource ?? "default",
    },
  };
}

// True when at least one trusted attempt was attributed to a topic.
export function hasVerifiedEvidence(shaped) {
  return (shaped?.topics?.length ?? 0) > 0
      && (shaped?.meta?.verifiedAttributed ?? 0) > 0;
}

// A single learner's cell score for a topic, or null (renders "—", never 0).
export function cellScore(topic, userId) {
  const rs = topic?.repScores?.find(r => r.userId === userId);
  return rs && typeof rs.score === "number" ? rs.score : null;
}

// The full rep-score entry (score + n + passed) for a learner in a topic, or null.
export function cellEntry(topic, userId) {
  return topic?.repScores?.find(r => r.userId === userId) ?? null;
}

// Rep drill-down: one rep's per-topic list from the manager matrix.
// [{ tagId, topic, avgScore, attempts, passed }] — only topics the rep has data in.
export function repTopicsFromHeatmap(shaped, userId) {
  const out = [];
  for (const t of shaped?.topics ?? []) {
    const rs = t.repScores.find(r => r.userId === userId);
    if (!rs || typeof rs.score !== "number") continue;
    out.push({ tagId: t.tagId, topic: t.label, avgScore: rs.score, attempts: rs.n, passed: rs.passed });
  }
  return out.sort((a, b) => a.avgScore - b.avgScore);
}

// Learner "Knowledge by Topic": own scope (the RPC already restricts to self, so
// each topic's single cell is the learner's own). [{ tagId, topic, avgScore,
// attempts, passed }].
export function ownTopicsFromHeatmap(shaped) {
  return (shaped?.topics ?? []).map(t => {
    const own = t.repScores[0] ?? null;
    return {
      tagId:    t.tagId,
      topic:    t.label,
      avgScore: typeof t.avgScore === "number" ? t.avgScore : (own?.score ?? null),
      attempts: own?.n ?? 0,
      passed:   own?.passed ?? 0,
    };
  }).sort((a, b) => (a.avgScore ?? 0) - (b.avgScore ?? 0));
}

// Concise, honest coverage string from live meta values.
// "3 verified attempts included · 19 legacy attempts excluded · 6 awaiting classification"
export function coverageLine(meta) {
  const v = int0(meta?.verifiedAttributed);
  const l = int0(meta?.legacyExcluded);
  const a = int0(meta?.awaitingClassification);
  return [
    `${v} verified ${plural(v, "attempt")} included`,
    `${l} legacy ${plural(l, "attempt")} excluded`,
    `${a} awaiting classification`,
  ].join(" · ");
}

// Human sentence for the threshold source (explicit, never hidden).
export function thresholdNote(meta) {
  const t = numOrNull(meta?.threshold);
  if (t == null) return "";
  return meta?.thresholdSource === "tenant_settings"
    ? `Threshold ${t}% (tenant setting)`
    : `Threshold ${t}% (default)`;
}

function int0(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; }
function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function plural(n, w) { return n === 1 ? w : `${w}s`; }
