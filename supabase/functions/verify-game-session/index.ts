// Trusted server boundary — Ralli Live game VERIFICATION Edge Function (Deno).
//
// Independently re-grades a completed game session against its FROZEN immutable
// question snapshot using the ONE canonical grader shared with the browser
// (src/lib/gameGrading.js — imported below, never re-implemented here), then
// writes append-only, immutable verification records via the service-role-only
// `record_game_verification` RPC (migration 072). It never trusts client
// is_correct / points / final_score / final_rank / time_ms.
//
// NOT DEPLOYED as part of this slice — the frontend keeps verification behind a
// safe "unavailable / unverified" state (see rankd-app.jsx requestSession
// verification) until this function is deployed under separate approval.
//
// Security contract:
//   - Verify the JWT via auth.getUser() — never trust decoded client claims.
//   - Authorize: caller must be the session HOST, or an authorized same-tenant
//     manager/admin (or a ralli/super admin). Tenant is derived SERVER-SIDE from
//     the session, never from the client body.
//   - Only durably-completed, non-demo sessions are verifiable.
//   - Load the immutable snapshot + raw answers for THAT session only.
//   - Grade with the shared grader; write atomically/idempotently via the RPC.
//   - The service-role key is read from the function env (Supabase secret) and is
//     NEVER returned to the client. Errors are retryable and leak no internals.
//   - CORS: an explicit, auditable Origin allowlist (../_shared/cors.js). The
//     OPTIONS preflight returns immediately with NO auth/DB work; every response
//     carries CORS headers; only approved origins get Access-Control-Allow-Origin
//     (no wildcard, no credentials). Non-browser/server callers (no Origin) are
//     unaffected. This CORS layer changes NOTHING about authorization or grading.
//
// ⚠ LEADERBOARD-RELEASE BLOCKER (durable verification retry) — DO NOT SHIP THE
//   LEADERBOARD WITHOUT THIS. Verification is currently requested by the HOST
//   BROWSER at game end (fire-and-forget). If the browser closes, backgrounds, or
//   the request fails, a completed session can remain UNVERIFIED indefinitely.
//   Before the leaderboard UI is exposed, a durable retry/reconciliation mechanism
//   must find completed-but-unverified real sessions and safely re-invoke this
//   function (idempotent by design). The leaderboard MUST treat missing
//   verification as "not yet verified" — never as a failed or zero-scoring game.
//   That mechanism is out of scope for this CORS correction.
//
// DEPLOY DEPENDENCY (documented, not performed here): `supabase functions deploy
// verify-game-session` bundles the relative imports below (../_shared/gameGrading.js,
// ../_shared/cors.js) via the eszip dependency-graph bundler. import_map.json in this
// folder pins the supabase-js version; the shared modules are plain local ESM files
// with no third-party deps, so they bundle as-is with no copy.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
// THE single source of grading truth — same file the live client imports. Lives
// in supabase/functions/_shared so `supabase functions deploy` bundles it via the
// standard in-functions-dir path (no import reaching outside supabase/functions).
import { buildSessionVerdicts, GRADER_VERSION } from "../_shared/gameGrading.js";
// Explicit, auditable CORS origin policy (pure module; unit-tested in Node).
import { corsHeaders } from "../_shared/cors.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // server-only secret

const MANAGER_ROLES = new Set(["orgAdmin", "manager"]);
const ADMIN_ROLES = new Set(["ralli_admin", "superadmin"]);
const VERIFICATION_SOURCE = "edge:verify-game-session";

Deno.serve(async (req) => {
  // CORS is resolved ONCE, up front, from the request Origin against the explicit
  // allowlist — so EVERY response path (preflight, success, and every auth /
  // validation / retryable / unexpected error below) carries the same headers.
  const cors = corsHeaders(req.headers.get("Origin"));

  // Preflight: return immediately. No JWT verification, no database access.
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  try {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405, cors);

    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "missing bearer token" }, 401, cors);

    let body: { session_id?: string };
    try { body = await req.json(); } catch { return json({ error: "invalid json body" }, 400, cors); }
    const sessionId = body?.session_id;
    if (!sessionId || typeof sessionId !== "string") return json({ error: "session_id required" }, 400, cors);

    // 1. Verify the JWT (not decode) and derive the caller server-side.
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: authErr } = await authClient.auth.getUser();
    if (authErr || !userData?.user) return json({ error: "invalid token" }, 401, cors);
    const userId = userData.user.id; // authoritative

    // 2. Service-role client (RLS-independent) for canonical reads + the writer RPC.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

    // 3. Load the session (server-authoritative tenant/host/status/snapshot).
    const { data: session, error: sErr } = await admin
      .from("game_sessions")
      .select("id, tenant_id, host_id, status, demo_mode, question_snapshot")
      .eq("id", sessionId)
      .maybeSingle();
    if (sErr) return json({ error: "session load failed" }, 500, cors); // retryable
    if (!session) return json({ error: "session not found" }, 404, cors);

    // 4. Authorize: host, or authorized same-tenant manager/admin, or super admin.
    const { data: profile, error: pErr } = await admin
      .from("profiles").select("id, tenant_id, role, status")
      .eq("id", userId).maybeSingle();
    if (pErr) return json({ error: "profile load failed" }, 500, cors); // retryable
    if (!profile) return json({ error: "not authorized" }, 403, cors);

    const sameTenant = String(profile.tenant_id ?? "") !== "" && String(profile.tenant_id) === String(session.tenant_id ?? "");
    const isHost = String(session.host_id ?? "") === String(userId);
    const isManager = MANAGER_ROLES.has(profile.role);
    const isAdmin = ADMIN_ROLES.has(profile.role);
    const authorized = isAdmin || (sameTenant && (isHost || isManager));
    if (!authorized) return json({ error: "not authorized for this session" }, 403, cors);

    // 5. Only real, durably-completed sessions are verifiable.
    if (session.demo_mode === true) return json({ status: "ineligible", reason: "demo_session" }, 200, cors);
    if (session.status !== "completed") return json({ error: "session not completed", retryable: true }, 409, cors);

    // 6. Missing snapshot → honest ineligible (RPC records it durably). Never guessed.
    const snapshot = Array.isArray(session.question_snapshot) ? session.question_snapshot : null;

    // 7. Load raw answers for THIS session only (never cross sessions/tenants).
    let verdicts: unknown[] = [];
    if (snapshot) {
      const { data: answers, error: aErr } = await admin
        .from("game_answers")
        .select("id, player_id, question_idx, option_idx, answer_text, numeric_value, answer_json, was_skipped, answered_at")
        .eq("session_id", sessionId);
      if (aErr) return json({ error: "answers load failed", retryable: true }, 500, cors);
      // 8. Independently grade with the SHARED grader (client fields ignored).
      verdicts = buildSessionVerdicts(snapshot, answers ?? []);
    }

    // 9. Atomic, idempotent write via the service-role-only RPC.
    const { data: result, error: rErr } = await admin.rpc("record_game_verification", {
      p_session_id: sessionId,
      p_grader_version: GRADER_VERSION,
      p_source: VERIFICATION_SOURCE,
      p_verdicts: verdicts,
    });
    if (rErr) return json({ error: "verification write failed", retryable: true }, 500, cors);

    return json({ ok: true, ...(result as object) }, 200, cors);
  } catch (_e) {
    return json({ error: "internal error", retryable: true }, 500, cors);
  }
});

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
}
