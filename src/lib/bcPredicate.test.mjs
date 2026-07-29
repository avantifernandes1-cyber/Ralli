// Battle Cards — search/tag predicate, required-field validation, and tag-picker
// guards. Run: node src/lib/bcPredicate.test.mjs   (no creds, no DB, no browser)
//
// Extracts and REALLY EXECUTES the pure helpers from rankd-app.jsx, then asserts:
//  - tag-filter is an EXACT normalized match (tag "tag 1" ≠ "tag 10"/"tag"/title text)
//  - free-text search scope = title/subtitle/summary/tags (a title containing "tag"
//    correctly matches free-text "tag" — the proven source of the reported result)
//  - required-field validation (Title, Tags, Strengths, Weaknesses, Why We Win)
//  - the Quiz-style tag picker + suggestion derivation are wired (structural)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };
const grab = (re) => { const m = app.match(re); if (!m) throw new Error("could not extract: " + re); return m[0]; };

// ── Extract + eval the pure helpers together ─────────────────────────────────
const src = [
  grab(/function bcCardTags\([\s\S]*?\n\}/),
  grab(/function bcPlainText\([\s\S]*?\n\}/),   // rich-text bodies: readable text for search + meaningful-empty validation
  grab(/function bcMatchesSearch\([\s\S]*?\n\}/),
  grab(/function bcMatchesTags\([\s\S]*?\n\}/),
  grab(/function bcDistinctTags\([\s\S]*?\n\}/),
  grab(/const BC_REQUIRED_TEXT_FIELDS = \[[\s\S]*?\];/),
  grab(/function bcInvalidFields\([\s\S]*?\n\}/),
].join("\n");
const H = new Function(`${src}; return { bcPlainText, bcMatchesSearch, bcMatchesTags, bcDistinctTags, bcInvalidFields };`)(); // eslint-disable-line no-new-func

// Production-like data (post-069): the reported card set.
const cards = [
  { id: "528e1a06", title: "Avanti Battle Card", subtitle: "Persona Training", summary: "kj;jjhjk", tags: ["personality", "tag 1"], status: "active" },
  { id: "ff7b4997", title: "without a tag",      subtitle: "nothing",          summary: "",         tags: ["persona"],              status: "active" },
  { id: "302e519c", title: "okay",               subtitle: "",                 summary: "",         tags: ["tada", "tag 1"],        status: "active" },
];
const ids = (f) => cards.filter(f).map(c => c.id).join(",");
const tagSet = (...t) => new Set(t.map(x => x.toLowerCase()));

// ── (1) Tag filter is EXACT ──────────────────────────────────────────────────
ok("tag chip 'tag 1' matches only the two cards tagged 'tag 1'",
   ids(c => H.bcMatchesTags(c, tagSet("tag 1"))) === "528e1a06,302e519c");
ok("tag chip 'tag 1' does NOT match card titled 'without a tag' (tags=[persona])",
   H.bcMatchesTags(cards[1], tagSet("tag 1")) === false);
ok("tag chip 'tag 1' does NOT match a card tagged 'tag 10'",
   H.bcMatchesTags({ tags: ["tag 10"] }, tagSet("tag 1")) === false);
ok("tag chip 'tag 1' does NOT match a card tagged 'tag'",
   H.bcMatchesTags({ tags: ["tag"] }, tagSet("tag 1")) === false);
ok("tag chip is case-insensitive exact ('TAG 1' selects 'tag 1')",
   H.bcMatchesTags({ tags: ["tag 1"] }, tagSet("TAG 1")) === true);
ok("empty tag selection matches everything (All)", H.bcMatchesTags(cards[0], new Set()) === true);

// ── (2) Free-text scope (proven source of the reported result) ───────────────
ok("free-text 'tag' matches title 'without a tag' (title scope, not a tag)",
   H.bcMatchesSearch(cards[1], "tag") === true && cards[1].tags.includes("tag") === false);
ok("free-text 'tag 1' does NOT surface 'without a tag'",
   H.bcMatchesSearch(cards[1], "tag 1") === false);
ok("free-text matches subtitle", H.bcMatchesSearch(cards[0], "persona training") === true);
ok("free-text empty matches everything", H.bcMatchesSearch(cards[1], "") === true);

