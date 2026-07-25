/**
 * Ralli AI Insights Service
 *
 * Aggregates real platform performance data and computes:
 *   - Readiness scores (0–100) per user, team, and org
 *   - Topic-level performance breakdown
 *   - Rules-based recommendations
 *   - Structured data payload for AI summarization
 *
 * Core principle: AI only summarizes real data. This service produces the
 * structured facts; the AI API route (api/ai-insights.js) generates prose.
 *
 * Data sources:
 *   - user_point_events  → total XP, source breakdown (lesson/quiz/game/course)
 *   - quiz_attempts      → per-quiz scores, pass rates, accuracy trends
 *   - lesson_completions → lesson completion by user
 *   - game_answers       → per-question game accuracy (when available)
 *   - readiness_scores   → cached scores (written after compute)
 *   - ai_insights        → cached AI summaries
 */

import { supabase } from "./supabase.js";
import { shapeHeatmap, repTopicsFromHeatmap, ownTopicsFromHeatmap } from "./heatmapModel.js";

// ── Scoring weights (must sum to 1.0) ─────────────────────────────────────────
const WEIGHTS = {
  learning: 0.35, // lesson + course completion rate
  quiz:     0.40, // quiz accuracy and pass rate
  game:     0.25, // game participation + accuracy
};

// ── Readiness threshold (tenant-configurable) ─────────────────────────────────
// Single shared source of truth for the "below threshold" cutoff used across
// the Leadership Dashboard (Below Threshold KPI, Low-Readiness Reps, Needs
// Coaching tag, Company Risk, People Insights bands, readiness alert banner).
// Stored at tenant_settings.learning_settings.readinessThreshold. Defaults to
// 80 when the tenant has no value set (new tenants) or the stored value is
// invalid — the DB also enforces 0-100 via a CHECK constraint (migration
// 043), this is a defensive second layer so the UI never breaks on bad data.
export const DEFAULT_READINESS_THRESHOLD = 80;

/**
 * Resolve the effective readiness threshold for a tenant.
 * @param {{ learning_settings?: { readinessThreshold?: number } }|null} tenantSettings
 * @returns {number} 0-100
 */
export function getReadinessThreshold(tenantSettings) {
  const v = tenantSettings?.learning_settings?.readinessThreshold;
  return (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100)
    ? v
    : DEFAULT_READINESS_THRESHOLD;
}

/**
 * Clamp a candidate threshold value to the valid 0-100 range.
 * Used by the Settings UI before persisting a save.
 * @param {number} v
 * @returns {number}
 */
export function clampReadinessThreshold(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return DEFAULT_READINESS_THRESHOLD;
  return Math.max(0, Math.min(100, Math.round(n)));
}

// ── Readiness score bands ─────────────────────────────────────────────────────
// "High" (85) is a separate, fixed tier unrelated to the configurable
// threshold. The lower boundary is the tenant's readiness threshold — a
// score at or above it is "On Track", below it is "At Risk" (same cutoff
// used everywhere else in the app for "below threshold" comparisons).
export function getReadinessBands(threshold = DEFAULT_READINESS_THRESHOLD) {
  return [
    { min: 85,        label: "High",     color: "#22c55e", bg: "#f0fdf4" },
    { min: threshold, label: "On Track", color: "#f59e0b", bg: "#fffbeb" },
    { min: 0,         label: "At Risk",  color: "#ef4444", bg: "#fef2f2" },
  ];
}

// Back-compat default export (unthresholded callers keep working at 80).
export const READINESS_BANDS = getReadinessBands();

