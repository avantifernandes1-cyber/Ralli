/**
 * One-time readiness reconciliation/backfill — SERVER/OPERATIONS ONLY.
 *
 * Recomputes readiness for the ACTIVE SALES REPS of ONE tenant after a formula
 * change (existing readiness_scores rows are old-formula and are not refreshed
 * until each rep next triggers a recompute; the dashboard never recomputes on
 * view). Reuses the SINGLE pure formula (src/lib/readinessFormula.js) — the
 * formula is never duplicated. DB access uses an injected admin client (or the
 * server-only service-role client), never the browser singleton.
 *
 * POPULATION: one shared rule (isReadinessRepRole) — active reps only; org
 * managers and platform admins are EXCLUDED (they must never get a readiness
 * row, which would distort People Insights / Overall Readiness / Below
 * Threshold / coverage). Existing readiness rows for excluded roles are
 * REPORTED, never deleted.
 *
 * SAFETY: tenant-scoped · bounded concurrency · per-user error isolation ·
 * idempotent upsert (retryable) · DRY-RUN by default (reads + computes, writes
 * NOTHING unless { apply:true }). Never logs credentials or full profile data.
 */
import { computeUserReadiness, isReadinessRepRole } from "../src/lib/readinessFormula.js";

/**
 * @param {string} tenantId
 * @param {{ apply?: boolean, concurrency?: number, client?: object }} [opts]
 *   client — inject a Supabase client (tests). Omitted → server service-role client.
 */
export async function reconcileReadiness(tenantId, { apply = false, concurrency = 3, client } = {}) {
  if (!tenantId) return { tenantId, apply, error: new Error("tenantId required"), results: [] };
  const db = client ?? (await import("./supabaseAdmin.mjs")).supabaseAdmin;

  // Population: active profiles, then reps only (shared rule).
  const { data: profiles, error: pErr } = await db
    .from("profiles").select("id, name, role, status")
    .eq("tenant_id", tenantId).neq("status", "inactive");
  if (pErr) return { tenantId, apply, error: pErr, results: [] };
  const reps     = (profiles ?? []).filter(p => isReadinessRepRole(p.role));
  const excluded = (profiles ?? []).filter(p => !isReadinessRepRole(p.role));

  // Existing readiness rows (before) + any rows belonging to excluded roles.
  const { data: existing, error: exErr } = await db
    .from("readiness_scores").select("user_id, score, quiz_score, computed_at")
    .eq("tenant_id", tenantId);
  if (exErr) return { tenantId, apply, error: exErr, results: [] };
  const beforeByUser = new Map((existing ?? []).map(r => [r.user_id, r]));
  const repIds = new Set(reps.map(r => r.id));
  const accidentalExcludedRows = (existing ?? []).filter(r => !repIds.has(r.user_id)).map(r => r.user_id);

  const queue = [...reps];
  const results = [];
  const worker = async () => {
    for (;;) {
      const m = queue.shift();
      if (!m) return;
      const b = beforeByUser.get(m.id) ?? null;
      const before = b ? { score: b.score, quizScore: b.quiz_score, computedAt: b.computed_at } : null;
      try {
        // Reads are GENUINELY executed even in dry-run (proving the whole path).
        const [pe, qa, lc] = await Promise.all([
          db.from("user_point_events").select("source_type, source_id, points, created_at").eq("tenant_id", tenantId).eq("user_id", m.id),
          db.from("quiz_attempts").select("id, quiz_id, score, passed, attempt_num, created_at").eq("tenant_id", tenantId).eq("user_id", m.id),
          db.from("lesson_completions").select("lesson_id, completed_at").eq("tenant_id", tenantId).eq("profile_id", m.id),
        ]);
        const readErr = pe.error ?? qa.error ?? lc.error;
        if (readErr) { results.push({ userId: m.id, before, after: null, applied: false, error: readErr.message ?? String(readErr) }); continue; }

        const perf = computeUserReadiness({ pointEvents: pe.data ?? [], quizAttempts: qa.data ?? [], lessonCompletions: lc.data ?? [] });

        let applied = false, writeError = null;
        if (apply) {
          const { error: wErr } = await db.from("readiness_scores").upsert({
            tenant_id: tenantId, user_id: m.id,
            score: perf.score, learning_score: perf.learningScore, quiz_score: perf.quizScore, game_score: perf.gameScore,
            lessons_completed: perf.lessonsCompleted, courses_completed: perf.coursesCompleted,
            quizzes_passed: perf.quizzesPassed, quizzes_attempted: perf.quizzesAttempted,
            games_played: perf.gamesPlayed, window_days: perf.windowDays, computed_at: new Date().toISOString(),
          }, { onConflict: "tenant_id,user_id" });
          applied = !wErr;
          writeError = wErr ? (wErr.message ?? String(wErr)) : null;
        }
        results.push({ userId: m.id, before, after: { score: perf.score, quizScore: perf.quizScore }, applied, error: writeError });
      } catch (e) {
        results.push({ userId: m.id, before, after: null, applied: false, error: e?.message ?? String(e) });
      }
    }
  };
  const poolSize = Math.max(1, Math.min(concurrency, reps.length || 1));
  await Promise.all(Array.from({ length: poolSize }, worker));

  return {
    tenantId, apply,
    summary: {
      activeReps:            reps.length,
      excludedRoles:         excluded.length,
      repsWithExistingRow:   reps.filter(r => beforeByUser.has(r.id)).length,
      repsMissingRow:        reps.filter(r => !beforeByUser.has(r.id)).length,
      accidentalExcludedRows: accidentalExcludedRows.length, // reported, NEVER deleted
      writes:                results.filter(r => r.applied).length,
      failures:              results.filter(r => r.error).length,
    },
    accidentalExcludedRows, // user_ids only — do NOT delete without approval
    results,
  };
}
