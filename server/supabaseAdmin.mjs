/**
 * SERVER-ONLY Supabase admin client.
 *
 * ⚠️  NEVER import this from application/browser code (anything under src/ that
 * the Vite app bundle reaches). It uses the SERVICE-ROLE key, which bypasses
 * RLS and must never ship to the client. It lives under server/ precisely so
 * Vite never bundles it (nothing in the app graph imports it).
 *
 * Reads from process.env (NOT import.meta.env, NOT VITE_*):
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * The service-role key must NEVER be placed in a VITE_ variable (those are
 * inlined into the browser bundle). This module throws loudly if either is
 * missing so a misconfigured run fails fast instead of silently using the wrong
 * client. It never logs the key.
 */
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceRoleKey) {
  throw new Error(
    "server/supabaseAdmin: missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in the environment. " +
    "This is a server/operations-only client — provide the service-role key via SUPABASE_SERVICE_ROLE_KEY " +
    "(NEVER a VITE_ variable, which would be exposed in the browser bundle)."
  );
}

export const supabaseAdmin = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