export function getReadinessBand(score, threshold = DEFAULT_READINESS_THRESHOLD) {
  const bands = getReadinessBands(threshold);
  return bands.find(b => score >= b.min) ?? bands[bands.length - 1];
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function clamp(v, min = 0, max = 100) { return Math.max(min, Math.min(max, Math.round(v))); }

/** Convert a raw ratio (0–1) to a 0-100 score. */
function pctScore(numerator, denominator) {
  if (!denominator) return 0;
  return clamp((numerator / denominator) * 100);
}

// ── User performance aggregation ─────────────────────────────────────────────

/**
 * Aggregate all performance data for one user within a tenant.
 * Returns structured facts — no AI prose.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {{ windowDays?: number }} [opts]
 * @returns {Promise<{ data: UserPerformance|null, error: Object|null }>}
 */
// `safe`: when true (a learner reading their OWN performance), quiz attempts are
// sourced from the learner-safe SECURITY DEFINER RPC (list_my_quiz_attempts_safe
// — own attempts, non-answer columns only) instead of a direct quiz_attempts
// SELECT, so this keeps working after migration 057 revokes learner table reads.
// point_events / lesson_completions are unaffected by 057 and stay direct.
// The manager path (reading a rep by userId) keeps the direct read (safe:false).
export async function getUserPerformance(tenantId, userId, { windowDays = 30, safe = false } = {}) {
  if (!tenantId || !userId) return { data: null, error: new Error("Missing params") };

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const quizAttemptsSource = safe
    ? supabase.rpc("list_my_quiz_attempts_safe")   // own attempts, learner-safe
    : supabase
        .from("quiz_attempts")
        .select("quiz_id, score, passed, attempt_num, created_at")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId)
        .order("created_at", { ascending: false });

  // Fetch in parallel
  const [
    { data: pointEvents, error: peError },
    { data: quizAttempts, error: qaError },
    { data: lessonCompletions, error: lcError },
  ] = await Promise.all([
    supabase
      .from("user_point_events")
      .select("source_type, source_id, points, created_at")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId),
    quizAttemptsSource,
    supabase
      .from("lesson_completions")
      .select("lesson_id, completed_at")
      .eq("tenant_id", tenantId)
      .eq("profile_id", userId),
  ]);

  const error = peError ?? qaError ?? lcError ?? null;

  // ── Point event aggregation ──
  const events = pointEvents ?? [];
  const recentEvents = events.filter(e => e.created_at >= since);

  const totalXp = events.reduce((s, e) => s + e.points, 0);
  const recentXp = recentEvents.reduce((s, e) => s + e.points, 0);

  const lessonsCompletedIds = new Set(
    events.filter(e => e.source_type === "lesson").map(e => e.source_id)
  );
  const coursesCompletedIds = new Set(
    events.filter(e => e.source_type === "course").map(e => e.source_id)
  );
  const gamesPlayedIds = new Set(
    events.filter(e => e.source_type === "game").map(e => e.source_id)
  );

  // ── Quiz attempt aggregation ──
  const attempts = quizAttempts ?? [];
  const totalAttempts = attempts.length;
  const passedAttempts = attempts.filter(a => a.passed).length;
  const avgQuizScore = totalAttempts > 0
    ? Math.round(attempts.reduce((s, a) => s + a.score, 0) / totalAttempts)
    : 0;
  const passRate = pctScore(passedAttempts, totalAttempts);

  // Most recent attempt per quiz (for current accuracy)
  const latestByQuiz = {};
  for (const a of attempts) {
    if (!latestByQuiz[a.quiz_id]) latestByQuiz[a.quiz_id] = a;
  }
  const uniqueQuizzesAttempted = Object.keys(latestByQuiz).length;
  const uniqueQuizzesPassed = Object.values(latestByQuiz).filter(a => a.passed).length;

  // ── Component scores ──
  // Learning: ratio of completions within tenant content is hard to compute without
  // knowing total assigned content — use XP earned from learning sources as proxy.
  const learningXp  = events.filter(e => e.source_type === "lesson" || e.source_type === "course").reduce((s, e) => s + e.points, 0);
  const gameXp      = events.filter(e => e.source_type === "game").reduce((s, e) => s + e.points, 0);

  // Learning score: caps at 100 at 10 lessons + 3 courses
  const learningScore = clamp(
    (lessonsCompletedIds.size / 10) * 60 + (coursesCompletedIds.size / 3) * 40
  );

  // Quiz score: weighted avg of pass rate + avg score
  const quizScore = clamp(passRate * 0.6 + avgQuizScore * 0.4);

  // Game score: participation + implied accuracy from XP (25 base + score points per game)
  const gameParticipation = gamesPlayedIds.size;
  const gameScore = gameParticipation > 0
    ? clamp((gameParticipation / 5) * 60 + Math.min(gameXp / 1000, 1) * 40)
    : 0;

  // Composite readiness score
  const score = clamp(
    learningScore * WEIGHTS.learning +
    quizScore     * WEIGHTS.quiz +
    gameScore     * WEIGHTS.game
  );

  const data = {
    userId,
    tenantId,
    windowDays,
    score,
    learningScore,
    quizScore,
    gameScore,
    totalXp,
    recentXp,
    lessonsCompleted:     lessonsCompletedIds.size,
    coursesCompleted:     coursesCompletedIds.size,
    gamesPlayed:          gameParticipation,
    quizzesAttempted:     uniqueQuizzesAttempted,
    quizzesPassed:        uniqueQuizzesPassed,
    avgQuizScore,
    passRate,
    totalQuizAttempts:    totalAttempts,
    // For trend / recommendation engine
    recentQuizAttempts:   attempts.filter(a => a.created_at >= since),
    weakQuizzes:          Object.values(latestByQuiz).filter(a => !a.passed),
    computedAt:           new Date().toISOString(),
  };

  return { data, error };
}

