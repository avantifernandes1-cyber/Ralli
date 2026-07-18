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

// ── Scoring weights (must sum to 1.0) ─────────────────────────────────────────
const WEIGHTS = {
  learning: 0.35, // lesson + course completion rate
  quiz:     0.40, // quiz accuracy and pass rate
  game:     0.25, // game participation + accuracy
};

// ── Readiness score bands ─────────────────────────────────────────────────────
export const READINESS_BANDS = [
  { min: 85, label: "High",    color: "#22c55e", bg: "#f0fdf4" },
  { min: 65, label: "On Track", color: "#f59e0b", bg: "#fffbeb" },
  { min: 0,  label: "At Risk",  color: "#ef4444", bg: "#fef2f2" },
];

export function getReadinessBand(score) {
  return READINESS_BANDS.find(b => score >= b.min) ?? READINESS_BANDS[READINESS_BANDS.length - 1];
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
export async function getUserPerformance(tenantId, userId, { windowDays = 30 } = {}) {
  if (!tenantId || !userId) return { data: null, error: new Error("Missing params") };

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

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
    supabase
      .from("quiz_attempts")
      .select("quiz_id, score, passed, attempt_num, created_at")
      .eq("tenant_id", tenantId)
      .eq("user_id", userId)
      .order("created_at", { ascending: false }),
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
  if (perfError || !perf) return { data: null, error: perfError };

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
 * @returns {Promise<{ data: TeamInsights|null, error: Object|null }>}
 */
export async function getTeamInsights(tenantId, userIds = null) {
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

  const atRisk        = members.filter(m => m.score < 65).map(m => m.user_id);
  const topPerformers = members.filter(m => m.score >= 85).map(m => m.user_id);

  // Distribution
  const distribution = {
    high:     members.filter(m => m.score >= 85).length,
    onTrack:  members.filter(m => m.score >= 65 && m.score < 85).length,
    atRisk:   members.filter(m => m.score < 65).length,
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
 *     repsBelow:   number,   // score < 65
 *     repsAbove:   number,
 *     repScores:   [{ userId, score, passed }],
 *   }]
 *
 * @param {string} tenantId
 * @returns {Promise<Array>}
 */
export async function getTopicHeatmap(tenantId) {
  if (!tenantId) return [];

  const [{ data: quizzes, error: qErr }, { data: attempts, error: aErr }] =
    await Promise.all([
      supabase
        .from("tenant_quizzes")
        .select("id, tags")
        .eq("tenant_id", tenantId)
        .eq("status", "active"),
      supabase
        .from("quiz_attempts")
        .select("user_id, quiz_id, score, passed, created_at")
        .eq("tenant_id", tenantId),
    ]);

  if (qErr || aErr || !quizzes?.length || !attempts?.length) return [];

  // Build quiz → tags[] map (normalize JSONB which may be string array or null)
  const quizTags = {};
  for (const q of quizzes) {
    const tags = Array.isArray(q.tags)
      ? q.tags
      : typeof q.tags === "string"
      ? JSON.parse(q.tags)
      : [];
    // Normalize: trim + lowercase so "Discovery" and "discovery" aggregate together
    quizTags[q.id] = tags.filter(Boolean).map(t => String(t).trim().toLowerCase());
  }

  // Keep only the latest attempt per (user, quiz) pair
  const latestAttempts = {};
  for (const a of attempts) {
    const key = `${a.user_id}::${a.quiz_id}`;
    if (
      !latestAttempts[key] ||
      new Date(a.created_at) > new Date(latestAttempts[key].created_at)
    ) {
      latestAttempts[key] = a;
    }
  }

  // Bucket scores by topic
  const topicMap = {}; // topic → { scores: [{ userId, score, passed }] }
  for (const a of Object.values(latestAttempts)) {
    const tags = quizTags[a.quiz_id] ?? [];
    if (!tags.length) continue;
    const score = typeof a.score === "number" ? a.score : parseFloat(a.score) || 0;
    for (const tag of tags) {
      if (!topicMap[tag]) topicMap[tag] = { scores: [] };
      topicMap[tag].scores.push({ userId: a.user_id, score, passed: !!a.passed });
    }
  }

  // Aggregate per topic
  const result = Object.entries(topicMap).map(([topic, { scores }]) => {
    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const below = scores.filter(r => r.score < 65);
    return {
      topic,
      avgScore:  Math.round(avg),
      repsTotal: scores.length,
      repsBelow: below.length,
      repsAbove: scores.length - below.length,
      repScores: scores,
    };
  });

  // Weakest first
  return result.sort((a, b) => a.avgScore - b.avgScore);
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
export async function getRepTopicScores(tenantId, userId) {
  if (!tenantId || !userId) return [];

  const [{ data: quizzes, error: qErr }, { data: attempts, error: aErr }] =
    await Promise.all([
      supabase
        .from("tenant_quizzes")
        .select("id, tags")
        .eq("tenant_id", tenantId)
        .eq("status", "active"),
      supabase
        .from("quiz_attempts")
        .select("quiz_id, score, passed, created_at")
        .eq("tenant_id", tenantId)
        .eq("user_id", userId),
    ]);

  if (qErr || aErr || !quizzes?.length || !attempts?.length) return [];

  const quizTags = {};
  for (const q of quizzes) {
    const tags = Array.isArray(q.tags)
      ? q.tags
      : typeof q.tags === "string"
      ? JSON.parse(q.tags)
      : [];
    // Normalize: trim + lowercase so "Discovery" and "discovery" aggregate together
    quizTags[q.id] = tags.filter(Boolean).map(t => String(t).trim().toLowerCase());
  }

  // Latest attempt per quiz
  const latestByQuiz = {};
  for (const a of attempts) {
    if (
      !latestByQuiz[a.quiz_id] ||
      new Date(a.created_at) > new Date(latestByQuiz[a.quiz_id].created_at)
    ) {
      latestByQuiz[a.quiz_id] = a;
    }
  }

  const topicMap = {};
  for (const a of Object.values(latestByQuiz)) {
    const tags = quizTags[a.quiz_id] ?? [];
    const score = typeof a.score === "number" ? a.score : parseFloat(a.score) || 0;
    for (const tag of tags) {
      if (!topicMap[tag]) topicMap[tag] = { scores: [], passed: 0 };
      topicMap[tag].scores.push(score);
      if (a.passed) topicMap[tag].passed++;
    }
  }

  const result = Object.entries(topicMap).map(([topic, { scores, passed }]) => ({
    topic,
    avgScore: Math.round(scores.reduce((s, v) => s + v, 0) / scores.length),
    attempts: scores.length,
    passed,
  }));

  return result.sort((a, b) => a.avgScore - b.avgScore);
}

/**
 * Compute org-level summary metrics for the Leadership Dashboard KPI cards.
 *
 * Returns:
 *   {
 *     overallReadiness:   number,   // avg of latest readiness_scores per user
 *     avgQuizScore:       number,   // avg of all quiz_attempts.score
 *     completionPct:      number,   // % of scored users with ≥1 lesson_completion
 *     belowThreshold:     number,   // readiness_scores < 65
 *     activeLearners:     number,   // distinct users in user_point_events last 30d
 *     totalMembersScored: number,
 *   }
 *
 * @param {string} tenantId
 * @returns {Promise<Object>}
 */
export async function getOrgMetrics(tenantId) {
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

  const belowThreshold = userScores.filter(s => s < 65).length;

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
