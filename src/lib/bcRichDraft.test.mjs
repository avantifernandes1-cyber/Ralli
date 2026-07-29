// Battle Cards — shared Lesson rich-text reuse + safety, meaningful-content
// validation, and durable-draft scoping/isolation.
// Run: node src/lib/bcRichDraft.test.mjs   (no creds, no DB, no browser)
//
// Extracts and REALLY EXECUTES the pure helpers from rankd-app.jsx, then asserts:
//  - bcPlainText yields readable text (search) and meaningful-empty (validation):
//    whitespace / empty lists / formatting-only markup all strip to "" (fail),
//    real formatted text keeps its words (pass)
//  - the Lesson rich-text editor/renderer is REUSED (one implementation), and the
//    render path is injection-safe by construction (no dangerouslySetInnerHTML)
//  - draft keys isolate by tenant + user + create-vs-edit + card id, and sign-out
//    clears every draft
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };
const grab = (re) => { const m = app.match(re); if (!m) throw new Error("could not extract: " + re); return m[0]; };

// ── Extract + eval the pure helpers ──────────────────────────────────────────
const src = [
  grab(/function bcPlainText\([\s\S]*?\n\}/),
  grab(/const BC_DRAFT_PREFIX = "[^"]*";/),
  grab(/function bcDraftKey\([\s\S]*?\n\}/),
  grab(/function bcRelativeTime\([\s\S]*?\n\}/),
  grab(/const BC_REQUIRED_TEXT_FIELDS = \[[\s\S]*?\];/),
  grab(/function bcInvalidFields\([\s\S]*?\n\}/),
].join("\n");
const H = new Function(`${src}; return { bcPlainText, bcDraftKey, bcRelativeTime, bcInvalidFields };`)(); // eslint-disable-line no-new-func

// ── (1) bcPlainText: readable text + meaningful-empty ────────────────────────
ok("empty string → '' (meaningful-empty)", H.bcPlainText("") === "");
ok("whitespace/newlines → '' (meaningful-empty)", H.bcPlainText("   \n  \n ") === "");
ok("empty bullet list markers → '' (formatting only, no text)", H.bcPlainText("- \n- \n- ") === "");
ok("empty numbered markers → ''", H.bcPlainText("1. \n2. ") === "");
ok("empty bold markers → '' (formatting only)", H.bcPlainText("****") === "" && H.bcPlainText("**   **") === "");
ok("real bold text keeps its words", H.bcPlainText("**Fast** setup") === "Fast setup");
ok("underline + italic markup stripped to visible text", H.bcPlainText("__key__ and *win*") === "key and win");
ok("bullet list → readable joined text (list markers stripped)",
   H.bcPlainText("- alpha\n- beta") === "alpha beta");
ok("numbered list → readable joined text",
   H.bcPlainText("1. first\n2. second") === "first second");
ok("nullish → ''", H.bcPlainText(null) === "" && H.bcPlainText(undefined) === "");

// ── (2) Required rich-text validation uses meaningful visible text ───────────
const base = { title: "T" };
ok("formatting-only body FAILS required (empty lists/bold)",
   JSON.stringify(H.bcInvalidFields({ ...base, strength: "- \n- ", weakness: "****", ourWin: "   " }, ["x"]))
   === JSON.stringify(["strength", "weakness", "ourWin"]));
ok("real formatted body SATISFIES required",
   H.bcInvalidFields({ ...base, strength: "**Fast** onboarding", weakness: "- slow\n- pricey", ourWin: "We win on __service__" }, ["x"]).length === 0);
ok("title stays plain-text validated (whitespace-only invalid)",
   H.bcInvalidFields({ title: "   ", strength: "x", weakness: "y", ourWin: "z" }, ["x"]).includes("title"));

// ── (3) Draft key scoping + isolation ────────────────────────────────────────
const K = H.bcDraftKey;
ok("draft keys are prefixed (scannable for sign-out clear)", K("t1", "u1", "new").startsWith("ralli_bc_draft_"));
ok("tenant isolation: different tenant → different key", K("t1", "u1", "new") !== K("t2", "u1", "new"));
ok("user isolation: different user → different key", K("t1", "u1", "new") !== K("t1", "u2", "new"));
ok("create vs edit are separate drafts", K("t1", "u1", "new") !== K("t1", "u1", "card-9"));
ok("per-card edit drafts are separate", K("t1", "u1", "card-9") !== K("t1", "u1", "card-10"));
ok("missing tenant/user fall back to demo/guest (never blank/global)",
   K(null, null, "new") === "ralli_bc_draft_demo_guest_new");
ok("same identity + target is stable (resume finds it)", K("t1", "u1", "card-9") === K("t1", "u1", "card-9"));

// ── (4) bcRelativeTime executes ──────────────────────────────────────────────
ok("relative time: now → 'just now'", H.bcRelativeTime(Date.now()) === "just now");
ok("relative time: ~5 min ago", H.bcRelativeTime(Date.now() - 5 * 60_000) === "5 minutes ago");
ok("relative time: falsy → 'just now'", H.bcRelativeTime(0) === "just now");

