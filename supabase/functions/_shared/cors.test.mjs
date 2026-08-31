// Executable tests for the verify-game-session CORS origin policy (pure module).
// Run: node supabase/functions/_shared/cors.test.mjs
import { isAllowedOrigin, corsHeaders, ALLOWED_METHODS, ALLOWED_HEADERS } from "./cors.js";

let pass = 0, fail = 0;
const ok = (n, c, e = "") => { if (c) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (e ? "  → " + e : "")); } };

// ── Approved origins ─────────────────────────────────────────────────────────
ok("1 approved production apex (runralli.com)", isAllowedOrigin("https://runralli.com"));
ok("1b approved production www", isAllowedOrigin("https://www.runralli.com"));
ok("1c approved production alias ralli-avanti-lab", isAllowedOrigin("https://ralli-avanti-lab.vercel.app"));
ok("1d approved production alias rankd-six", isAllowedOrigin("https://rankd-six.vercel.app"));
ok("2 approved Vercel HASH preview", isAllowedOrigin("https://ralli-ahi3xvsn0-avanti-lab.vercel.app"));
ok("2b approved Vercel hash preview (2)", isAllowedOrigin("https://ralli-fhv3ee2fi-avanti-lab.vercel.app"));
ok("2c approved Vercel branch alias (main)", isAllowedOrigin("https://ralli-git-main-avanti-lab.vercel.app"));
ok("2d approved Vercel branch alias (feature w/ hyphens)", isAllowedOrigin("https://ralli-git-feature-ralli-live-leaderboard-avanti-lab.vercel.app"));
ok("3 approved local dev (vite 5173)", isAllowedOrigin("http://localhost:5173"));
ok("3b approved local dev (no port)", isAllowedOrigin("http://localhost"));
ok("3c approved local dev (127.0.0.1:3000)", isAllowedOrigin("http://127.0.0.1:3000"));

// ── Unapproved origins (must be denied — no look-alike, no wrong scheme) ──────
ok("4 unapproved arbitrary origin denied", !isAllowedOrigin("https://evil.com"));
ok("4b suffix look-alike denied", !isAllowedOrigin("https://runralli.com.evil.com"));
ok("4c preview suffix look-alike denied", !isAllowedOrigin("https://ralli-abc-avanti-lab.vercel.app.evil.com"));
ok("4d prefix look-alike denied", !isAllowedOrigin("https://evil-ralli-abc-avanti-lab.vercel.app"));
ok("4e wrong scheme (http prod) denied", !isAllowedOrigin("http://runralli.com"));
ok("4f other vercel team denied", !isAllowedOrigin("https://ralli-abc-someoneelse.vercel.app"));
ok("4g null origin denied (server/non-browser)", !isAllowedOrigin(null));
ok("4h empty origin denied", !isAllowedOrigin(""));
ok("4i non-string denied", !isAllowedOrigin(12345));
ok("4j remote http host denied", !isAllowedOrigin("http://localhost.evil.com"));

// ── Header contract for an APPROVED origin ───────────────────────────────────
const h = corsHeaders("https://runralli.com");
ok("5 approved → ACAO echoes the exact origin", h["Access-Control-Allow-Origin"] === "https://runralli.com");
ok("6 Vary: Origin present", h["Vary"] === "Origin");
ok("7 allow-methods EXACT (POST, OPTIONS)", h["Access-Control-Allow-Methods"] === "POST, OPTIONS" && ALLOWED_METHODS === "POST, OPTIONS");
ok("8 allow-headers EXACT (authorization, apikey, content-type, x-client-info)",
   h["Access-Control-Allow-Headers"] === "authorization, apikey, content-type, x-client-info" &&
   ALLOWED_HEADERS === "authorization, apikey, content-type, x-client-info");
ok("9 NEVER sets Allow-Credentials (bearer auth, no cookies)", !("Access-Control-Allow-Credentials" in h));
ok("9b NEVER a wildcard origin", h["Access-Control-Allow-Origin"] !== "*");

// ── Header contract for an UNAPPROVED / missing origin ───────────────────────
const hBad = corsHeaders("https://evil.com");
ok("10 unapproved → NO Access-Control-Allow-Origin", !("Access-Control-Allow-Origin" in hBad));
ok("10b unapproved still sets Vary: Origin", hBad["Vary"] === "Origin");
ok("10c unapproved never sets credentials or wildcard", !("Access-Control-Allow-Credentials" in hBad) && hBad["Access-Control-Allow-Origin"] !== "*");
const hNull = corsHeaders(null);
ok("11 server/no-Origin → NO Access-Control-Allow-Origin (request still proceeds)", !("Access-Control-Allow-Origin" in hNull));
// Approved preview origin is echoed exactly (not normalized to prod).
ok("12 approved preview origin echoed exactly", corsHeaders("https://ralli-git-main-avanti-lab.vercel.app")["Access-Control-Allow-Origin"] === "https://ralli-git-main-avanti-lab.vercel.app");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
