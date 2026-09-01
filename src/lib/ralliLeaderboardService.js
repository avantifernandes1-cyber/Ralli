/**
 * Ralli Live Leaderboard Service
 *
 * The single client entry point for the prospective, server-authoritative Ralli Live
 * leaderboard (migration 085). Every ranking number comes from the SECURITY DEFINER
 * RPCs — this module NEVER computes accuracy, denominators, eligibility, or ranks on the
 * client. It only:
 *   - computes the timeframe boundaries (half-open [from, to) in the org timezone), and
 *   - forwards those to the aggregate-only RPCs, returning { data, error } verbatim.
 *
 * Confidentiality: the RPCs return aggregates only (no answer text, correct-answer keys,
 * snapshots, or grading material). This module adds nothing and strips nothing.
 *
 * Error handling contract (see leaderboard UI states): a service/RPC error is returned as
 * { data: null, error } — it is NEVER swallowed into an empty result. "No rankable data"
 * is a legitimate success ([] / enough_data:false rows), distinct from an error.
 */

import { supabase } from "./supabase.js";
import { TIMEFRAMES, DEFAULT_TIMEFRAME, computeTimeframeRange } from "./ralliLeaderboardTimeframe.js";

// Re-export the pure timeframe model so callers have one leaderboard import surface.
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

// ── Leaderboard reads ────────────────────────────────────────────────────────
// Individuals across the org (teamId optional: scope to one team for a drill-down list).
export async function getIndividualLeaderboard({ from, to, teamId = null }) {
  const { data, error } = await supabase.rpc("rpc_ralli_leaderboard_individuals", {
    p_from: from, p_to: to, p_team_id: teamId,
  });
  return { data: data ?? null, error };
}

// Aggregated team standings across the org.
export async function getTeamLeaderboard({ from, to }) {
  const { data, error } = await supabase.rpc("rpc_ralli_leaderboard_teams", {
    p_from: from, p_to: to,
  });
  return { data: data ?? null, error };
}

// Members of one team (learners: own team only; managers: any same-tenant team).
export async function getTeamMembers({ teamId, from, to }) {
  const { data, error } = await supabase.rpc("rpc_ralli_team_members", {
    p_team_id: teamId, p_from: from, p_to: to,
  });
  return { data: data ?? null, error };
}

// Convenience: resolve a timeframe id against the org tz, then fetch individuals.
export async function loadIndividuals(timeframeId, tz, { teamId = null, now } = {}) {
  const { fromISO, toISO } = computeTimeframeRange(timeframeId, tz, now);
  return getIndividualLeaderboard({ from: fromISO, to: toISO, teamId });
}
export async function loadTeams(timeframeId, tz, { now } = {}) {
  const { fromISO, toISO } = computeTimeframeRange(timeframeId, tz, now);
  return getTeamLeaderboard({ from: fromISO, to: toISO });
}
export async function loadTeamMembers(timeframeId, tz, teamId, { now } = {}) {
  const { fromISO, toISO } = computeTimeframeRange(timeframeId, tz, now);
  return getTeamMembers({ teamId, from: fromISO, to: toISO });
}
