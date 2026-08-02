/**
 * Ralli Live — CORS origin policy for the `verify-game-session` Edge Function.
 *
 * Pure and runtime-neutral (no Deno / Node / Supabase / DOM APIs) so it is imported
 * VERBATIM by the Edge Function AND executed directly by Node tests — the policy the
 * tests prove is the policy the server runs.
 *
 * Explicit, auditable allowlist — NEVER a wildcard, NEVER credentials. An approved
 * Origin is echoed back in `Access-Control-Allow-Origin`; an unapproved (or missing,
 * i.e. non-browser/server) Origin gets NO `Access-Control-Allow-Origin` header at all
 * (the browser then blocks the cross-origin read; server-to-server calls, which send
 * no Origin and ignore CORS, are unaffected). Bearer-token auth is used (no cookies),
 * so `Access-Control-Allow-Credentials` is intentionally never set.
 */

export const ALLOWED_METHODS = "POST, OPTIONS";
// Headers the Supabase browser client (`functions.invoke`) sends on a cross-origin call.
export const ALLOWED_HEADERS = "authorization, apikey, content-type, x-client-info";

// Exact approved origins: Ralli production apex + known production aliases.
const EXPLICIT_ORIGINS = new Set([
  "https://runralli.com",
  "https://www.runralli.com",
  "https://ralli-avanti-lab.vercel.app",
  "https://rankd-six.vercel.app",
]);

// Pattern-approved origins: Vercel preview + branch-alias deploys (required for QA),
// and local development. Anchored (^…$) so look-alike suffix/prefix hosts never match.
const ORIGIN_PATTERNS = [
  /^https:\/\/ralli-[a-z0-9]+-avanti-lab\.vercel\.app$/,       // hash previews, e.g. ralli-ahi3xvsn0-avanti-lab
  /^https:\/\/ralli-git-[a-z0-9-]+-avanti-lab\.vercel\.app$/,  // branch aliases, e.g. ralli-git-main-avanti-lab
  /^http:\/\/localhost(:\d{2,5})?$/,                           // local dev (vite 5173, etc.)
  /^http:\/\/127\.0\.0\.1(:\d{2,5})?$/,
];

/** True only for an explicitly approved Origin. Missing / non-string → false. */
export function isAllowedOrigin(origin) {
  if (!origin || typeof origin !== "string") return false;
  if (EXPLICIT_ORIGINS.has(origin)) return true;
  return ORIGIN_PATTERNS.some((re) => re.test(origin));
}

/**
 * Response CORS headers for a request Origin. Always sets `Vary: Origin` and the
 * static method/header allowlists; sets `Access-Control-Allow-Origin` ONLY for an
 * approved origin. Never sets `Access-Control-Allow-Credentials`.
 * @param {string|null|undefined} origin - the request `Origin` header
 * @returns {Record<string,string>}
 */
export function corsHeaders(origin) {
  const headers = {
    "Vary": "Origin",
    "Access-Control-Allow-Methods": ALLOWED_METHODS,
    "Access-Control-Allow-Headers": ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
  };
  if (isAllowedOrigin(origin)) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

export default { isAllowedOrigin, corsHeaders, ALLOWED_METHODS, ALLOWED_HEADERS };
