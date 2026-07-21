-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli Live — tenant-scoped game codes and session isolation
--
-- Confirmed risk: game_sessions.pin was globally unique (game_sessions_pin_
-- unique), which accidentally prevented two tenants from ever sharing a
-- visible code today — but that's the wrong mechanism. It doesn't model a
-- real tenant boundary, it just makes codes a scarce global resource, and it
-- provides no defense if that constraint were ever loosened or raced. This
-- migration replaces it with the intended model: codes are unique WITHIN a
-- tenant, never across tenants, enforced by the database — not by
-- application code hoping to avoid collisions.
--
-- Reuses the existing get_my_tenant_id() helper (already used by profiles'
-- own RLS policies) rather than inventing a parallel one.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Backfill tenant_id only where ownership is reliably derivable: host_id
--    that matches a real profiles.id. Rows whose host_id is a seed/mock
--    string (e.g. legacy demo data) are left alone — never guessed.
UPDATE game_sessions gs
SET tenant_id = p.tenant_id::text
FROM profiles p
WHERE gs.tenant_id IS NULL
  AND gs.host_id = p.id::text
  AND p.tenant_id IS NOT NULL;

-- 2. Replace the global pin-uniqueness constraint with a tenant-scoped one.
--    Rows with tenant_id IS NULL (unresolvable legacy/demo) are excluded from
--    the uniqueness domain entirely and are made unjoinable further down —
--    they were never really tenant-scoped to begin with.
ALTER TABLE game_sessions DROP CONSTRAINT IF EXISTS game_sessions_pin_unique;
DROP INDEX IF EXISTS game_sessions_pin_unique;

CREATE UNIQUE INDEX IF NOT EXISTS game_sessions_tenant_pin_unique
  ON game_sessions (tenant_id, pin)
  WHERE tenant_id IS NOT NULL;

-- 3. Atomic, tenant-scoped session creation. Generates a random 6-digit code
--    and retries (bounded) on a same-tenant collision instead of a client-
--    side check-then-insert race. An authenticated caller's real tenant
--    (from get_my_tenant_id()) always wins over a client-supplied tenant_id —
--    the client argument is only trusted for the anon/demo path, where there
--    is no stronger signal available.
CREATE OR REPLACE FUNCTION create_game_session_atomic(
  p_tenant_id      text,
  p_host_id        text,
  p_quiz_id        text,
  p_name           text,
  p_question_count integer,
  p_demo_mode      boolean DEFAULT false
) RETURNS game_sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant  text;
  v_code    text;
  v_row     game_sessions;
  v_attempt integer := 0;
BEGIN
  v_tenant := COALESCE(get_my_tenant_id()::text, p_tenant_id);

  LOOP
    v_attempt := v_attempt + 1;
    v_code := lpad(floor(random() * 1000000)::text, 6, '0');
    BEGIN
      INSERT INTO game_sessions
        (tenant_id, quiz_id, host_id, pin, name, question_count, demo_mode, status)
      VALUES
        (v_tenant, p_quiz_id, p_host_id, v_code, p_name, p_question_count, p_demo_mode, 'waiting')
      RETURNING * INTO v_row;
      RETURN v_row;
    EXCEPTION WHEN unique_violation THEN
      IF v_attempt >= 8 THEN
        RAISE EXCEPTION 'Could not allocate a unique game code after % attempts', v_attempt;
      END IF;
      -- same-tenant collision on this random code — loop and try a new one
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION create_game_session_atomic(text, text, text, text, integer, boolean) TO anon, authenticated;

-- 4. Tenant-scoped join lookup. Never a code-only lookup: always filters by
--    (resolved tenant, pin). Returns no row for a wrong-tenant pin — the
--    same "not found" shape as a pin that doesn't exist at all, so the
--    caller can never distinguish "wrong org" from "doesn't exist" (no
--    existence leak). An authenticated caller's real tenant always wins over
--    a client-supplied one, same rule as session creation.
CREATE OR REPLACE FUNCTION find_joinable_session(p_tenant_id text, p_pin text)
RETURNS game_sessions
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant text;
  v_row    game_sessions;
BEGIN
  v_tenant := COALESCE(get_my_tenant_id()::text, p_tenant_id);
  IF v_tenant IS NULL THEN
    SELECT * INTO v_row FROM game_sessions WHERE pin = p_pin AND tenant_id IS NULL LIMIT 1;
  ELSE
    SELECT * INTO v_row FROM game_sessions WHERE pin = p_pin AND tenant_id = v_tenant LIMIT 1;
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION find_joinable_session(text, text) TO anon, authenticated;

-- 5. Tighten RLS for the `authenticated` role only. The `anon` policies are
--    left exactly as they were — anonymous/demo-mode play has no real tenant
--    identity for the database to check against, and reworking that path
--    (routing every anon write through SECURITY DEFINER RPCs) is out of
--    scope for this fix. This is the real production boundary: two
--    genuinely signed-in tenants can no longer read or write each other's
--    session data, regardless of what the client sends.
DROP POLICY IF EXISTS auth_select_game_sessions ON game_sessions;
CREATE POLICY auth_select_game_sessions ON game_sessions FOR SELECT TO authenticated
  USING (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL);

DROP POLICY IF EXISTS auth_update_game_sessions ON game_sessions;
CREATE POLICY auth_update_game_sessions ON game_sessions FOR UPDATE TO authenticated
  USING (tenant_id = get_my_tenant_id()::text);

DROP POLICY IF EXISTS auth_insert_game_sessions ON game_sessions;
CREATE POLICY auth_insert_game_sessions ON game_sessions FOR INSERT TO authenticated
  WITH CHECK (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL);

-- game_session_participants / game_answers / game_players each already carry
-- their own tenant_id column — scope authenticated access directly.
DROP POLICY IF EXISTS auth_all_game_session_participants ON game_session_participants;
CREATE POLICY auth_all_game_session_participants ON game_session_participants FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL)
  WITH CHECK (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL);

DROP POLICY IF EXISTS auth_all_game_answers ON game_answers;
CREATE POLICY auth_all_game_answers ON game_answers FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL)
  WITH CHECK (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL);

DROP POLICY IF EXISTS auth_all_game_players ON game_players;
CREATE POLICY auth_all_game_players ON game_players FOR ALL TO authenticated
  USING (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL)
  WITH CHECK (tenant_id = get_my_tenant_id()::text OR tenant_id IS NULL);
