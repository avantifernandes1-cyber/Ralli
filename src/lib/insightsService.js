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
// Pure readiness formula (no DB/client access) — the SINGLE implementation,
// shared with the server-only reconciliation tool so the formula is never
// duplicated and the browser client is never imported into Node.
import {
  WEIGHTS,
  latestAttemptsByUserQuiz,
  validAttemptScore,
  computeUserReadiness,
  isReadinessRepRole,
} from "./readinessFormula.js";
// Re-export the shared pieces so existing importers keep working.
export { WEIGHTS, latestAttemptsByUserQuiz, validAttemptScore, isReadinessRepRole } from "./readinessFormula.js";

// Canonical readiness population — active profiles in THIS tenant whose role is a
// rep (managers/admins/superadmins/inactive/cross-tenant excluded). Returns the
// rep id Set. Used to filter EVERY rep-performance input before aggregation.
async function getActiveRepIds(tenantId) {
  const { data, error } = await supabase
    .from("profiles").select("id, role")
    .eq("tenant_id", tenantId).neq("status", "inactive");
  if (error) return { repIds: null, error };
  const repIds = new Set((data ?? []).filter(p => isReadinessRepRole(p.role)).map(p => p.id));
  return { repIds, error: null };
}

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

// latestAttemptsByUserQuiz + validAttemptScore now live in ./readinessFormula.js
// (imported above) — one implementation shared with the reconciliation tool.

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
      .select("id, quiz_id, score, passed, attempt_num, created_at")
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

  // Composite readiness via the ONE shared pure formula (readinessFormula.js) —
  // the same implementation the server reconciliation tool uses (no duplication,
  // no browser client in Node). Log any invalid latest attempts for diagnosis
  // (quiz/attempt ids only — never full profile or answer data).
  const perf = computeUserReadiness({
    pointEvents:       pointEvents ?? [],
    quizAttempts:      quizAttempts ?? [],
    lessonCompletions: lessonCompletions ?? [],
    windowDays,
  });
  if (perf.invalidLatestQuizzes) {
    console.warn("[ralli] readiness: invalid latest quiz attempt(s) excluded from readiness", {
      tenantId, userId,
      quizzes: perf.invalidLatest.map(a => ({ quizId: a.quiz_id, attemptId: a.id })),
    });
  }
  const { invalidLatest: _invalidLatest, ...perfData } = perf; // don't leak raw attempt objects
  const data = { userId, tenantId, ...perfData };

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

