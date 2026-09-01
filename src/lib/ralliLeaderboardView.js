/**
 * Ralli Live Leaderboard — presentation helpers (pure, dependency-free).
 *
 * These do NOT compute accuracy, denominators, eligibility, or ranks — those are
 * server-authoritative (migration 085 RPCs). They only:
 *   - threshold the server-returned aggregates into the two recognitions (§6), and
 *   - format server numbers for display.
 * The recognition medians are computed over the server's OWN eligible adjusted-accuracy /
 * speed values — a display threshold on authoritative numbers, never a re-derivation.
 */

export function median(nums) {
  const a = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).slice().sort((x, y) => x - y);
  if (a.length === 0) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

// Recognitions from the individuals rows. Requires ≥2 eligible learners (else "not enough").
// - Most Accurate: eligible learner with the highest adjusted accuracy (server rank breaks ties).
// - Fast and Accurate: eligible AND adjusted accuracy ≥ eligible median AND a valid speed sample
//   AND median normalized correct speed better (lower) than the eligible median speed.
export function computeRecognitions(rows) {
  const eligible = (rows || []).filter((r) => r && r.enough_data);
  if (eligible.length < 2) {
    return { notEnough: true, mostAccuratePlayerId: null, fastAndAccurateIds: new Set() };
  }
  // Most Accurate: prefer the server's own rank=1; fall back to max adjusted accuracy.
  let most = eligible.find((r) => r.rank === 1);
  if (!most) {
    most = eligible.slice().sort(
      (a, b) => (b.adjusted_accuracy - a.adjusted_accuracy) || (a.rank ?? 1e9) - (b.rank ?? 1e9)
    )[0];
  }
  const medAdj = median(eligible.map((r) => r.adjusted_accuracy));
  const speeds = eligible
    .map((r) => r.median_norm_speed)
    .filter((s) => typeof s === "number" && Number.isFinite(s));
  const medSpeed = median(speeds);
  const fast = new Set();
  if (medSpeed != null) {
    for (const r of eligible) {
      const hasSpeed = typeof r.median_norm_speed === "number" && Number.isFinite(r.median_norm_speed);
      if (r.adjusted_accuracy >= medAdj && hasSpeed && r.median_norm_speed < medSpeed) {
        fast.add(r.player_id);
      }
    }
  }
  return { notEnough: false, mostAccuratePlayerId: most ? most.player_id : null, fastAndAccurateIds: fast };
}

// Format a 0..1 accuracy as a whole-ish percentage for display (server value, unrounded input).
export function formatAccuracyPct(x) {
  if (typeof x !== "number" || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}

// Split individuals into ranked (enough_data) and "not enough data" (with progress) buckets.
export function partitionIndividuals(rows) {
  const ranked = [];
  const pending = [];
  for (const r of rows || []) {
    if (r && r.enough_data) ranked.push(r);
    else pending.push(r);
  }
  ranked.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return { ranked, pending };
}

export function partitionTeams(rows) {
  const ranked = [];
  const pending = [];
  for (const r of rows || []) {
    if (r && r.enough_data) ranked.push(r);
    else pending.push(r);
  }
  ranked.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return { ranked, pending };
}
