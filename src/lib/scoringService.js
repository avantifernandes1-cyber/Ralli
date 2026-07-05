/**
 * Ralli Centralized Scoring Engine
 *
 * Single source of truth for all XP / point awards across:
 *   - Lessons and courses (learning)
 *   - Quizzes (knowledge checks)
 *   - Live games (competitive play)
 *
 * All awards are persisted as immutable rows in `user_point_events`.
 * The leaderboard is aggregated from that table — never from hardcoded state.
 *
 * Usage:
 *   import { awardLessonPoints, awardQuizPoints, awardGamePointsForSession, getLeaderboard } from "./scoringService.js";
 */

import { supabase } from "./supabase.js";

// ── Scoring rubric ────────────────────────────────────────────────────────────
// Change values here to adjust rewards everywhere in the product.

export const SCORING = {
  lesson: {
    completed:  25,   // base XP for completing any lesson
    earlyBonus: 10,   // bonus for completing before due date
  },
  course: {
    completed:  100,  // base XP for completing all lessons in a course
    earlyBonus: 10,   // bonus for completing before due date
  },
  quiz: {
    completed:    25, // base XP — quiz submitted regardless of outcome
    passed:       75, // additional XP — score >= passingScore (default 90%)
    perfect:      25, // bonus — score === 100
    retakePassed: 40, // replaces `passed` when it's a retake (attempt > 0)
    failed:        0, // no XP for failing
    passingScore:  90,// default passing threshold (%)
  },
  game: {
    perQuestion: {
      correct:     100, // points per correct answer
      speedBonus:   50, // max speed bonus per question (applied by game engine)
    },
    participate:  25,   // participation XP — every player who finishes a game
    placement: {
      1: 100,           // 1st place bonus
      2:  75,           // 2nd place bonus
      3:  50,           // 3rd place bonus
    },
  },
};

// ── Internal: write a single point event ─────────────────────────────────────

/**
 * Write a single point event to user_point_events.
 * All other award functions call this internally.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {'lesson'|'course'|'quiz'|'game'|'bonus'} sourceType
 * @param {string} sourceId  — PK of the originating entity
 * @param {number} points    — must be > 0
 * @param {string} reason    — human-readable label
 */
export async function awardPoints(tenantId, userId, sourceType, sourceId, points, reason) {
  if (!tenantId || !userId || points <= 0) return { error: null };
  const { error } = await supabase.from("user_point_events").insert({
    tenant_id:   tenantId,
    user_id:     userId,
    source_type: sourceType,
    source_id:   String(sourceId),
    points,
    reason,
  });
  // 23505 = unique_violation — idx_upe_lesson_course_dedup caught a duplicate lesson/course award.
  // This is intentional idempotency: silently succeed so callers never see a spurious error.
  // Quiz retakes are unaffected — the partial index only covers source_type IN ('lesson','course').
  if (error?.code === "23505") return { error: null };
  if (error) console.error("[ralli] awardPoints failed:", { sourceType, sourceId, points, reason, error });
  return { error };
}

// ── Lesson completion ─────────────────────────────────────────────────────────

/**
 * Award XP when a user completes a lesson.
 * +25 base, +10 if completed before dueAt.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} lessonId
 * @param {{ dueAt?: string|null }} [opts]
 */
export async function awardLessonPoints(tenantId, userId, lessonId, { dueAt } = {}) {
  await awardPoints(tenantId, userId, "lesson", lessonId, SCORING.lesson.completed, "Lesson completed");
  if (dueAt && dueAt !== "Open" && new Date() <= new Date(dueAt)) {
    await awardPoints(tenantId, userId, "bonus", lessonId, SCORING.lesson.earlyBonus, "Completed before due date");
  }
}

// ── Course completion ─────────────────────────────────────────────────────────

/**
 * Award XP when a user completes all lessons in a course.
 * +100 base, +10 if completed before dueAt.
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} courseId
 * @param {{ dueAt?: string|null }} [opts]
 */
export async function awardCoursePoints(tenantId, userId, courseId, { dueAt } = {}) {
  await awardPoints(tenantId, userId, "course", courseId, SCORING.course.completed, "Course completed");
  if (dueAt && dueAt !== "Open" && new Date() <= new Date(dueAt)) {
    await awardPoints(tenantId, userId, "bonus", courseId, SCORING.course.earlyBonus, "Course completed before due date");
  }
}

// ── Quiz completion ───────────────────────────────────────────────────────────

