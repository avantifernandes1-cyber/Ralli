// Regression guard for the Login white-screen (Stage 1b).
// Run: node src/lib/appLoginHookOrder.test.mjs   (no creds, no DB, no browser)
//
// THE BUG THIS CATCHES
// App() renders <LoginScreen/> via an early `if (!currentUser) return` and then,
// AFTER that return, declared `const refreshQuizzes = useCallback(...)`. React
// hooks must run in the same order every render (Rules of Hooks). A hook placed
// after that early return is SKIPPED on the signed-out render (fresh storage /
// no session) and CALLED once a user is present (login / persisted session),
// so the hook count changes between renders — React throws "change in the order
// of Hooks" and unmounts the whole App: the page goes blank right after Login.
//
// Fresh-vs-persisted auth is exactly the two render paths that differ here
// (currentUser null vs set). This test asserts the structural invariant that
// makes BOTH paths call the identical set of hooks: NO React hook may appear in
// App's body after its first `if (!currentUser) return` early return. It fails
// loudly if any hook (useState/useEffect/useCallback/useMemo/useRef/…) is
// reintroduced below that return.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// Extract the App() function body by brace-matching from its declaration.
function appBody(s) {
  const decl = "export default function App(";
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

const body = appBody(src);
ok("App() function body located", !!body);

if (body) {
  // The signed-out early return that renders the Login/Marketing screen.
  const retIdx = body.indexOf("if (!currentUser) {");
  ok("App has the `if (!currentUser)` early return", retIdx >= 0);

  if (retIdx >= 0) {
    const after = body.slice(retIdx);
    // Any React hook call after the early return is the regression. Match hook
    // CALLS (a `useXxx(` preceded by `=`, whitespace, `(`, `,` or `{` — i.e. an
    // invocation, not a substring of an identifier). Custom hooks (useMobile,
    // useToast, useGameChannel, useSharedUserAssignmentData) count too — any
    // hook after the return breaks order — but in practice only the built-ins
    // and the app's own use* hooks appear here.
    const hookCall = /(^|[=(,{\s])(use[A-Z][A-Za-z0-9]*)\s*\(/g;
    const offenders = [];
    let m;
    while ((m = hookCall.exec(after)) !== null) {
      // Ignore ".useX(" method calls and JSX-ish false positives; require the
      // token to be a bare identifier invocation.
      const name = m[2];
      const precededByDot = after[m.index] === "." || after[m.index - 0] === ".";
      if (!precededByDot) offenders.push(name);
    }
    ok("NO React hook is called after App's early return", offenders.length === 0,
       offenders.length ? `found hook(s) after early return: ${[...new Set(offenders)].join(", ")}` : "");

    // Belt-and-suspenders: the specific hook that caused the incident must NOT
    // be a hook anymore. refreshQuizzes lives after the early return; it must be
    // a plain function.
    ok("refreshQuizzes is a plain function (not a hook after the return)",
       /const refreshQuizzes = \(\) =>/.test(body) && !/const refreshQuizzes = useCallback/.test(body));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