// ── (3) AND combination (search + tag) ───────────────────────────────────────
const both = (c, q, tags) => H.bcMatchesSearch(c, q) && H.bcMatchesTags(c, tags);
ok("search 'okay' AND tag 'tag 1' → only card 302e519c",
   ids(c => both(c, "okay", tagSet("tag 1"))) === "302e519c");
ok("search 'tag' AND tag 'tag 1' → excludes 'without a tag' (no tag 1) ",
   ids(c => both(c, "tag", tagSet("tag 1"))) === "528e1a06,302e519c");

// ── (4) Tag universe excludes archived-only tags ─────────────────────────────
const withArchived = [...cards, { id: "arc", title: "arc", tags: ["archivedonly"], status: "archived" }];
const activeOnly = withArchived.filter(c => c.status !== "archived");
ok("bcDistinctTags(active) excludes an archived-only tag",
   !H.bcDistinctTags(activeOnly).map(t => t.toLowerCase()).includes("archivedonly"));

// ── (5) Required-field validation ────────────────────────────────────────────
const full = { title: "T", strength: "s", weakness: "w", ourWin: "o" };
ok("valid card + ≥1 tag → no invalid fields", H.bcInvalidFields(full, ["x"]).length === 0);
ok("blank strength/weakness/ourWin are invalid",
   JSON.stringify(H.bcInvalidFields({ title: "T", strength: "", weakness: "  ", ourWin: "" }, ["x"])) === JSON.stringify(["strength", "weakness", "ourWin"]));
ok("no tags → 'tags' invalid", H.bcInvalidFields(full, []).includes("tags"));
ok("whitespace-only title is invalid", H.bcInvalidFields({ ...full, title: "   " }, ["x"]).includes("title"));
ok("invalid order is editor order (title, tags, strength, weakness, ourWin)",
   JSON.stringify(H.bcInvalidFields({ title: "", strength: "", weakness: "", ourWin: "" }, [])) === JSON.stringify(["title", "tags", "strength", "weakness", "ourWin"]));
ok("production card 'without a tag' (blank core fields) would be invalid",
   H.bcInvalidFields({ title: "without a tag", strength: "", weakness: "", ourWin: "" }, ["persona"]).length === 3);

// ── (6) Structural: picker + wiring ──────────────────────────────────────────
ok("BcTagPicker component exists (create + no-dup logic)",
   /function BcTagPicker\(/.test(app) && /const canCreate = typed && !alreadySelected && !exactMatch/.test(app));
// Reuses the ACTUAL Quiz builder surface: TagChip for selected tags, the same
// ClassificationBadge state, and the "+ Add a tag…" <select> for existing tags.
ok("picker reuses Quiz TagChip for selected tags",
   /\(selected \?\? \[\]\)\.map\(t => <TagChip key=\{t\} label=\{t\} onRemove/.test(app));
ok("picker reuses Quiz '+ Add a tag…' select + tagged/tag_required badge",
   /\+ Add a tag…/.test(app) && /<ClassificationBadge state=\{hasTags \? "tagged" : "tag_required"\}/.test(app));
const admin = app.slice(app.indexOf("function BattleCardsAdminScreen("), app.indexOf("function BattleCardsScreen("));
ok("editor uses BcTagPicker with tenant suggestions", /<BcTagPicker/.test(admin) && /const tagSuggestions = /.test(admin));
ok("suggestions include the edited card's own tags (archived-only-it-uses shown)", /for \(const t of \(draft\.tags \?\? \[\]\)\)/.test(admin));
ok("saveCard blocks on invalid + focuses first invalid field", /bcInvalidFields\(draft, tags\)/.test(admin) && /fieldRefs\.current\[invalid\[0\]\]/.test(admin) && /\.focus\(/.test(admin));
ok("save failure shows no toast/nav (returns before onSaveCard)", /if \(invalid\.length > 0\) \{[\s\S]*?return;[\s\S]*?\}/.test(admin));
ok("archived list uses the SAME predicate as active", /const filteredArchived = archivedCards\.filter\(matchesFilters\)/.test(admin));
ok("Clear/All resets search AND tags (both surfaces)",
   (app.match(/const resetFilters = \(\) => \{ setSearch\(""\); setSelected\(new Set\(\)\); \}/g) || []).length >= 2);
ok("search scope is explained in the UI", /Search matches titles, subtitles, summaries, and tags\./.test(app));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