// NOTE: the one-time readiness reconciliation/backfill is an OPERATIONS tool and
// deliberately does NOT live here (this module imports the browser Supabase
// client). It lives under server/ with a service-role client that never enters
// the app bundle. See server/reconcileReadiness.mjs.

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
export async function getTopicHeatmap(tenantId, { threshold = DEFAULT_READINESS_THRESHOLD } = {}) {
  if (!tenantId) return [];

  const [{ data: quizzes, error: qErr }, { data: attemptsRaw, error: aErr }, { repIds, error: repErr }] =
    await Promise.all([
      supabase
        .from("tenant_quizzes")
        .select("id, tags")
        .eq("tenant_id", tenantId)
        .eq("status", "active"),
      supabase
        .from("quiz_attempts")
        .select("id, user_id, quiz_id, score, passed, attempt_num, created_at")
        .eq("tenant_id", tenantId),
      getActiveRepIds(tenantId),
    ]);

  if (qErr || aErr || repErr || !quizzes?.length || !attemptsRaw?.length || !repIds) return [];
  // Restrict to ACTIVE REPS before latest-attempt/topic aggregation — a
  // manager/admin attempt must never affect topic readiness.
  const attempts = attemptsRaw.filter(a => repIds.has(a.user_id));
  if (!attempts.length) return [];

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

  // Keep only the latest attempt per (user, quiz) pair (shared resolver)
  const latestAttempts = latestAttemptsByUserQuiz(attempts);

  // Bucket scores by topic — same valid-latest rule as composite readiness: a
  // latest attempt with an invalid score is EXCLUDED (never bucketed as a 0).
  const topicMap = {}; // topic → { scores: [{ userId, score, passed }] }
  for (const a of latestAttempts.values()) {
    const tags = quizTags[a.quiz_id] ?? [];
    if (!tags.length) continue;
    const score = validAttemptScore(a);
    if (score == null) continue;
    for (const tag of tags) {
      if (!topicMap[tag]) topicMap[tag] = { scores: [] };
      topicMap[tag].scores.push({ userId: a.user_id, score, passed: !!a.passed });
    }
  }

  // Aggregate per topic
  const result = Object.entries(topicMap).map(([topic, { scores }]) => {
    const avg = scores.reduce((s, r) => s + r.score, 0) / scores.length;
    const below = scores.filter(r => r.score < threshold);
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
        .select("id, user_id, quiz_id, score, passed, attempt_num, created_at")
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

  // Latest attempt per quiz (shared resolver)
  const latestByQuiz = latestAttemptsByUserQuiz(attempts);

  const topicMap = {};
  for (const a of latestByQuiz.values()) {
    const tags = quizTags[a.quiz_id] ?? [];
    // Same valid-latest rule — an invalid latest score is excluded, not a 0.
    const score = validAttemptScore(a);
    if (score == null) continue;
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
 * ALL metrics are scoped to ACTIVE REPS ONLY (isReadinessRepRole) — managers,
 * admins, superadmins, inactive/unknown/cross-tenant users are excluded before
 * aggregation.
 *
 * Returns:
 *   {
 *     overallReadiness:   number,   // avg of latest readiness_scores per REP
 *     avgQuizScore:       number,   // avg of REPS' latest valid attempt per quiz
 *     completionPct:      number,   // % of ACTIVE REPS with ≥1 lesson_completion
 *     belowThreshold:     number,   // REP readiness_scores < threshold
 *     activeLearners:     number,   // distinct ACTIVE REPS with point events in last 30d
 *     totalMembersScored: number,   // reps WITH a readiness score
 *     totalActiveMembers: number,   // active rep count (coverage denominator)
 *   }
 *
 * @param {string} tenantId
 * @param {{ threshold?: number }} [opts] — readiness threshold cutoff (default 80, see getReadinessThreshold)
 * @returns {Promise<Object>}
 */
export async function getOrgMetrics(tenantId, { threshold = DEFAULT_READINESS_THRESHOLD } = {}) {
  if (!tenantId) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  // Canonical population FIRST — every metric below aggregates ONLY active reps.
  const { repIds, error: repErr } = await getActiveRepIds(tenantId);
  if (repErr) { console.error("[ralli] getOrgMetrics: rep population error", repErr); return null; }

  const [
    { data: scores,      error: sErr  },
    { data: attempts,    error: aErr  },
    { data: completions, error: cErr  },
    { data: events,      error: eErr  },
  ] = await Promise.all([
    supabase
      .from("readiness_scores")
      .select("user_id, score, computed_at")
      .eq("tenant_id", tenantId)
      .order("computed_at", { ascending: false }),
    supabase
      .from("quiz_attempts")
      .select("id, user_id, quiz_id, score, attempt_num, created_at")
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
  ]);

  if (sErr || aErr || cErr || eErr) {
    console.error("[ralli] getOrgMetrics error", { sErr, aErr, cErr, eErr });
    return null;
  }

  const activeRepCount = repIds.size;
  // Zero active reps → honest empty coverage; never fall back to manager rows.
  if (activeRepCount === 0) {
    return { overallReadiness: 0, avgQuizScore: 0, completionPct: 0, belowThreshold: 0,
      activeLearners: 0, totalMembersScored: 0, totalActiveMembers: 0 };
  }

  // Readiness — latest score per REP user only.
  const latestByUser = {};
  for (const row of (scores ?? [])) {
    if (!repIds.has(row.user_id)) continue;                    // exclude non-rep / unknown rows
    if (!latestByUser[row.user_id]) latestByUser[row.user_id] = row.score;
  }
  const userScores = Object.values(latestByUser);
  const totalMembersScored = userScores.length;                // reps WITH a score
  const overallReadiness = totalMembersScored
    ? Math.round(userScores.reduce((s, v) => s + v, 0) / totalMembersScored)
    : 0;
  const belowThreshold = userScores.filter(s => s < threshold).length;

  // Average Quiz Score — reps' latest valid attempt per quiz.
  const repAttempts = (attempts ?? []).filter(a => repIds.has(a.user_id));
  const dedupedScores = [...latestAttemptsByUserQuiz(repAttempts).values()]
    .map(validAttemptScore).filter(s => s != null);
  const avgQuizScore = dedupedScores.length
    ? Math.round(dedupedScores.reduce((s, v) => s + v, 0) / dedupedScores.length)
    : 0;

  // Content Completion — % of ACTIVE REPS with ≥1 lesson completion (numerator
  // counts only rep completers; denominator is the active-rep count).
  const repsWithCompletions = new Set(
    (completions ?? []).map(c => c.profile_id).filter(id => repIds.has(id))
  );
  const completionPct = Math.round((repsWithCompletions.size / activeRepCount) * 100);

  // Active Learners — distinct ACTIVE REPS with qualifying activity in last 30d.
  const activeLearners = new Set(
    (events ?? []).map(e => e.user_id).filter(id => repIds.has(id))
  ).size;

  return {
    overallReadiness,
    avgQuizScore,
    completionPct,
    belowThreshold,
    activeLearners,
    totalMembersScored,
    totalActiveMembers: activeRepCount,
  };
}
