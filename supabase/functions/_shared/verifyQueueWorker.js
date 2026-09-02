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
// safe codes passes through; anything else (e.g. an arbitrary thrown Error) collapses to a generic label.
const KNOWN_CODES = new Set([
  // typed codes emitted by the shared verifier (verifySession.js)
  "session_load_failed", "answers_load_failed", "verification_write_failed", "snapshot_hash_mismatch",
  "not_ready", "bad_request", "unauthorized", "unknown",
  // legacy space-form codes (defensive)
  "session load failed", "answers load failed", "verification write failed",
  "session not completed", "session_id required",
]);
export function sanitizeError(e) {
  const msg = e && typeof e.message === "string" ? e.message : "";
  return (KNOWN_CODES.has(msg) ? msg : "verification error").slice(0, 120);
}

// Process one bounded batch of verification jobs.
//   deps.claimJob()                       -> { claimed:boolean, session_id?:string } (service-role claim RPC)
//   deps.verifyOne(sessionId)             -> typed { outcome, ... } from the shared canonical verifier
//                                            (verifyCompletedSession); may also throw on the unexpected.
//   deps.completeJob(sid, ok, terminal, err) -> marks the job done / terminal-fail / backoff-retry
//                                               (service-role complete RPC, p_terminal for fail-fast).
//   deps.now()                            -> ms clock (injectable for tests)
// opts.maxBatch / opts.maxRuntimeMs bound the run so a single invocation is always safe.
//
// Outcome → queue action mapping (single place, both entrypoints share the verifier upstream):
//   verified / ineligible            -> complete ok=true            (nothing more to verify)
//   not_ready / transient / (throw)  -> complete ok=false retry     (transient; backoff, terminal after 6)
//   integrity / bad_request / unauthorized -> complete ok=false terminal=true (permanent; fail fast)
export async function runVerificationBatch(deps, opts = {}) {
  const claimJob = deps.claimJob;
  const verifyOne = deps.verifyOne;
  const completeJob = deps.completeJob;
  const now = deps.now || (() => Date.now());
  const sanitize = opts.sanitizeError || sanitizeError;
  const maxBatch = Number.isFinite(opts.maxBatch) ? opts.maxBatch : 10;
  const maxRuntimeMs = Number.isFinite(opts.maxRuntimeMs) ? opts.maxRuntimeMs : 25000;

  const start = now();
  const summary = { claimed: 0, verified: 0, idempotent: 0, ineligible: 0, retried: 0, terminal: 0, empty: false, stoppedForTime: false, claimError: false };

  const finish = async (sid, ok, terminal, err) => {
    // A single job's completion failure must never abort the batch (the lease will recover it).
    try { await completeJob(sid, ok, terminal, err); } catch (_e) { /* swallow; continue */ }
  };

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

    let res;
    try {
      res = await verifyOne(sid);              // shared canonical verifier (grader + record RPC live there)
    } catch (e) {
      res = { outcome: "transient", code: sanitize(e) };  // unexpected → transient/retryable
    }

    switch (res && res.outcome) {
      case "verified":
        await finish(sid, true, false, null); summary.verified++; if (res.idempotent) summary.idempotent++; break;
      case "ineligible":
        await finish(sid, true, false, null); summary.ineligible++; break;
      case "not_ready":
        await finish(sid, false, false, "not_ready"); summary.retried++; break;
      case "transient":
        await finish(sid, false, false, sanitize({ message: res.code })); summary.retried++; break;
      case "integrity":
        await finish(sid, false, true, sanitize({ message: res.code })); summary.terminal++; break;
      case "bad_request":
        await finish(sid, false, true, "bad_request"); summary.terminal++; break;
      case "unauthorized":
        await finish(sid, false, true, "unauthorized"); summary.terminal++; break;
      default:
        await finish(sid, false, false, "unknown"); summary.retried++; break;
    }
  }
  return summary;
}
