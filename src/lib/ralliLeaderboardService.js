/**
 * Ralli Live Leaderboard Service
 *
 * The single client entry point for the prospective, server-authoritative Ralli Live
 * leaderboard (migration 085). Every ranking number AND every timeframe boundary comes from
 * the SECURITY DEFINER RPCs — this module NEVER computes accuracy, denominators, eligibility,
 * ranks, or query windows on the client. It only:
 *   - sends the SELECTED TIMEFRAME ENUM (never arbitrary dates), and
 *   - returns the aggregate-only RPC payload verbatim.
 * The server derives the tenant + its timezone, computes the exact half-open [from, to) window,
 * rejects unsupported enums, and returns { timeframe, from, to, timezone, rows } so the UI can
 * show the resolved window honestly. A client cannot widen or manipulate the period.
 *
 * The pure timeframe model (TIMEFRAMES / computeTimeframeRange) is re-exported for LABELS and
 * tests only — it is NOT the authority for production queries (the server is).
 *
 * Confidentiality: the RPCs return aggregates only (no answer text, correct-answer keys,
 * snapshots, or grading material). This module adds nothing and strips nothing.
 *
 * Error handling contract (see leaderboard UI states): a service/RPC error is returned as
 * { data: null, error } — it is NEVER swallowed into an empty result. "No rankable data"
 * is a legitimate success (rows: [] / enough_data:false), distinct from an error.
 */

import { supabase } from "./supabase.js";
import { TIMEFRAMES, DEFAULT_TIMEFRAME, computeTimeframeRange } from "./ralliLeaderboardTimeframe.js";

// Re-export the pure timeframe model (labels/tests only — the server owns production windows).
export { TIMEFRAMES, DEFAULT_TIMEFRAME, computeTimeframeRange };

// ── Organization timezone ────────────────────────────────────────────────────
export async function getOrgTimezone() {
  const { data, error } = await supabase.rpc("rpc_get_org_timezone");
  return { data: data ?? null, error };
}

// Manager / orgAdmin only (enforced server-side). Learners receive a privilege error.
export async function setOrgTimezone(tz) {
  const { data, error } = await supabase.rpc("rpc_set_org_timezone", { p_tz: tz });
  return { data: data ?? null, error };
}

// ── Leaderboard reads (server sends back { timeframe, from, to, timezone, rows }) ─────
// The client passes ONLY the approved timeframe enum. Team id (optional) scopes individuals to a
// team; the server enforces that a learner may only pass their own team.
export async function loadIndividuals(timeframe, { teamId = null } = {}) {
  const { data, error } = await supabase.rpc("rpc_ralli_leaderboard_individuals", {
    p_timeframe: timeframe, p_team_id: teamId,
  });
  return { data: data ?? null, error };
}

export async function loadTeams(timeframe) {
  const { data, error } = await supabase.rpc("rpc_ralli_leaderboard_teams", {
    p_timeframe: timeframe,
  });
  return { data: data ?? null, error };
}

// Members of one team (learners: own team only; managers: any same-tenant team).
export async function loadTeamMembers(timeframe, teamId) {
  const { data, error } = await supabase.rpc("rpc_ralli_team_members", {
    p_team_id: teamId, p_timeframe: timeframe,
  });
  return { data: data ?? null, error };
}
