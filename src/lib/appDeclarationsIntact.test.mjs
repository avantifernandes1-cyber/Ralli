// Regression guard for the "LEADERSHIP_SEED is not defined" preview crash.
// Run: node src/lib/appDeclarationsIntact.test.mjs   (no creds, no DB, no browser)
//
// THE BUG THIS CATCHES
// The Battle Cards tags-only refactor spliced out a large rankd-app.jsx range that
// happened to also contain NON-Battle-Card top-level declarations (the Leadership
// readiness model + demo data + rep helpers). esbuild/Vite BUILD SUCCEEDS even when
// an identifier is referenced but never defined (it is treated as a runtime global),
// so the failure only surfaced in the browser as "LEADERSHIP_SEED is not defined".
//
// This guard asserts that every REQUIRED top-level declaration that is *referenced*
// in rankd-app.jsx is also *defined* exactly once — failing loudly (like the runtime
// would) if any is spliced out again.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// Required declarations that live in the range the Battle Cards refactor touched
// (Leadership readiness model, demo data, rep drill-down helpers). Each MUST be
// defined once and referenced — they are non-Battle-Card code that must survive.
const REQUIRED = [
  "LEADERSHIP_SEED", "READINESS_SCORE_WEIGHTS", "computeReadinessScore",
  "DEMO_QUIZ_NAMES", "DEMO_REP_DRILL_DATA",
  "_repAssignmentDone", "_repAssignmentOverdue", "_strongestTopic", "_weakestTopic",
  "_relativeActivityLabel", "_contentTypeLabel", "_daysOverdue", "_sortDesc",
];

const defCount = (name) => {
  const re = new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var)\\s+${name}\\b`, "gm");
  return (src.match(re) || []).length;
};
const refCount = (name) => {
  // any occurrence of the identifier (word-boundary) minus is fine; we just need >0
  const re = new RegExp(`\\b${name}\\b`, "g");
  return (src.match(re) || []).length;
};

for (const name of REQUIRED) {
  const defs = defCount(name);
  const refs = refCount(name);
  // referenced (refs > defs means used somewhere beyond its own definition) AND defined exactly once
  ok(`${name}: defined exactly once and referenced`, defs === 1 && refs > defs,
     `defs=${defs} refs=${refs}`);
}

// Generic backstop: no REQUIRED identifier is referenced without a definition.
const undefinedRefs = REQUIRED.filter(n => refCount(n) > 0 && defCount(n) === 0);
ok("no required declaration is referenced without a definition", undefinedRefs.length === 0,
   undefinedRefs.join(", "));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