// ── Readiness score persistence ───────────────────────────────────────────────

/**
 * Compute and persist a readiness score for a user.
 * Returns the score row.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {{ windowDays?: number }} [opts]
 */
export async function computeAndSaveReadinessScore(tenantId, userId, opts = {}) {
  const { data: perf, error: perfError } = await getUserPerformance(tenantId, userId, opts);
  if (perfError || !perf) {
    // Blocking Fix 2 — this function resolves { data, error } instead of
    // rejecting (by design — see computeAndSaveReadinessScore's callers,
    // which expect a result object, not a throw). That means a caller using
    // only `.catch()` (triggerReadinessUpdate, below) never sees this
    // failure. Root cause of readiness_scores staying empty for weeks
    // despite real quiz/lesson activity: the upsert below was failing with
    // Postgres 42P10 (missing UNIQUE(tenant_id,user_id) constraint — fixed
    // in migration 024/readiness_scores_upsert_constraint) on every single
    // call, completely silently. Logging directly here means a future
    // regression is loud regardless of how the caller handles the result.
    console.error("[ralli] computeAndSaveReadinessScore: getUserPerformance failed", { tenantId, userId, perfError });
    return { data: null, error: perfError };
  }

  const { error: upsertError } = await supabase.from("readiness_scores").upsert({
    tenant_id:         tenantId,
    user_id:           userId,
    score:             perf.score,
    learning_score:    perf.learningScore,
    quiz_score:        perf.quizScore,
    game_score:        perf.gameScore,
    lessons_completed: perf.lessonsCompleted,
    courses_completed: perf.coursesCompleted,
    quizzes_passed:    perf.quizzesPassed,
    quizzes_attempted: perf.quizzesAttempted,
    games_played:      perf.gamesPlayed,
    window_days:       opts.windowDays ?? 30,
    computed_at:       new Date().toISOString(),
  }, { onConflict: "tenant_id,user_id" });

  if (upsertError) {
    // Blocking Fix 2 — same rationale as above: log unconditionally here,
    // don't rely on every call site's error handling to notice.
    console.error("[ralli] computeAndSaveReadinessScore: readiness_scores upsert failed", { tenantId, userId, upsertError });
  }

  return { data: perf, error: upsertError };
}

// ── Rules-based recommendations ───────────────────────────────────────────────

/**
 * Generate a ranked list of recommendations based on performance gaps.
 * No AI — purely rules-based. AI summarizes these in the API route.
 *
 * @param {UserPerformance} perf
 * @returns {Array<{ priority: 'high'|'medium'|'low', type: string, action: string, reason: string }>}
 */
