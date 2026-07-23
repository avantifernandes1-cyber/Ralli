/**
 * Readiness formula — PURE calculation, ZERO database/client access.
 *
 * Extracted from insightsService.js so the exact same formula can be reused by:
 *   - the browser service (insightsService.getUserPerformance), and
 *   - the server-only reconciliation tool (server/reconcileReadiness.mjs),
 * WITHOUT importing the browser Supabase singleton into Node (which reads
 * import.meta.env and crashes) and WITHOUT duplicating the formula.
 *
 * This module imports nothing with side effects — safe to import from both the
 * Vite app bundle and a plain Node process. It performs NO I/O.
 */

import { ROLES } from "../data/schema.js";

// ── Scoring weights (must sum to 1.0) ─────────────────────────────────────────
export const WEIGHTS = { learning: 0.35, quiz: 0.40, game: 0.25 };

export const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
export const pctScore = (num, den) => (den > 0 ? Math.round((num / den) * 100) : 0);

// ── Canonical readiness population (shared by dashboard AND backfill) ─────────
// Readiness / rep-performance metrics describe active SALES REPS — not org
// managers/admins or platform admins. Matches the existing assignment-targeting
// exclusion. ONE rule, used everywhere, so the dashboard and the backfill can
// never disagree about who counts.
export const READINESS_EXCLUDED_ROLES = new Set([
  ROLES.ORG_ADMIN,     // "orgAdmin" — manager/admin
  ROLES.RALLI_ADMIN,   // "ralli_admin" — platform admin
  ROLES.SUPERADMIN,    // "superadmin" — legacy platform-admin alias
]);
export function isReadinessRepRole(role) {
  return !READINESS_EXCLUDED_ROLES.has(role);
}

// ── Latest-attempt resolver (deterministic) ───────────────────────────────────
function attemptTimeMs(a) {
  const t = a?.created_at ? Date.parse(a.created_at) : 0;
  return Number.isFinite(t) ? t : 0; // malformed/missing created_at → 0, never NaN
}
function isNewerAttempt(a, prev) {
  const at = attemptTimeMs(a), pt = attemptTimeMs(prev);
  if (at !== pt) return at > pt;
  const an = a?.attempt_num ?? -Infinity, pn = prev?.attempt_num ?? -Infinity;
  if (an !== pn) return an > pn;
  return String(a?.id ?? "") > String(prev?.id ?? ""); // final deterministic tiebreak (never DB array order)
}
export function latestAttemptsByUserQuiz(attempts) {
  const byKey = new Map();
  for (const a of (attempts ?? [])) {
    if (a?.quiz_id == null) continue;
    const key = `${a.user_id ?? ""}::${a.quiz_id}`;
    const prev = byKey.get(key);
    if (!prev || isNewerAttempt(a, prev)) byKey.set(key, a);
  }
  return byKey;
}

// ── Strict score validation ───────────────────────────────────────────────────
// A VALID readiness score, else null. Valid = a finite value in [0, 100] that
// represents the WHOLE input:
//   - number: finite and in range.
//   - string: trimmed, nonempty, matching a strict plain-decimal grammar (no
//     trailing junk like "50abc", no hex, no scientific notation), then in range.
//   - anything else (boolean, array, object, null, undefined) → null.
// Never coerced to 0; out-of-range is NOT clamped. parseFloat is deliberately
// NOT used (parseFloat("50abc") === 50 would accept partial garbage).
const STRICT_DECIMAL = /^[+-]?(\d+(\.\d+)?|\.\d+)$/; // no exponent, no hex, no trailing chars
export function validAttemptScore(a) {
  const raw = a?.score;
  let n;
  if (typeof raw === "number") {
    n = raw;
  } else if (typeof raw === "string") {
    const t = raw.trim();
    if (t === "" || !STRICT_DECIMAL.test(t)) return null; // empty/whitespace/"50abc"/hex/1e2
    n = Number(t);
  } else {
    return null; // boolean / array / object / null / undefined
  }
  if (!Number.isFinite(n)) return null;
  if (n < 0 || n > 100) return null;
  return n;
}

