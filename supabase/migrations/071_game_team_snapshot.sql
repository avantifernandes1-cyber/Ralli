-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 071: Ralli Live team-at-game-time snapshot (trust foundation)
--
-- Additive and production-safe. Touches ONLY Ralli Live (game_players); does not
-- edit any prior migration or any other product area.
--
-- WHY
--   A future team leaderboard must rank a player under the team they were on
--   WHEN THEY PLAYED. Today no game table stores team identity, so team reporting
--   could only use the player's CURRENT profile.team_id — which rewrites history
--   when a player transfers teams. This migration captures the smallest additive,
--   immutable snapshot so team rankings can be built later without rewriting the
--   past. (The leaderboard read source + UI are deferred — see
--   docs/engineering/071_LEADERBOARD_DESIGN.md — pending the server-authoritative
--   grading decision.)
--
-- CANONICAL OWNER: game_players
--   game_players is the per-player, one-row-per-completed-session result row (the
--   leaderboard's unit) and is written once at game end — the defined game-time
--   event. game_session_participants is mutable lobby presence (join/heartbeat/
--   leave) and a participant may never become a scored player, so it is NOT the
--   snapshot owner. One canonical snapshot, no duplicate ownership.
--
-- GUARANTEES
--   - Stamped SERVER-SIDE from the player_id's CURRENT same-tenant profile at the
--     moment the game_players row is inserted (game end). Any client-supplied
--     team_id/team_name is ignored/overwritten.
--   - IMMUTABLE after capture: UPDATEs preserve the original snapshot, so a later
--     team transfer (profile.team_id change) never rewrites a historical game.
--   - NULL for guests, name-based/unlinked player_ids, players with no team, and
--     cross-tenant/anonymous rows (tenant-validated) — never guessed.
--   - NO historical backfill: existing rows keep team_id = NULL.
--   - Additive only: two nullable columns + one BEFORE trigger. No column drop,
--     no policy/grant/data change. RLS (046/047) unchanged and still governs reads.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Additive snapshot columns ────────────────────────────────────────────────
ALTER TABLE public.game_players
  ADD COLUMN IF NOT EXISTS team_id   uuid,
  ADD COLUMN IF NOT EXISTS team_name text;

COMMENT ON COLUMN public.game_players.team_id IS
  'Immutable snapshot of the player''s team at game-end, stamped server-side from their same-tenant profile (071). NULL for guests / no-team / cross-tenant. Never backfilled; team transfers do not rewrite it.';
COMMENT ON COLUMN public.game_players.team_name IS
  'Display-name snapshot of team_id at game-end (071). Frozen with team_id; a later team rename does not rewrite historical games.';

-- ── 2. Server-authoritative stamp trigger ───────────────────────────────────────
-- SECURITY DEFINER so it can read the (RLS-protected) profiles of every player in
-- the row set regardless of which host inserted them; it only reads team_id + the
-- team's display name and only for a profile in the SAME tenant as the game row.
CREATE OR REPLACE FUNCTION public.game_players_stamp_team()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_team_id   uuid;
  v_team_name text;
BEGIN
  IF (TG_OP = 'UPDATE') THEN
    -- Freeze ONLY the team snapshot (team_id, team_name). This is NOT a whole-row
    -- freeze: we never do `NEW := OLD`. Every other column in NEW — final_score,
    -- final_rank, accuracy, name, emoji, color, and any future game_players field
    -- — passes through UNCHANGED, so legitimate result/display updates are never
    -- discarded. Team transfers / renames after the game therefore cannot rewrite
    -- the captured snapshot, while all other edits proceed normally.
    NEW.team_id   := OLD.team_id;
    NEW.team_name := OLD.team_name;
    RETURN NEW;
  END IF;

  -- INSERT: derive from the player's CURRENT same-tenant profile. Ignore any
  -- client-supplied team_id/team_name. Guests / name-based ids / cross-tenant
  -- player_ids match no same-tenant profile and are left NULL (never guessed).
  IF NEW.tenant_id IS NOT NULL AND btrim(NEW.tenant_id) <> '' THEN
    SELECT p.team_id INTO v_team_id
    FROM public.profiles p
    WHERE p.id::text = NEW.player_id
      AND p.tenant_id::text = NEW.tenant_id
    LIMIT 1;

    IF v_team_id IS NOT NULL THEN
      SELECT t.name INTO v_team_name
      FROM public.tenant_teams t
      WHERE t.id = v_team_id
        AND t.tenant_id::text = NEW.tenant_id
      LIMIT 1;
      -- team must be a valid same-tenant team; otherwise record no snapshot
      IF v_team_name IS NULL THEN
        v_team_id := NULL;
      END IF;
    END IF;
  END IF;

  NEW.team_id   := v_team_id;    -- NULL for guest / no team / cross-tenant / no tenant
  NEW.team_name := v_team_name;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.game_players_stamp_team() IS
  'BEFORE INSERT/UPDATE on game_players: stamps team_id/team_name from the player_id''s same-tenant profile at insert (server-authoritative, client value ignored); preserves them on UPDATE (immutable snapshot). NULL for guests/no-team/cross-tenant.';

DROP TRIGGER IF EXISTS trg_game_players_stamp_team ON public.game_players;
CREATE TRIGGER trg_game_players_stamp_team
  BEFORE INSERT OR UPDATE ON public.game_players
  FOR EACH ROW EXECUTE FUNCTION public.game_players_stamp_team();

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (read-only):
--   \d+ public.game_players   → team_id uuid, team_name text present
--   SELECT tgname FROM pg_trigger WHERE tgrelid='public.game_players'::regclass;
-- Existing rows keep team_id = NULL (no backfill). Leaderboard team views remain
-- deferred until the server-authoritative grading decision (071 design doc).
-- ─────────────────────────────────────────────────────────────────────────────