export function getRecommendations(perf) {
  if (!perf) return [];
  const recs = [];

  // Quiz accuracy gap
  if (perf.avgQuizScore < 70 && perf.quizzesAttempted > 0) {
    recs.push({
      priority: "high",
      type:     "quiz",
      action:   "Retake your lowest-scoring quizzes",
      reason:   `Your average quiz score is ${perf.avgQuizScore}%. Retaking failed quizzes is the fastest way to raise your readiness score.`,
    });
  } else if (perf.avgQuizScore < 90 && perf.quizzesAttempted > 0) {
    recs.push({
      priority: "medium",
      type:     "quiz",
      action:   "Review quiz material and retry",
      reason:   `You're passing quizzes but averaging ${perf.avgQuizScore}%. A few retakes could push you to mastery.`,
    });
  }

  // No quiz activity
  if (perf.quizzesAttempted === 0) {
    recs.push({
      priority: "high",
      type:     "quiz",
      action:   "Start your first quiz",
      reason:   "Quiz performance accounts for 40% of your readiness score. Get started to unlock your full score.",
    });
  }

  // Low lesson completion
  if (perf.lessonsCompleted < 3) {
    recs.push({
      priority: perf.lessonsCompleted === 0 ? "high" : "medium",
      type:     "lesson",
      action:   "Complete more lessons",
      reason:   `You've completed ${perf.lessonsCompleted} lesson${perf.lessonsCompleted !== 1 ? "s" : ""}. Consistent lesson completion builds foundational knowledge.`,
    });
  }

  // No course completion
  if (perf.coursesCompleted === 0 && perf.lessonsCompleted >= 3) {
    recs.push({
      priority: "medium",
      type:     "course",
      action:   "Finish a full course",
      reason:   "Course completions unlock bonus XP and signal deeper topic mastery.",
    });
  }

  // No game participation
  if (perf.gamesPlayed === 0) {
    recs.push({
      priority: "low",
      type:     "game",
      action:   "Join a live game session",
      reason:   "Live games reinforce knowledge under pressure and contribute to your readiness score.",
    });
  }

  // Low recent XP (streak broken)
  if (perf.recentXp === 0 && perf.totalXp > 0) {
    recs.push({
      priority: "high",
      type:     "engagement",
      action:   "Get back on track — no activity in the last 30 days",
      reason:   "Your score may drop if there's no recent activity. Even one lesson or quiz counts.",
    });
  }

  return recs.slice(0, 5); // cap at 5 recommendations
}

// ── Team insights ─────────────────────────────────────────────────────────────

/**
 * Aggregate readiness scores for all users in a tenant (for manager/admin view).
 *
 * @param {string} tenantId
 * @param {string[]} [userIds]  — if provided, restrict to these users
 * @param {{ threshold?: number }} [opts] — readiness threshold cutoff (default 80, see getReadinessThreshold)
 * @returns {Promise<{ data: TeamInsights|null, error: Object|null }>}
 */
export async function getTeamInsights(tenantId, userIds = null, { threshold = DEFAULT_READINESS_THRESHOLD } = {}) {
  if (!tenantId) return { data: null, error: new Error("Missing tenantId") };

  // Latest readiness score per user (most recently computed)
  let query = supabase
    .from("readiness_scores")
    .select("user_id, score, learning_score, quiz_score, game_score, lessons_completed, quizzes_passed, quizzes_attempted, games_played, computed_at")
    .eq("tenant_id", tenantId)
    .order("computed_at", { ascending: false });

  if (userIds?.length) query = query.in("user_id", userIds);

  const { data: rows, error } = await query;
  if (error) return { data: null, error };
  if (!rows?.length) return { data: { members: [], avgScore: 0, atRisk: [], topPerformers: [] }, error: null };

  // Latest score per user only
  const latestPerUser = {};
  for (const r of rows) {
    if (!latestPerUser[r.user_id]) latestPerUser[r.user_id] = r;
  }
  const members = Object.values(latestPerUser);

  const avgScore = members.length
    ? Math.round(members.reduce((s, m) => s + m.score, 0) / members.length)
    : 0;

  const atRisk        = members.filter(m => m.score < threshold).map(m => m.user_id);
  const topPerformers = members.filter(m => m.score >= 85).map(m => m.user_id);

  // Distribution
  const distribution = {
    high:     members.filter(m => m.score >= 85).length,
    onTrack:  members.filter(m => m.score >= threshold && m.score < 85).length,
    atRisk:   members.filter(m => m.score < threshold).length,
  };

  return {
    data: {
      members,
      avgScore,
      atRisk,
      topPerformers,
      distribution,
      totalMembers: members.length,
    },
    error: null,
  };
}