// ── Composite readiness (pure) ────────────────────────────────────────────────
/**
 * Compute a user's readiness facts from already-fetched rows. No I/O.
 * @param {{ pointEvents?: Array, quizAttempts?: Array, lessonCompletions?: Array,
 *           windowDays?: number, now?: number }} input
 * @returns {Object} the readiness data (same shape getUserPerformance returns,
 *   minus userId/tenantId which the caller adds), plus `invalidLatest` for logging.
 */
export function computeUserReadiness({ pointEvents = [], quizAttempts = [], lessonCompletions = [], windowDays = 30, now = Date.now() } = {}) {
  const since = new Date(now - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const events = pointEvents ?? [];
  const recentEvents = events.filter(e => e.created_at >= since);
  const totalXp = events.reduce((s, e) => s + e.points, 0);
  const recentXp = recentEvents.reduce((s, e) => s + e.points, 0);

  const lessonsCompletedIds = new Set(events.filter(e => e.source_type === "lesson").map(e => e.source_id));
  const coursesCompletedIds = new Set(events.filter(e => e.source_type === "course").map(e => e.source_id));
  const gamesPlayedIds      = new Set(events.filter(e => e.source_type === "game").map(e => e.source_id));

  const attempts = quizAttempts ?? [];
  const totalAttempts = attempts.length;                          // FULL history
  const latestAttempts = [...latestAttemptsByUserQuiz(attempts).values()];
  const distinctQuizzesEngaged = latestAttempts.length;
  const validLatest   = latestAttempts.filter(a => validAttemptScore(a) != null);
  const invalidLatest = latestAttempts.filter(a => validAttemptScore(a) == null);
  const uniqueQuizzesAttempted = validLatest.length;              // readiness-contributing
  const uniqueQuizzesPassed    = validLatest.filter(a => a.passed).length;
  const latestValidScores      = validLatest.map(validAttemptScore);
  const avgQuizScore = latestValidScores.length
    ? Math.round(latestValidScores.reduce((s, v) => s + v, 0) / latestValidScores.length)
    : 0;
  const passRate = pctScore(uniqueQuizzesPassed, uniqueQuizzesAttempted);

  // Learning score: XP/completion-count PROXY (not comprehension), with fixed
  // lifetime caps (10 lessons, 3 courses) — not tied to assigned content.
  const learningScore = clamp((lessonsCompletedIds.size / 10) * 60 + (coursesCompletedIds.size / 3) * 40);
  const quizScore = clamp(passRate * 0.6 + avgQuizScore * 0.4);
  // Game (Ralli Live) score: participation + an XP PROXY — NOT direct answer
  // accuracy (direct accuracy lives in game_answers.is_correct and is not used
  // here). Note: point events with source_type='game' are not currently emitted,
  // so gameXp/gamesPlayed are typically 0 → this component contributes ~0 for
  // real tenants today. (See the "Broaden the Readiness Score" design audit.)
  const gameXp = events.filter(e => e.source_type === "game").reduce((s, e) => s + e.points, 0);
  const gameParticipation = gamesPlayedIds.size;
  const gameScore = gameParticipation > 0
    ? clamp((gameParticipation / 5) * 60 + Math.min(gameXp / 1000, 1) * 40)
    : 0;
  const score = clamp(learningScore * WEIGHTS.learning + quizScore * WEIGHTS.quiz + gameScore * WEIGHTS.game);

  return {
    windowDays, score, learningScore, quizScore, gameScore, totalXp, recentXp,
    lessonsCompleted: lessonsCompletedIds.size,
    coursesCompleted: coursesCompletedIds.size,
    gamesPlayed:      gameParticipation,
    quizzesAttempted: uniqueQuizzesAttempted,
    quizzesPassed:    uniqueQuizzesPassed,
    avgQuizScore, passRate,
    totalQuizAttempts: totalAttempts,
    distinctQuizzesEngaged,
    invalidLatestQuizzes: invalidLatest.length,
    invalidLatest, // caller may log (quizId/attemptId); not persisted
    recentQuizAttempts: attempts.filter(a => a.created_at >= since),
    weakQuizzes: validLatest.filter(a => !a.passed),
    computedAt: new Date(now).toISOString(),
  };
}
