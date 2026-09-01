// Verification-queue worker — pure, dependency-injected orchestration (no Deno/HTTP/DB deps),
// so the batch/lease/retry/confidentiality behavior is unit-testable under `node --test`.
// The Deno entrypoint (verify-queue-worker/index.ts) wires the real claim/verify/complete calls in.

// Constant-time-ish string compare (length-checked). Used for the service-role bearer gate so the
// worker rejects anonymous and ordinary authenticated callers. Kept dependency-free (Deno + Node).
export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The worker is server-owned: it must present the service-role key as its bearer token. Anything else
// (no header, empty token, an ordinary user JWT) is rejected. serviceKey missing ⇒ always deny.
export function isAuthorizedWorkerRequest(authHeader, serviceKey) {
  if (!serviceKey) return false;
  const h = typeof authHeader === "string" ? authHeader : "";
  if (!h.startsWith("Bearer ")) return false;
  return safeEqual(h.slice(7), serviceKey);
}

// Short, generic failure label — NEVER answers/snapshots/secrets. Only a small whitelist of known
// transient codes passes through; anything else collapses to a generic label.
const KNOWN_CODES = new Set([
  "session load failed", "answers load failed", "verification write failed",
  "session not completed", "session_id required",
]);
export function sanitizeError(e) {
  const msg = e && typeof e.message === "string" ? e.message : "";
  return (KNOWN_CODES.has(msg) ? msg : "verification error").slice(0, 120);
}

// Process one bounded batch of verification jobs.
//   deps.claimJob()               -> { claimed:boolean, session_id?:string } (service-role claim RPC)
//   deps.verifyOne(sessionId)     -> { status:'verified'|'ineligible'|'not_found', ... } | throws (retryable)
//   deps.completeJob(sid, ok, err)-> marks the job done/retry (service-role complete RPC)
//   deps.now()                    -> ms clock (injectable for tests)
// opts.maxBatch / opts.maxRuntimeMs bound the run so a single invocation is always safe.
export async function runVerificationBatch(deps, opts = {}) {
  const claimJob = deps.claimJob;
  const verifyOne = deps.verifyOne;
  const completeJob = deps.completeJob;
  const now = deps.now || (() => Date.now());
  const sanitize = opts.sanitizeError || sanitizeError;
  const maxBatch = Number.isFinite(opts.maxBatch) ? opts.maxBatch : 10;
  const maxRuntimeMs = Number.isFinite(opts.maxRuntimeMs) ? opts.maxRuntimeMs : 25000;

  const start = now();
  const summary = { claimed: 0, verified: 0, ineligible: 0, retried: 0, empty: false, stoppedForTime: false, claimError: false };

  for (let i = 0; i < maxBatch; i++) {
    if (now() - start >= maxRuntimeMs) { summary.stoppedForTime = true; break; }

    let job;
    try {
      job = await claimJob();
    } catch (_e) {
      summary.claimError = true;               // stop this batch; next scheduled run retries
      break;
    }
    if (!job || job.claimed === false || !job.session_id) {
      if (i === 0) summary.empty = true;        // nothing due
      break;
    }

    summary.claimed++;
    const sid = job.session_id;
    try {
      const r = await verifyOne(sid);          // reuses the canonical verify path (shared grader + RPC)
      await completeJob(sid, true, null);      // verified / ineligible / not_found → nothing more to do
      if (r && r.status === "ineligible") summary.ineligible++; else summary.verified++;
    } catch (e) {
      // A single job's failure must never abort the rest of the batch.
      try { await completeJob(sid, false, sanitize(e)); } catch (_e2) { /* swallow; continue batch */ }
      summary.retried++;
    }
  }
  return summary;
}