// ── Org insights ──────────────────────────────────────────────────────────────

/**
 * High-level org health metrics for admin view.
 * Aggregates from user_point_events and quiz_attempts for the whole tenant.
 *
 * @param {string} tenantId
 * @returns {Promise<{ data: OrgInsights|null, error: Object|null }>}
 */
export async function getOrgInsights(tenantId) {
  if (!tenantId) return { data: null, error: new Error("Missing tenantId") };

  const [
    { data: pointEvents, error: peError },
    { data: quizAttempts, error: qaError },
    { data: teamInsights, error: tiError },
  ] = await Promise.all([
    supabase
      .from("user_point_events")
      .select("user_id, source_type, points, created_at")
      .eq("tenant_id", tenantId),
    supabase
      .from("quiz_attempts")
      .select("user_id, score, passed, created_at")
      .eq("tenant_id", tenantId),
    getTeamInsights(tenantId),
  ]);

  const error = peError ?? qaError ?? tiError ?? null;

  const events  = pointEvents ?? [];
  const attempts = quizAttempts ?? [];

  const activeUsers = new Set(events.map(e => e.user_id)).size;
  const totalXp     = events.reduce((s, e) => s + e.points, 0);

  const last30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const activeUsersLast30 = new Set(
    events.filter(e => e.created_at >= last30).map(e => e.user_id)
  ).size;

  const orgAvgQuizScore = attempts.length
    ? Math.round(attempts.reduce((s, a) => s + a.score, 0) / attempts.length)
    : 0;
  const orgPassRate = attempts.length
    ? Math.round((attempts.filter(a => a.passed).length / attempts.length) * 100)
    : 0;

  return {
    data: {
      tenantId,
      activeUsers,
      activeUsersLast30,
      totalXp,
      orgAvgQuizScore,
      orgPassRate,
      totalQuizAttempts: attempts.length,
      teamSummary: teamInsights.data ?? null,
      computedAt: new Date().toISOString(),
    },
    error,
  };
}

// ── Cached AI insight fetch/store ─────────────────────────────────────────────

/**
 * Fetch the most recent cached AI insight for a scope.
 * Returns null if none exists or if it's older than maxAgeHours.
 *
 * @param {string} tenantId
 * @param {'user'|'team'|'org'} scope
 * @param {string} scopeId
 * @param {{ maxAgeHours?: number }} [opts]
 */
