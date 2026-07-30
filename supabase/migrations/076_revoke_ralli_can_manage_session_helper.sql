-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 076: lock down the internal Ralli Live authz helper
--
-- FORWARD-ONLY correction to migration 075 (which is already applied — 075 is NOT
-- edited or renamed). 075's `REVOKE ALL … FROM PUBLIC, anon` on
-- public.ralli_can_manage_session(text,text) did not strip the EXPLICIT
-- `authenticated` + `service_role` EXECUTE grants that Supabase's default-privilege
-- trigger adds on function creation, so the helper remained directly executable by
-- authenticated. This revokes that direct EXECUTE so the helper is INTERNAL ONLY.
--
-- The helper is only ever invoked from the six SECURITY DEFINER RPCs created in 075
-- (rpc_host_session_restore / rpc_manager_active_sessions / rpc_manager_session_history
-- / rpc_manager_session_analytics / rpc_session_player_counts / rpc_lobby_participants).
-- Those run as the function OWNER (postgres), which retains EXECUTE, so they continue
-- to call the helper successfully — no RPC behavior changes.
--
-- Scope: touches ONLY the EXECUTE grants on this one helper. Does NOT change the
-- helper body, any RPC body, any RPC grant, any table grant, any RLS policy, or any
-- data. No table-read access is revoked. Purely a function-level grant tightening.
-- ─────────────────────────────────────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.ralli_can_manage_session(text, text) FROM authenticated, service_role, PUBLIC, anon;

-- Verify (read-only):
--   SELECT has_function_privilege('authenticated','public.ralli_can_manage_session(text,text)','EXECUTE'); -- expect false
--   SELECT has_function_privilege('service_role','public.ralli_can_manage_session(text,text)','EXECUTE');  -- expect false
--   SELECT has_function_privilege('anon','public.ralli_can_manage_session(text,text)','EXECUTE');          -- expect false
--   -- proacl should be {postgres=X/postgres} only (owner retains EXECUTE); the six RPCs still work as owner.
