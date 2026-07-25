// Regression guard for the Knowledge Heatmap white-screen (React #310).
// Run: node src/lib/leadershipHeatmapHookOrder.test.mjs  (no creds, no DB, no browser)
//
// THE BUG THIS CATCHES
// The Heatmap cutover added `const demoLeadershipData = useMemo(...)` AFTER the
// LeadershipDashboardScreen loading/error/empty early returns. React hooks must
// run in the same order every render (Rules of Hooks). Placed after the returns,
// that useMemo is SKIPPED on the first render (loading=true → early return) and
// CALLED once the RPC resolves (loading=false), so the hook count changes between
// the loading and loaded renders — React throws "Rendered more hooks than during
// the previous render." (minified #310) and the error boundary replaces the page.
//
// loading→loaded is exactly the two render paths that differ. This asserts the
// structural invariant that makes BOTH call the identical set of hooks: NO React
// hook may appear in LeadershipDashboardScreen's body after its first early
// return, AND demoLeadershipData must be memoized BEFORE that return.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// Extract a function body by brace-matching from its declaration.
function fnBody(s, decl) {
  const start = s.indexOf(decl);
  if (start < 0) return null;
  let i = s.indexOf("{", s.indexOf(")", start));
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return null;
}

const body = fnBody(src, "function LeadershipDashboardScreen(");
ok("LeadershipDashboardScreen() body located", !!body);

if (body) {
  // The first early return (loading state — real users only).
  const retIdx = body.indexOf("if (loading) {");
  ok("LeadershipDashboardScreen has the `if (loading)` early return", retIdx >= 0);

  // demoLeadershipData must be memoized BEFORE the first early return.
  const demoIdx = body.indexOf("const demoLeadershipData = useMemo(");
  ok("demoLeadershipData is a useMemo", demoIdx >= 0);
  ok("demoLeadershipData is declared BEFORE the loading return",
     demoIdx >= 0 && retIdx >= 0 && demoIdx < retIdx,
     demoIdx >= retIdx ? "demoLeadershipData useMemo sits AFTER the early return (React #310)" : "");

  if (retIdx >= 0) {
    const after = body.slice(retIdx);
    // Any bare React hook invocation after the early return is the regression.
    const hookCall = /(^|[=(,{\s])(use[A-Z][A-Za-z0-9]*)\s*\(/g;
    const offenders = [];
    let m;
    while ((m = hookCall.exec(after)) !== null) {
      if (after[m.index] !== ".") offenders.push(m[2]);
    }
    ok("NO React hook is called after LeadershipDashboardScreen's early return",
       offenders.length === 0,
       offenders.length ? `found hook(s) after early return: ${[...new Set(offenders)].join(", ")}` : "");
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
