-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli Live — restrict anon (demo-mode) RLS to genuine demo rows only
--
-- Migration 046 tenant-scoped the `authenticated` policies but explicitly
-- left `anon` wide open (qual/with_check = true), reasoning that
-- anonymous/demo-mode traffic had no real tenant identity to check. That's
-- true, but "no identity to check" should mean "anon only ever touches rows
-- with no tenant" (tenant_id IS NULL) — not "anon can touch everything".
-- Left wide open, anon was an unrestricted backdoor into every real tenant's
-- session data, participants, answers, and scores, regardless of how well
-- the `authenticated` policies were locked down. This migration closes that.
--
-- After this migration:
--   - authenticated: only rows where tenant_id = get_my_tenant_id() (or
--     legacy NULL — unchanged from migration 046).
--   - anon: only rows where tenant_id IS NULL — genuine demo data, never a
--     real tenant's.
--
-- This also means anon/demo-mode session creation and joins can no longer
-- smuggle a non-null tenant_id through as a client-supplied RPC argument —
-- create_game_session_atomic and find_joinable_session now derive tenant
-- scope EXCLUSIVELY from get_my_tenant_id() (NULL when not authenticated),
-- never from the p_tenant_id argument. That argument is kept in the
-- signature for backward compatibility with existing call sites but is no
-- longer used for any authorization decision.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. game_sessions — anon restricted to tenant_id IS NULL for every command.
DROP POLICY IF EXISTS anon_read_game_sessions ON game_sessions;
CREATE POLICY anon_read_game_sessions ON game_sessions FOR SELECT TO anon
  USING (tenant_id IS NULL);

DROP POLICY IF EXISTS anon_insert_game_sessions ON game_sessions;
CREATE POLICY anon_insert_game_sessions ON game_sessions FOR INSERT TO anon
  WITH CHECK (tenant_id IS NULL);

DROP POLICY IF EXISTS anon_update_game_sessions ON game_sessions;
CREATE POLICY anon_update_game_sessions ON game_sessions FOR UPDATE TO anon
  USING (tenant_id IS NULL)
  WITH CHECK (tenant_id IS NULL);

-- 2. Child tables — same rule, all commands (they only ever had one "ALL" policy each).
DROP POLICY IF EXISTS anon_all_game_session_participants ON game_session_participants;
CREATE POLICY anon_all_game_session_participants ON game_session_participants FOR ALL TO anon
  USING (tenant_id IS NULL)
  WITH CHECK (tenant_id IS NULL);

DROP POLICY IF EXISTS anon_all_game_answers ON game_answers;
CREATE POLICY anon_all_game_answers ON game_answers FOR ALL TO anon
  USING (tenant_id IS NULL)
  WITH CHECK (tenant_id IS NULL);

DROP POLICY IF EXISTS anon_all_game_players ON game_players;
CREATE POLICY anon_all_game_players ON game_players FOR ALL TO anon
  USING (tenant_id IS NULL)
  WITH CHECK (tenant_id IS NULL);

-- 3. Server-side enforcement to match: never trust a client-supplied
--    tenant_id for authorization, even in the anon path. Tenant scope comes
--    exclusively from get_my_tenant_id() (real tenant if authenticated,
--    NULL if not) — p_tenant_id is accepted for signature compatibility but
--    is dead for authorization purposes.
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
  -- No fallback to p_tenant_id: authenticated callers always get their real
  -- tenant; anon/demo callers always get NULL, regardless of what the
  -- client sent.
  v_tenant := get_my_tenant_id()::text;

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
    END;
  END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION create_game_session_atomic(text, text, text, text, integer, boolean) TO anon, authenticated;

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
  v_tenant := get_my_tenant_id()::text;
  IF v_tenant IS NULL THEN
    SELECT * INTO v_row FROM game_sessions WHERE pin = p_pin AND tenant_id IS NULL LIMIT 1;
  ELSE
    SELECT * INTO v_row FROM game_sessions WHERE pin = p_pin AND tenant_id = v_tenant LIMIT 1;
  END IF;
  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION find_joinable_session(text, text) TO anon, authenticated;
