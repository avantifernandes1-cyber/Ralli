// Team-card layout + accessible-tooltip parity for the Ralli Live leaderboard (source-assertion test,
// same idiom as ralliLeaderboardNav.test.mjs / the Edge Function wiring tests). Presentation-only
// guarantees: no emoji, podium-consistent rank typography, clear vertical hierarchy, and tooltips that
// are keyboard + hover accessible, wrap without clipping, and derive their numbers from the payload.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
// The leaderboard region (LB_CSS … RankdScreen) — scope emoji/structure assertions to it.
const lbStart = src.indexOf("const LB_CSS");
const lbEnd = src.indexOf("function RankdScreen(");
const lb = src.slice(lbStart, lbEnd);
assert.ok(lbStart > 0 && lbEnd > lbStart, "leaderboard region located");

test("no decorative emoji anywhere in the leaderboard UI (incl. team ranking/medal)", () => {
  const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
  assert.ok(!emoji.test(lb), "leaderboard region must contain no pictographic emoji");
  assert.ok(!/m\.emoji|m\s*\?\s*m\.emoji/.test(lb), "no medal emoji lookups remain");
});

test("team rank uses the same prominent podium typography + gold/silver/bronze metal", () => {
  // A big Unbounded (heading token), metal-colored #rank exists for BOTH individuals (#{r.rank})
  // and teams (#{t.rank}). The family now comes from the canonical TYPO.headingFont (var(--font-heading)).
  assert.match(lb, /TYPO\.headingFont[^}]*color: m\.metal[^>]*>#\{r\.rank\}/s);
  assert.match(lb, /TYPO\.headingFont[^}]*color: m \? m\.metal : C\.text[^>]*>#\{t\.rank\}/s);
  assert.ok(!/RANK #\{t\.rank\}/.test(lb), "old compressed 'RANK #n' label is gone");
});

test("team card follows the required vertical hierarchy: rank, name, median, qualification", () => {
  const iRank = lb.indexOf("1. Rank");
  const iName = lb.indexOf("2. Team name");
  const iMedian = lb.indexOf("3. Median adjusted accuracy");
  const iQual = lb.indexOf("4. Qualification information");
  assert.ok(iRank > 0 && iName > iRank && iMedian > iName && iQual > iMedian, "hierarchy order 1→4");
});

test("LbTip is accessible: tabbable, hover + keyboard focus, screen-reader label", () => {
  assert.match(src, /function LbTip\(/);
  assert.match(src, /tabIndex=\{0\}/);
  assert.match(src, /role="note"/);
  assert.match(src, /aria-label=\{`\$\{ariaLabel/);
  assert.match(src, /className="lb-tip-bubble" role="tooltip"/);
});

test("tooltip CSS reveals on hover AND focus, wraps, and will not clip on narrow screens", () => {
  assert.match(src, /\.lb-tip:hover \.lb-tip-bubble,\.lb-tip:focus \.lb-tip-bubble,\.lb-tip:focus-within \.lb-tip-bubble/);
  assert.match(src, /\.lb-tip-bubble\{[^}]*white-space:normal/);
  assert.match(src, /\.lb-tip-bubble\{[^}]*max-width:min\(260px,78vw\)/);
});

test("all five required tooltips are present with plain-language copy", () => {
  assert.match(lb, /have enough verified Ralli Live data to be ranked\./);              // eligible
  assert.match(lb, /percentage of active learners on this team who have enough verified/); // participation
  assert.match(lb, /at least 2 eligible learners and at least 50% eligible participation/); // qualified
  assert.match(lb, /middle adjusted-accuracy score among the team's eligible learners/);   // median
  assert.match(lb, /confidence adjustment so a very small number of games doesn't dominate/); // adjusted accuracy
});

test("tooltip numbers are derived from the payload, never hard-coded", () => {
  assert.match(lb, /\$\{t\.eligible_members\} of the team's \$\{t\.active_learners\} active learners/);
  assert.ok(!/2 of the team's 3/.test(lb), "must not hard-code 2/3");
  assert.ok(!/66\.7/.test(lb), "must not hard-code 66.7% participation");
});

test("tooltips never imply ineligible learners performed poorly", () => {
  assert.ok(!/perform(ed)? poorly|did (badly|poorly)|low performers?/i.test(lb));
});