// ── (5) Structural: ONE shared Lesson rich-text implementation (no duplication)
ok("single mdToHtml + htmlToMd definitions", (app.match(/function mdToHtml\(/g) || []).length === 1 && (app.match(/function htmlToMd\(/g) || []).length === 1);
ok("single MarkdownEditor editor component", (app.match(/function MarkdownEditor\(/g) || []).length === 1);
ok("single renderMarkdown renderer", (app.match(/function renderMarkdown\(/g) || []).length === 1);
// LessonBlock (learner lessons) and the Battle Card detail render via the SAME renderer.
const lessonBlock = app.slice(app.indexOf("function LessonBlock("), app.indexOf("function LessonBlock(") + 4000);
ok("LessonBlock renders via shared renderMarkdown", /renderMarkdown\(c\.body\)/.test(lessonBlock));
const detail = app.slice(app.indexOf("function BattleCardDetail("), app.indexOf("function BattleCardsAdminScreen("));
ok("BattleCardDetail renders every rich field via renderMarkdown",
   /renderMarkdown\(card\.summary\)/.test(detail) && /renderMarkdown\(card\.strength\)/.test(detail)
   && /renderMarkdown\(card\.weakness\)/.test(detail) && /renderMarkdown\(card\.ourWin\)/.test(detail)
   && /renderMarkdown\(card\.talkTrack\)/.test(detail) && /renderMarkdown\(section\.body\)/.test(detail));

// ── (6) Editor: rich fields use MarkdownEditor; plain fields stay plain ───────
const admin = app.slice(app.indexOf("function BattleCardsAdminScreen("), app.indexOf("function BattleCardsScreen("));
ok("editor rich bodies use MarkdownEditor (summary/strength/weakness/ourWin/talkTrack)",
   /value=\{draft\.summary \?\? ""\} onChange=\{setRich\("summary"\)\}/.test(admin)
   && /onChange=\{setRich\("strength"\)\}/.test(admin) && /onChange=\{setRich\("weakness"\)\}/.test(admin)
   && /onChange=\{setRich\("ourWin"\)\}/.test(admin) && /onChange=\{setRich\("talkTrack"\)\}/.test(admin));
ok("In-Depth section body uses MarkdownEditor; heading stays a plain input",
   /onChange=\{v => setSection\(i, "body", v\)\}/.test(admin) && /setSection\(i, "heading", e\.target\.value\)/.test(admin));
ok("Title stays plain input (setF), not rich", /value=\{draft\.title\} onChange=\{setF\("title"\)\}/.test(admin));
ok("save strips UI-only section _id (DB content stays clean)",
   /\(draft\.content \?\? \[\]\)\.map\(\(\{ heading, body \}\) => \(\{ heading, body \}\)\)/.test(admin));

// ── (7) Safety: injection-safe render path (React elements, never raw HTML) ──
ok("no dangerouslySetInnerHTML anywhere", !/dangerouslySetInnerHTML/.test(app));
ok("editor syncs contentEditable back to markdown via htmlToMd (not stored as HTML)",
   /const md = htmlToMd\(editRef\.current\)/.test(app));

// ── (8) Draft lifecycle wiring ──────────────────────────────────────────────
ok("autosave persists draft while editing (localStorage.setItem of {draft, savedAt})",
   /localStorage\.setItem\(key, JSON\.stringify\(\{ draft, savedAt: Date\.now\(\) \}\)\)/.test(admin));
ok("clean editor stores nothing (removeItem when not dirty)", /else localStorage\.removeItem\(key\)/.test(admin));
ok("Resume applies the stored draft; Discard clears ONLY this target",
   /const resumeDraft = \(\)/.test(admin) && /const discardDraft = \(\)/.test(admin)
   && /localStorage\.removeItem\(bcDraftKey\(draftTenant, draftUser, editingCard\)\)/.test(admin));
ok("newer-server-content guard before resume", /serverNewer/.test(admin) && /savedDay < baseCard\.updatedAt/.test(admin));
ok("successful save clears this card's draft", /pendingResumeRef\.current = null; setResumeInfo\(null\);\n\s*goList\(\);/.test(admin) || /removeItem\(bcDraftKey\(draftTenant, draftUser, editingCard\)\)[\s\S]{0,120}goList\(\)/.test(admin));
ok("sign-out clears every Battle Card draft (>=3 sign-out paths)",
   (app.match(/clearBattleCardDrafts\(\);/g) || []).length >= 3);
ok("clearBattleCardDrafts prefix-scans localStorage", /k\.startsWith\(BC_DRAFT_PREFIX\)/.test(app));
ok("admin screen receives scoped identity (tenantId + userId)",
   /tenantId=\{currentOrg\?\.id \?\? user\?\.orgId \?\? null\} userId=\{user\?\.id \?\? null\}/.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
