// Verification-queue worker — pure, dependency-injected orchestration (no Deno/HTTP/DB deps),
// so the batch/lease/retry/confidentiality behavior is unit-testable under `node --test`.
// The Deno entrypoint (verify-queue-worker/index.ts) wires the real claim/verify/complete calls in.

// ── Worker authorization (claim-based, post-gateway) ─────────────────────────
//
// SECURITY MODEL — TWO LAYERS, do not conflate:
//
//   (1) PLATFORM GATEWAY — Supabase `verify_jwt=true`, enforced BEFORE this code runs.
//       It cryptographically verifies the bearer is a JWT SIGNED BY THIS PROJECT'S JWT SECRET
//       and not expired. Missing / malformed / unsigned / alg:none / wrong-project / expired /
//       tampered tokens are rejected by the gateway (HTTP 401) and never reach the worker. This is
//       the cryptographic trust boundary — the worker does NOT (and, lacking the JWT secret, cannot)
//       re-verify the signature. What is cryptographically enforced (signature, project binding,
//       expiry) lives HERE.
//
//   (2) WORKER AUTHORIZATION — below. Of the already-verified token, admit ONLY the trusted
//       SERVICE-ROLE identity by inspecting its `role` claim. This REPLACES the previous brittle
//       exact-string comparison of the bearer against env SUPABASE_SERVICE_ROLE_KEY, which rejected a
//       perfectly valid, gateway-verified service_role JWT merely because its bytes differed from the
//       env value. Authorization is by IDENTITY (role claim), never by secret-string equality.
//
// Defense-in-depth: even though the gateway already rejects them, we ALSO structurally reject
// unsigned / alg:none / malformed tokens here, so this function is not a forgeable claim reader if it
// were ever invoked without the gateway in front of it. Nothing about the token is logged or returned.

// base64url → UTF-8 string. Runtime-neutral: atob / Uint8Array / TextDecoder exist in Deno and Node18+.
function b64urlToString(seg) {
  const b64 = String(seg).replace(/-/g, "+").replace(/_/g, "/");
  const pad = (4 - (b64.length % 4)) % 4;
  const bin = atob(b64 + "=".repeat(pad));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// Decode a compact JWS's header + payload WITHOUT verifying the signature (the gateway did that).
// Returns null for anything that is not a structurally sound SIGNED JWT: exactly three non-empty
// segments, parseable header/payload objects, a real signing `alg`, and a present signature segment.
export function decodeSignedJwt(token) {
  if (typeof token !== "string" || token.length === 0) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  if (!h || !p || !s) return null;                 // signature MUST be present → rejects alg:none / unsigned
  let header, payload;
  try {
    header = JSON.parse(b64urlToString(h));
    payload = JSON.parse(b64urlToString(p));
  } catch {
    return null;                                    // not valid base64url / JSON
  }
  if (!header || typeof header !== "object" || !payload || typeof payload !== "object") return null;
  const alg = header.alg;
  if (typeof alg !== "string" || alg.toLowerCase() === "none") return null;  // never trust alg:none
  return { header, payload };
}

export const WORKER_TRUSTED_ROLE = "service_role";

// Authorize a worker request by the trusted SERVICE-ROLE identity of the gateway-verified bearer.
//   opts.now        : seconds since epoch (injectable for tests; defaults to the real clock)
//   opts.projectRef : optional expected project ref, enforced ONLY when the token carries a `ref`
//                     claim (belt-and-suspenders). The primary project boundary is the gateway's
//                     project-specific signature, so a valid token that omits `ref` is NOT rejected.
// Returns a boolean only — never the token, header, or any decoded claim.
export function isAuthorizedWorkerRequest(authHeader, opts = {}) {
  const h = typeof authHeader === "string" ? authHeader : "";
  if (!h.startsWith("Bearer ")) return false;
  const token = h.slice(7).trim();
  if (!token) return false;

  const decoded = decodeSignedJwt(token);
  if (!decoded) return false;                                  // malformed / unsigned / alg:none
  const { payload } = decoded;

  if (payload.role !== WORKER_TRUSTED_ROLE) return false;      // ONLY service_role; never anon/authenticated/app-roles

  // Expiry: the gateway also enforces exp; re-check as defense-in-depth when the claim is present.
  if (payload.exp != null) {
    const exp = Number(payload.exp);
    const now = Number.isFinite(opts.now) ? opts.now : Math.floor(Date.now() / 1000);
    if (!Number.isFinite(exp) || exp <= now) return false;
  }

  // Optional project pinning: only when both an expected ref and a token `ref` are present; never
  // rejects a valid token that omits `ref`. Primary project boundary remains the gateway signature.
  if (opts.projectRef && payload.ref != null && payload.ref !== opts.projectRef) return false;

  return true;
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
