// Ralli Live — durable VERIFICATION QUEUE WORKER (Deno). NOT DEPLOYED / NOT SCHEDULED in this slice.
//
// This is the server-owned process the migration-085 outbox needs: it drains
// `game_verification_queue` by claiming due (or expired-lease) jobs and running the SAME canonical
// verification path used on-demand (../_shared/verifySession.js → shared grader + record_game_verification
// RPC). It replaces the fragile host-browser fire-and-forget invocation as the DURABLE guarantee that a
// completed real session is eventually verified.
//
// Security contract:
//   - Server-owned only. The caller MUST present the service-role key as the bearer token
//     (isAuthorizedWorkerRequest). Anonymous and ordinary authenticated callers are rejected 401.
//   - All DB work uses a service-role client; the migration-085 claim/complete RPCs additionally
//     enforce the service_role JWT role, so even a leaked call path cannot claim jobs as a user.
//   - The service-role key is read from the function env (Supabase secret); it is NEVER returned or
//     logged. Failures are recorded as short generic codes only — no answers/snapshots/secrets.
//
// Safety:
//   - Bounded batch (MAX_BATCH) and wall-clock budget (MAX_RUNTIME_MS) so one invocation is always safe.
//   - Concurrency-safe: claims use FOR UPDATE SKIP LOCKED and a processing LEASE; a crashed worker's job
//     is reclaimed only after its lease expires, so parallel invocations never double-process.
//   - One job's failure never aborts the batch (see runVerificationBatch).
//
// DEPLOY / SCHEDULE (documented, NOT performed here — requires separate approval):
//   supabase functions deploy verify-queue-worker
//   Env (function secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   Schedule every ~1 min via an approved Supabase mechanism (pg_cron + pg_net, or the dashboard
//   Scheduled Functions), invoking POST with header  Authorization: Bearer <SERVICE_ROLE_KEY>.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { verifyCompletedSession, VERIFICATION_SOURCE_WORKER } from "../_shared/verifySession.js";
import { runVerificationBatch, isAuthorizedWorkerRequest } from "../_shared/verifyQueueWorker.js";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!; // server-only secret

const MAX_BATCH = 10;          // bounded work per invocation
const MAX_RUNTIME_MS = 25_000; // wall-clock budget < the 5-min processing lease, so a live job is never stolen

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  // Service-role-only gate: reject anonymous and ordinary authenticated callers.
  if (!isAuthorizedWorkerRequest(req.headers.get("Authorization"), SERVICE_ROLE_KEY)) {
    return json({ error: "unauthorized" }, 401);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const deps = {
    claimJob: async () => {
      const { data, error } = await admin.rpc("rpc_claim_verification_job");
      if (error) throw new Error("claim failed");
      return data; // { claimed, session_id?, ... }
    },
    verifyOne: (sessionId: string) => verifyCompletedSession(admin, sessionId, { source: VERIFICATION_SOURCE_WORKER }),
    completeJob: async (sessionId: string, ok: boolean, err: string | null) => {
      // Best-effort: if this write fails, the processing lease expires and the job is reclaimed later.
      await admin.rpc("rpc_complete_verification_job", { p_session_id: sessionId, p_ok: ok, p_error: err });
    },
    now: () => Date.now(),
  };

  try {
    const summary = await runVerificationBatch(deps, { maxBatch: MAX_BATCH, maxRuntimeMs: MAX_RUNTIME_MS });
    return json({ ok: true, ...summary }, 200); // counts only — no answer/snapshot/secret material
  } catch (_e) {
    return json({ error: "internal error" }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
