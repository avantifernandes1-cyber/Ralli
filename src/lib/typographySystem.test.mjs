// Guards for the canonical typography system (source assertions on index.html + rankd-app.jsx +
// MarketingPage.jsx). Locks: one heading stack (Unbounded) + one body stack (Outfit) defined once;
// meaningful display headings use the heading stack; content/body use Outfit; no stray/unsupported
// font families on customer surfaces; user rich-text formatting is preserved; and no unsafe
// nowrap/overflow was baked into the shared heading rule.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(root, "index.html"), "utf8");
const app = readFileSync(join(root, "rankd-app.jsx"), "utf8");
const mkt = readFileSync(join(root, "src", "MarketingPage.jsx"), "utf8");

test("canonical font stacks are defined exactly once (index.html), heading=Unbounded, body=Outfit", () => {
  assert.equal((html.match(/--font-heading:/g) || []).length, 1);
  assert.equal((html.match(/--font-body:/g) || []).length, 1);
  assert.match(html, /--font-heading:\s*'Unbounded'/);
  assert.match(html, /--font-body:\s*'Outfit'/);
  // both stacks carry a real system fallback (readable if the web font fails)
  assert.match(html, /--font-heading:[^;]*sans-serif;/);
  assert.match(html, /--font-body:[^;]*sans-serif;/);
});

test("body/UI defaults to Outfit; meaningful display headings (h1,h2) use the heading stack", () => {
  assert.match(html, /body\s*\{[^}]*font-family:\s*var\(--font-body\)/s);
  assert.match(html, /h1,\s*h2\s*\{[^}]*font-family:\s*var\(--font-heading\)/);
});

test("content is protected: quiz/lesson/rich-text (.rl-content) stays Outfit even as a heading", () => {
  assert.match(html, /\.rl-content[^{]*:where\(h1, h2, h3, h4, h5, h6\)[^{]*\{[^}]*font-family:\s*var\(--font-body\)/);
  // the Ralli Live / quiz question headings opt into content typography
  assert.ok((app.match(/<h2 className="rl-content"/g) || []).length >= 4, "quiz-question h2s tagged rl-content");
  assert.match(app, /<h2 className="rl-content"[^>]*>\{q\.q\}<\/h2>/);
});

test("no Inter (or other unintended family) remains on customer surfaces", () => {
  assert.ok(!/Inter/.test(html), "index.html no longer loads Inter");
  assert.ok(!/fontFamily[^\n]*Inter/.test(app), "no Inter fontFamily in the app");
  assert.ok(!/fontFamily[^\n]*Inter/.test(mkt), "no Inter fontFamily in marketing");
  // app no longer hard-codes raw family strings — it uses the tokens/vars
  assert.ok(!/'Unbounded', sans-serif/.test(app), "leaderboard Unbounded consolidated to the token");
});

test("no conflicting runtime font override (Plus Jakarta Sans injection removed)", () => {
  assert.ok(!/Plus Jakarta/i.test(app.replace(/\/\/[^\n]*/g, "")), "no Plus Jakarta Sans family in non-comment code");
  assert.ok(!/document\.body\.style\.fontFamily\s*=/.test(app), "body font is not overridden at runtime");
  assert.ok(!/fonts\.googleapis\.com/.test(app), "no dynamic Google-Fonts injection in the bundle (fonts load once from index.html)");
});

test("font loader only requests AVAILABLE weights (Outfit + Unbounded incl. 900); no unsupported request", () => {
  const link = (html.match(/fonts\.googleapis\.com\/css2\?[^"']+/) || [""])[0];
  assert.match(link, /Outfit:wght@[0-9;]*900/);
  assert.match(link, /Unbounded:wght@[0-9;]*900/);
  assert.ok(!/Inter/.test(link), "Inter dropped from the font request");
});

test("TYPO tokens exist and the leaderboard podium uses the heading token (single source)", () => {
  assert.match(app, /const TYPO = \{[\s\S]*headingFont:\s*"var\(--font-heading\)"[\s\S]*bodyFont:\s*"var\(--font-body\)"/);
  assert.ok((app.match(/TYPO\.headingFont/g) || []).length >= 3, "podium headings use TYPO.headingFont");
});

test("semantic opt-in classes exist for div-based titles and supporting text", () => {
  for (const cls of ["ty-page-title", "ty-section-title", "ty-card-title", "ty-modal-title", "ty-subtitle", "ty-body", "ty-label"]) {
    assert.match(html, new RegExp(`\\.${cls}\\s*\\{`), `${cls} defined`);
  }
});

test("accessibility: keyboard focus ring + reduced-motion are respected", () => {
  assert.match(html, /:focus-visible\s*\{[^}]*outline:/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
});

test("user rich-text formatting is preserved (renderMarkdown still emits lists/paragraphs + inline)", () => {
  const md = app.slice(app.indexOf("function renderMarkdown"), app.indexOf("function renderMarkdown") + 1600);
  assert.match(md, /<ul/); assert.match(md, /<ol/); assert.match(md, /<li/); assert.match(md, /<p/);
  assert.match(app, /parseInlineMarkdown/);
});

test("the shared heading rule does not force nowrap/overflow (headings can wrap safely)", () => {
  const rule = (html.match(/h1,\s*h2\s*\{[^}]*\}/) || [""])[0];
  assert.ok(!/white-space:\s*nowrap/.test(rule));
  assert.ok(!/overflow:\s*hidden/.test(rule));
});
