// Executable wiring test for verify-game-session/index.ts CORS integration.
// The handler uses Deno-only APIs (Deno.serve/env) so it can't be imported in Node;
// this asserts the exact source wiring instead (same idiom as the repo's app*.test.mjs).
// Run: node supabase/functions/verify-game-session/index.cors.test.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "index.ts"), "utf8");

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };

// ── CORS is imported and resolved once, up front ─────────────────────────────
ok("1 imports corsHeaders from the shared policy module", /import \{ corsHeaders \} from "\.\.\/_shared\/cors\.js"/.test(src));
ok("2 resolves cors from the request Origin before handling", /const cors = corsHeaders\(req\.headers\.get\("Origin"\)\)/.test(src));

// ── OPTIONS preflight returns immediately with NO auth/DB work ────────────────
const optIdx = src.indexOf('req.method === "OPTIONS"');
ok("3 OPTIONS preflight is handled", optIdx >= 0);
ok("3b OPTIONS returns 204 with cors headers, empty body",
   /req\.method === "OPTIONS"\) return new Response\(null, \{ status: 204, headers: cors \}\)/.test(src));
// The OPTIONS return must come BEFORE any authentication or database access.
const firstAuth = src.indexOf("authClient.auth.getUser"); // the code call (not the header-comment mention)
const firstDb = src.indexOf(".from(");
ok("4 OPTIONS returns before auth.getUser (no JWT work on preflight)", optIdx < firstAuth && firstAuth > 0);
ok("4b OPTIONS returns before the service-role client is built (no DB creds on preflight)",
   optIdx < src.indexOf("createClient(SUPABASE_URL, SERVICE_ROLE_KEY"));
ok("4c OPTIONS returns before any table read (no DB work on preflight)", optIdx < firstDb && firstDb > 0);

// ── Every response path carries CORS: no json(...) call omits the cors arg ────
const jsonCallLines = src.split("\n").filter(l => /(return |= )json\(/.test(l));
ok("5 has multiple json() response sites", jsonCallLines.length >= 7);
const missingCors = jsonCallLines.filter(l => !/, cors\)/.test(l));
ok("6 EVERY json() response includes the cors headers arg", missingCors.length === 0,
   missingCors.length ? `${missingCors.length} without cors: ${missingCors[0].trim()}` : "");
ok("6b the unexpected-error catch returns cors", /catch[\s\S]{0,80}return json\(\{ error: "internal error", retryable: true \}, 500, cors\)/.test(src));
ok("6c the json() helper spreads cors into the response headers", /function json\([^)]*cors[^)]*\)[\s\S]{0,140}\.\.\.cors/.test(src));

// ── No wildcard / credentials leak from the handler ──────────────────────────
ok("7 handler never emits a wildcard Access-Control-Allow-Origin", !/Access-Control-Allow-Origin["']?\s*[:=]\s*["']\*/.test(src));
ok("7b handler never sets Access-Control-Allow-Credentials", !/Access-Control-Allow-Credentials/.test(src));

// ── Existing security preserved (unchanged by this CORS correction) ──────────
ok("8 verified-JWT via auth.getUser() (not decoded claims) preserved", /authClient\.auth\.getUser\(\)/.test(src) && /error: "invalid token" \}, 401/.test(src));
ok("9 anonymous POST still denied (missing bearer → 401)", /error: "missing bearer token" \}, 401/.test(src));
ok("10 host/manager/admin authorization expression preserved",
   /const authorized = isAdmin \|\| \(sameTenant && \(isHost \|\| isManager\)\)/.test(src) &&
   /error: "not authorized for this session" \}, 403/.test(src));
ok("11 tenant derived server-side from the session (not the body)",
   /String\(profile\.tenant_id\) === String\(session\.tenant_id \?\? ""\)/.test(src));
ok("12 service-role key stays server-side (env secret, never in a response)",
   /SERVICE_ROLE_KEY = Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/.test(src) && !/SERVICE_ROLE_KEY[\s\S]{0,40}json\(/.test(src));
ok("13 demo/incomplete handling preserved", /demo_mode === true.*ineligible/.test(src) && /session not completed", retryable: true \}, 409/.test(src));
// 14 — grading + the writer RPC now live in the ONE shared canonical verifier; the entrypoint
//      delegates to it and must NOT re-implement the grader or the record RPC itself (single source
//      of truth shared with verify-queue-worker). Stronger than the old copy-in-entrypoint assertion.
ok("14a entrypoint imports + calls the shared canonical verifier",
   /import \{ verifyLoadedSession, VERIFICATION_SOURCE_EDGE \} from "\.\.\/_shared\/verifySession\.js"/.test(src) &&
   /verifyLoadedSession\(admin, session, \{ source: VERIFICATION_SOURCE_EDGE \}\)/.test(src));
ok("14b entrypoint no longer re-implements the grader or the record RPC call (no drift)",
   !/buildSessionVerdicts\(/.test(src) && !/\.rpc\("record_game_verification"/.test(src));
{
  const vsrc = readFileSync(join(here, "..", "_shared", "verifySession.js"), "utf8");
  ok("14c grader + writer RPC live ONCE in the shared verifier",
     /buildSessionVerdicts\(/.test(vsrc) && /record_game_verification/.test(vsrc));
}
ok("15 response payload fields unchanged (ok + spread result)", /return json\(\{ ok: true, \.\.\.\(result as object\) \}, 200, cors\)/.test(src));
ok("16 logging policy unchanged (no console.* in the function)", !/console\./.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