export async function getCachedInsight(tenantId, scope, scopeId, { maxAgeHours = 24 } = {}) {
  const since = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from("ai_insights")
    .select("id, summary, recommendations, generated_at")
    .eq("tenant_id", tenantId)
    .eq("scope", scope)
    .eq("scope_id", scopeId)
    .gte("generated_at", since)
    .order("generated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return { data: null, error };
  return { data, error: null };
}

/**
 * Save a generated AI insight to cache.
 *
 * @param {string} tenantId
 * @param {'user'|'team'|'org'} scope
 * @param {string} scopeId
 * @param {{ summary: string, recommendations: Array }} insight
 */
export async function saveInsightCache(tenantId, scope, scopeId, insight) {
  const { error } = await supabase.from("ai_insights").upsert({
    tenant_id:       tenantId,
    scope,
    scope_id:        scopeId,
    summary:         insight.summary,
    recommendations: insight.recommendations ?? [],
    generated_at:    new Date().toISOString(),
  }, { onConflict: "tenant_id,scope,scope_id" });
  return { error };
}

/**
 * Fire-and-forget readiness score update.
 * Call this after any scoring event (lesson complete, quiz complete, game end).
 * Non-blocking — errors are silently logged so they never interrupt the user flow.
 *
 * @param {string} tenantId
 * @param {string} userId
 */
export function triggerReadinessUpdate(tenantId, userId) {
  if (!tenantId || !userId) return;
  computeAndSaveReadinessScore(tenantId, userId)
    .catch(e => console.error("[ralli] triggerReadinessUpdate failed:", e));
}

// ─────────────────────────────────────────────────────────────────────────────
// Readiness Analytics v2
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute topic-level readiness across all reps in a tenant.
 * Uses quiz_attempts joined with tenant_quizzes.tags (JSONB array).
 *
 * Returns an array sorted by avgScore ascending (weakest topics first):
 *   [{
 *     topic:       string,
 *     avgScore:    number,   // 0–100
 *     repsTotal:   number,
 *     repsBelow:   number,   // score < threshold
 *     repsAbove:   number,
 *     repScores:   [{ userId, score, passed }],
 *   }]
 *
 * @param {string} tenantId
 * @param {{ threshold?: number }} [opts] — readiness threshold cutoff (default 80)
 * @returns {Promise<Array>}
 */
// Knowledge Heatmap — canonical, snapshot-based (migration 062).
//
// Reads the ONE canonical aggregation source, public.get_knowledge_heatmap(),
// instead of bucketing the mutable legacy tenant_quizzes.tags. Attribution comes
// only from immutable attempt-time snapshots; only trusted server_v2 attempts
// score; merged tags resolve to their active target; every active learner is a
// column. Returns the full shaped payload { topics, learners, meta } — the
// caller renders the matrix from `learners` and coverage/threshold from `meta`.
// The `threshold` option is ignored (the RPC returns the authoritative threshold
// and its source); the parameter is kept for call-site compatibility.
export async function getTopicHeatmap(tenantId, _opts = {}) {
  if (!tenantId) return emptyHeatmap();
  const { data, error } = await supabase.rpc("get_knowledge_heatmap");
  if (error || !data) return emptyHeatmap();
  return shapeHeatmap(data);
}

function emptyHeatmap() {
  return shapeHeatmap({ topics: [], learners: [], meta: {} });
}

/**
 * Compute per-topic quiz scores for a single rep.
 *
 * Returns:
 *   [{ topic, avgScore, attempts, passed }]
 *   sorted by avgScore ascending.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @returns {Promise<Array>}
 */
// Per-topic scores for a single rep, from the canonical get_knowledge_heatmap()
// RPC (migration 062) — one aggregation source shared with the manager matrix
// and learner Knowledge-by-Topic, so a rep's numbers can never drift between
// surfaces. Attribution is attempt-time snapshot truth; only trusted server_v2
// attempts contribute. Returns [{ tagId, topic, avgScore, attempts, passed }].
//
// `safe`: when true (a learner reading their OWN topic scores) the RPC restricts
// output to the caller — no other learner's data is returned — so it needs no
// direct table reads and survives migration 057. When false (a manager drill-down
// reading a specific rep by userId) the RPC returns the tenant matrix and this
// picks out that rep's cells.
export async function getRepTopicScores(tenantId, userId, { safe = false } = {}) {
  if (!tenantId || !userId) return [];
  const { data, error } = await supabase.rpc("get_knowledge_heatmap");
  if (error || !data) return [];
  const shaped = shapeHeatmap(data);
  return safe ? ownTopicsFromHeatmap(shaped) : repTopicsFromHeatmap(shaped, userId);
}

/**
 * Compute org-level summary metrics for the Leadership Dashboard KPI cards.
 *
 * Returns:
 *   {
 *     overallReadiness:   number,   // avg of latest readiness_scores per user
 *     avgQuizScore:       number,   // avg of all quiz_attempts.score
 *     completionPct:      number,   // % of scored users with ≥1 lesson_completion
 *     belowThreshold:     number,   // readiness_scores < threshold
 *     activeLearners:     number,   // distinct users in user_point_events last 30d
 *     totalMembersScored: number,
 *   }
 *
 * @param {string} tenantId
 * @param {{ threshold?: number }} [opts] — readiness threshold cutoff (default 80, see getReadinessThreshold)
 * @returns {Promise<Object>}
 */
export async function getOrgMetrics(tenantId, { threshold = DEFAULT_READINESS_THRESHOLD } = {}) {
  if (!tenantId) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    { data: scores,      error: sErr  },
    { data: attempts,    error: aErr  },
    { data: completions, error: cErr  },
    { data: events,      error: eErr  },
    // Fix 7: active member count from profiles (excludes inactive/removed members)
    { count: activeMemberCount, error: mErr },
  ] = await Promise.all([
    supabase
      .from("readiness_scores")
      .select("user_id, score, computed_at")
      .eq("tenant_id", tenantId)
      .order("computed_at", { ascending: false }),
    // Fix 2: fetch user_id + quiz_id + created_at so we can deduplicate retakes
    supabase
      .from("quiz_attempts")
      .select("user_id, quiz_id, score, created_at")
      .eq("tenant_id", tenantId),
    supabase
      .from("lesson_completions")
      .select("profile_id")
      .eq("tenant_id", tenantId),
    supabase
      .from("user_point_events")
      .select("user_id")
      .eq("tenant_id", tenantId)
      .gte("created_at", thirtyDaysAgo),
    // Fix 7: count active profiles (same filter the orgUsers loader uses)
    supabase
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .neq("status", "inactive"),
  ]);

  if (sErr || aErr || cErr || eErr || mErr) {
    console.error("[ralli] getOrgMetrics error", { sErr, aErr, cErr, eErr, mErr });
    return null;
  }

  // Deduplicate: keep latest score per user
  const latestByUser = {};
  for (const row of (scores ?? [])) {
    if (!latestByUser[row.user_id]) latestByUser[row.user_id] = row.score;
  }
  const userScores = Object.values(latestByUser);
  const totalMembersScored = userScores.length;

  const overallReadiness = totalMembersScored
    ? Math.round(userScores.reduce((s, v) => s + v, 0) / totalMembersScored)
    : 0;

  const belowThreshold = userScores.filter(s => s < threshold).length;

  // Fix 2: deduplicate quiz attempts to latest per user+quiz before averaging
  const latestAttemptMap = {};
  for (const a of (attempts ?? [])) {
    const key = `${a.user_id}::${a.quiz_id}`;
    if (!latestAttemptMap[key] || new Date(a.created_at) > new Date(latestAttemptMap[key].created_at)) {
      latestAttemptMap[key] = a;
    }
  }
  const dedupedScores = Object.values(latestAttemptMap).map(a =>
    typeof a.score === "number" ? a.score : parseFloat(a.score) || 0
  );
  const avgQuizScore = dedupedScores.length
    ? Math.round(dedupedScores.reduce((s, v) => s + v, 0) / dedupedScores.length)
    : 0;

  // Users who have completed at least one lesson
  const usersWithCompletions = new Set(
    (completions ?? []).map(c => c.profile_id)
  );
  // Fix 7: use active member count as denominator (not just scored members)
  const memberDenominator = (activeMemberCount ?? 0) > 0 ? activeMemberCount : totalMembersScored;
  const completionPct = memberDenominator
    ? Math.round((usersWithCompletions.size / memberDenominator) * 100)
    : 0;

  // Distinct active learners in last 30 days
  const activeLearners = new Set((events ?? []).map(e => e.user_id)).size;

  return {
    overallReadiness,
    avgQuizScore,
    completionPct,
    belowThreshold,
    activeLearners,
    totalMembersScored,
    totalActiveMembers: activeMemberCount ?? totalMembersScored,
  };
}
