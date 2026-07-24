// Trusted server boundary — readiness recalculation Edge Function (Deno).
//
// PHASE 1 SKELETON ONLY. This authenticates the caller and validates that they
// are an active rep, but it does NOT compute or write readiness yet (worker
// processing is enabled in a later phase). It exists to establish the trusted
// boundary contract and prove JWT/tenant authorization.
//
// Security contract (design v7):
//   - Verify the JWT via Supabase auth (auth.getUser) — NEVER trust decoded
//     client claims for identity.
//   - Derive the authenticated user server-side; ignore any client-supplied
//     user/tenant when recalculating self.
//   - Query canonical profiles membership + status; require an active REP role.
//   - The service-role key is read from the function's environment (Supabase
//     secret) and is NEVER returned to the client.
//   - When enabled, this function only ACCELERATES the durable queue: it claims
//     and processes the caller's pending job; losing this call cannot lose the
//     recalculation (the queue + scheduled worker remain the durable source).

// Pinned to the exact reviewed version (matches package.json @2.45.0), not a
// floating major, so the deployed function can't drift.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // server-only secret

const REP_EXCLUDED_ROLES = new Set(["orgAdmin", "ralli_admin", "superadmin"]);

Deno.serve(async (req) => {
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ error: "missing bearer token" }, 401);
    }

    // 1. Verify the JWT (not decode) and derive the user server-side.
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: authErr } = await authClient.auth.getUser();
    if (authErr || !userData?.user) return json({ error: "invalid token" }, 401);
    const userId = userData.user.id; // authoritative — client body identity is ignored

    // 2. Canonical membership + active-rep check via service-role (RLS-independent).
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    const { data: profile, error: pErr } = await admin
      .from("profiles").select("id, tenant_id, role, status")
      .eq("id", userId).maybeSingle();
    if (pErr || !profile) return json({ error: "profile not found" }, 403);
    const isActiveRep = (profile.status ?? "active") !== "inactive" && !REP_EXCLUDED_ROLES.has(profile.role);
    if (!isActiveRep) {
      // Managers/inactive users have no rep readiness — nothing to accelerate.
      return json({ status: "not_a_rep", accelerated: false }, 200);
    }

    // 3. PHASE 1: processing not enabled. The durable queue (populated by DB
    //    triggers in a later phase) is the source of truth; this endpoint will
    //    later claim + process the caller's pending job via apply_readiness_result.
    return json({ status: "accepted", accelerated: false, note: "phase1-skeleton: processing disabled" }, 202);
  } catch (_e) {
    // Never leak internal error detail or secrets.
    return json({ error: "internal error" }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
