-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 074: revoke anonymous EXECUTE from the learner-safe review/history RPCs
--
-- FORWARD-ONLY, minimal tightening. Migration 073 created three learner-safe read
-- RPCs and revoked anon EXECUTE only from rpc_player_session_restore. The other
-- two — rpc_my_completed_session_review and rpc_list_my_game_history — retained
-- the Supabase schema-DEFAULT anon EXECUTE grant (a `REVOKE … FROM PUBLIC` does
-- not remove the explicit default-privilege grant to anon). Their bodies already
-- reject anon (they RAISE 'authentication required' when auth.uid() is null), so
-- anon was only ever FUNCTIONALLY denied; this migration brings GRANT-LEVEL parity
-- with rpc_player_session_restore.
--
-- Does NOT touch 073 (immutable, already applied), any table grant, any RLS
-- policy, or any function body. Preserves authenticated + service_role EXECUTE.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.rpc_my_completed_session_review(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.rpc_list_my_game_history(integer)     FROM anon;

-- Verify (read-only):
--   SELECT has_function_privilege('anon','public.rpc_my_completed_session_review(uuid)','EXECUTE');   -- expect false
--   SELECT has_function_privilege('anon','public.rpc_list_my_game_history(integer)','EXECUTE');        -- expect false
--   SELECT has_function_privilege('authenticated','public.rpc_my_completed_session_review(uuid)','EXECUTE'); -- expect true