/**
 * Award XP when a user completes a quiz attempt.
 * - Always: +25 completed XP
 * - If passed (score >= passingScore):
 *     First attempt: +75 passed XP
 *     Retake:        +40 retake passed XP
 * - Perfect score (100%): +25 bonus XP
 * - Failed: +0 additional (only base 25 for completion)
 *
 * @param {string} tenantId
 * @param {string} userId
 * @param {string} quizId
 * @param {{ score: number, passed: boolean }} attempt
 * @param {{ isRetake?: boolean, passingScore?: number }} [opts]
 */
export async function awardQuizPoints(tenantId, userId, quizId, attempt, { isRetake = false, passingScore = SCORING.quiz.passingScore } = {}) {
  const { score } = attempt;
  const passed = score >= passingScore;

  // Base completion award (always)
  await awardPoints(tenantId, userId, "quiz", quizId, SCORING.quiz.completed, "Quiz completed");

  if (!passed) return; // no further awards for failed attempts

  if (isRetake) {
    await awardPoints(tenantId, userId, "quiz", quizId, SCORING.quiz.retakePassed, "Quiz passed on retake");
  } else {
    await awardPoints(tenantId, userId, "quiz", quizId, SCORING.quiz.passed, "Quiz passed");
  }

  if (score === 100) {
    await awardPoints(tenantId, userId, "bonus", quizId, SCORING.quiz.perfect, "Perfect score");
  }
}

// ── Game completion ───────────────────────────────────────────────────────────

/**
 * Award XP/points after a live game session ends.
 * Called once per session, for all players.
 *
 * Looks up game_session_participants for this session (by pin) to resolve
 * player_id (Supabase user ID) from the name in the scores array.
 *
 * Awards per player:
 *   - +25 participation XP
 *   - game score points (the live game accumulates these per-question)
 *   - placement bonus (+100 / +75 / +50 for 1st–3rd)
 *
 * @param {string}  tenantId
 * @param {string}  sessionPin   — the 6-digit lobby PIN
 * @param {Array<{ name: string, score: number, rank?: number }>} scores
 */
export async function awardGamePointsForSession(tenantId, sessionPin, scores) {
  if (!tenantId || !sessionPin || !scores?.length) return;

  // 1. Find the session DB record by pin
  const { data: session, error: sessionError } = await supabase
    .from("game_sessions")
    .select("id")
    .eq("pin", String(sessionPin))
    .maybeSingle();

  if (sessionError || !session) {
    console.error("[ralli] awardGamePointsForSession: session not found for pin", sessionPin, sessionError);
    return;
  }

  // 2. Load participants (includes player_id = auth user id)
  const { data: participants, error: participantsError } = await supabase
    .from("game_session_participants")
    .select("player_id, name")
    .eq("session_id", session.id);

  if (participantsError || !participants?.length) {
    console.error("[ralli] awardGamePointsForSession: no participants found", participantsError);
    return;
  }

  // 3. Build name → player_id map
  const nameToUserId = {};
  for (const p of participants) {
    if (p.player_id && p.name) nameToUserId[p.name.toLowerCase()] = p.player_id;
  }

  // 4. Award points for each player in the scores array
  const rankedScores = [...scores].sort((a, b) => b.score - a.score).map((s, i) => ({ ...s, rank: i + 1 }));

  for (const player of rankedScores) {
    const userId = nameToUserId[player.name?.toLowerCase()];
    if (!userId) continue; // guest or unmatched player — skip

    // Participation bonus (everyone)
    await awardPoints(tenantId, userId, "game", sessionPin, SCORING.game.participate, "Participated in live game");

    // Game score (raw points accumulated during gameplay — per question correct + speed bonuses)
    if (player.score > 0) {
      await awardPoints(tenantId, userId, "game", sessionPin, player.score, "Live game score");
    }

    // Placement bonus (top 3 only)
    const placementBonus = SCORING.game.placement[player.rank];
    if (placementBonus) {
      const placeLabel = player.rank === 1 ? "1st" : player.rank === 2 ? "2nd" : "3rd";
      await awardPoints(tenantId, userId, "bonus", sessionPin, placementBonus, `Game placement: ${placeLabel} place`);
    }
  }
}

// ── Leaderboard aggregation ───────────────────────────────────────────────────

/**
 * Aggregate all point events for a tenant into a ranked leaderboard.
 *
 * Returns an array sorted by total points descending, with:
 *   rank, userId, name, initials, total, quizPoints, gamePoints, learningXp,
 *   gamesPlayed, quizzesCompleted, lessonsCompleted, isMe
 *
 * @param {string} tenantId
 * @param {string} [currentUserId]  — used to mark the current user's row
 * @returns {Promise<{ data: Array, error: object|null }>}
 */
export async function getLeaderboard(tenantId, currentUserId = null) {
  if (!tenantId) return { data: [], error: null };

  // Fetch all point events for the tenant
  const { data: events, error: eventsError } = await supabase
    .from("user_point_events")
    .select("user_id, source_type, source_id, points")
    .eq("tenant_id", tenantId);

  if (eventsError) return { data: [], error: eventsError };
  if (!events?.length) return { data: [], error: null };

  // Fetch tenant member profiles
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id, full_name, email")
    .eq("tenant_id", tenantId);

  if (profilesError) return { data: [], error: profilesError };

  const profileMap = {};
  for (const p of profiles) profileMap[p.id] = p;

  // Aggregate per user
  const userMap = {};
  for (const e of events) {
    if (!userMap[e.user_id]) {
      userMap[e.user_id] = {
        userId:             e.user_id,
        total:              0,
        quizPoints:         0,
        gamePoints:         0,
        learningXp:         0,
        bonusPoints:        0,
        gamesPlayed:        new Set(),
        quizzesCompleted:   new Set(),
        lessonsCompleted:   new Set(),
      };
    }
    const u = userMap[e.user_id];
    u.total += e.points;

    switch (e.source_type) {
      case "lesson":
        u.learningXp += e.points;
        u.lessonsCompleted.add(e.source_id);
        break;
      case "course":
        u.learningXp += e.points;
        break;
      case "quiz":
        u.quizPoints += e.points;
        u.quizzesCompleted.add(e.source_id);
        break;
      case "game":
        u.gamePoints += e.points;
        u.gamesPlayed.add(e.source_id);
        break;
      case "bonus":
        // Bonus points are included in total only (not double-counted in sub-categories)
        u.bonusPoints += e.points;
        break;
    }
  }

  // Merge with profiles, sort, assign rank
  const rows = Object.values(userMap)
    .filter(u => profileMap[u.userId])
    .map(u => {
      const p = profileMap[u.userId];
      const displayName = p.full_name || p.email || "Unknown";
      const initials = displayName
        .split(" ")
        .map(w => w[0] ?? "")
        .join("")
        .slice(0, 2)
        .toUpperCase();
      return {
        userId:           u.userId,
        name:             displayName,
        initials,
        total:            u.total,
        quizPoints:       u.quizPoints,
        gamePoints:       u.gamePoints,
        learningXp:       u.learningXp,
        bonusPoints:      u.bonusPoints,
        gamesPlayed:      u.gamesPlayed.size,
        quizzesCompleted: u.quizzesCompleted.size,
        lessonsCompleted: u.lessonsCompleted.size,
        isMe:             u.userId === currentUserId,
      };
    })
    .sort((a, b) => b.total - a.total)
    .map((u, i) => ({ ...u, rank: i + 1 }));

  return { data: rows, error: null };
}

// ── USER META HELPERS ────────────────────────────────────────────────────────

/**
 * Derive level + xpNext from a raw XP total.
 * Level thresholds: Level 1 = 0–999, Level 2 = 1000–1999, etc.
 * Pure function — safe to call anywhere without side effects.
 */
export function computeUserMeta(xp = 0) {
  const level = Math.floor(xp / 1000) + 1;
  const xpNext = level * 1000;
  return { level, xpNext };
}

/**
 * Compute consecutive-day streak for a user from user_point_events.
 * A streak counts backward from today (or yesterday if today has no activity yet).
 * Returns 0 if there are no events or the most recent event is older than yesterday.
 */
export async function getUserStreak(tenantId, userId) {
  if (!tenantId || !userId) return 0;
  const { data, error } = await supabase
    .from("user_point_events")
    .select("created_at")
    .eq("tenant_id", tenantId)
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error || !data?.length) return 0;

  // Unique UTC day strings, newest first
  const days = [...new Set(data.map(e => e.created_at.slice(0, 10)))].sort().reverse();

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // Streak must begin today or yesterday
  if (days[0] !== today && days[0] !== yesterday) return 0;

  let streak = 1;
  for (let i = 1; i < days.length; i++) {
    const diffMs  = new Date(days[i - 1]) - new Date(days[i]);
    const diffDay = diffMs / 86_400_000;
    if (diffDay === 1) streak++;
    else break;
  }
  return streak;
}
