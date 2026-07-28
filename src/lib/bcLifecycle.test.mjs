// Battle Card lifecycle + tags-only taxonomy — frontend/migration guards.
// Run: node src/lib/bcLifecycle.test.mjs   (no creds, no DB, no browser)
//
// contentService.js imports the supabase client (import.meta.env), so it can't be
// imported in plain Node. This test (a) really executes the pure normalizeCardTags
// logic, and (b) asserts the structural invariants in rankd-app.jsx /
// contentService.js / migrations. Runtime UI behaviour is exercised in live QA.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const svc = readFileSync(join(here, "contentService.js"), "utf8");
const mig068 = readFileSync(join(here, "..", "..", "supabase", "migrations", "068_battle_card_lifecycle.sql"), "utf8");
const mig069 = readFileSync(join(here, "..", "..", "supabase", "migrations", "069_battle_card_category_to_tag.sql"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// ── (a) Real behaviour: normalizeCardTags ────────────────────────────────────
const m = svc.match(/function normalizeCardTags\(tags\)\s*\{[\s\S]*?\n\}/);
ok("normalizeCardTags is defined", !!m);
if (m) {
  const normalizeCardTags = new Function(`${m[0]}; return normalizeCardTags;`)(); // eslint-disable-line no-new-func
  ok("trims whitespace", JSON.stringify(normalizeCardTags(["  aws  "])) === JSON.stringify(["aws"]));
  ok("drops blank/whitespace-only tags", JSON.stringify(normalizeCardTags(["", "   ", "x"])) === JSON.stringify(["x"]));
  ok("dedupes case-insensitively, keeps first casing/order",
     JSON.stringify(normalizeCardTags(["AWS", "aws", "Azure", "  aws"])) === JSON.stringify(["AWS", "Azure"]));
  ok("preserves existing distinct tags",
     JSON.stringify(normalizeCardTags(["gcp", "aws", "azure"])) === JSON.stringify(["gcp", "aws", "azure"]));
  ok("handles nullish input", JSON.stringify(normalizeCardTags(null)) === "[]");
}

// ── (b) Service: tags-only; category CRUD removed; provenance server-authoritative
const cardToDb = svc.match(/function cardToDb\([\s\S]*?\n\}/)?.[0] ?? "";
ok("cardToDb sends no client provenance", !/created_by/.test(cardToDb) && !/updated_at/.test(cardToDb));
ok("cardToDb carries NO category_id (tags-only)", !/category_id/.test(cardToDb));
ok("cardToDb normalizes tags", /normalizeCardTags\(card\.tags\)/.test(cardToDb));
ok("dbToCard exposes NO categoryId", !/categoryId/.test(svc.match(/function dbToCard\([\s\S]*?\n\}/)?.[0] ?? ""));
ok("canonical setBattleCardArchived exists and only flips status",
   /export async function setBattleCardArchived/.test(svc) && /\.update\(\{ status: archived \? "archived" : "active" \}\)/.test(svc));
ok("hard-delete deleteBattleCard export removed", !/export async function deleteBattleCard/.test(svc));
ok("category service CRUD removed (getTenantBcCategories/saveBcCategory/deleteBcCategory)",
   !/export async function getTenantBcCategories/.test(svc) && !/export async function saveBcCategory/.test(svc) && !/export async function deleteBcCategory/.test(svc));
ok("service does not read/write tenant_bc_categories", !/\.from\("tenant_bc_categories"\)/.test(svc));
ok("service never calls .delete() on tenant_battle_cards",
   !/from\("tenant_battle_cards"\)[\s\S]{0,80}\.delete\(\)/.test(svc));

// ── (b) Migration 068: client hard-delete of cards closed at the DB (unchanged) ─
ok("068 drops the card DELETE policy", /DROP POLICY IF EXISTS bc_cards_admin_delete ON public\.tenant_battle_cards/.test(mig068));
ok("068 revokes DELETE on cards from authenticated + anon",
   /REVOKE DELETE ON public\.tenant_battle_cards FROM authenticated/.test(mig068) && /REVOKE DELETE ON public\.tenant_battle_cards FROM anon/.test(mig068));

// ── (b) Migration 069: durable category→tag conversion, generic + safe ───────
ok("069 exists and converts category label → tag by appending (no overwrite)",
   /c\.tags \|\| ARRAY\[btrim\(g\.label\)\]/.test(mig069) && /category_id = NULL/.test(mig069));
ok("069 dedupes case-insensitively (no duplicate label tag)", /lower\(x\) = lower\(btrim\(g\.label\)\)/.test(mig069));
ok("069 skips blank labels (no invented/empty tag)", /btrim\(g\.label\) = ''/.test(mig069));
ok("069 preserves provenance by disabling the 068 trigger during the data change",
   /DISABLE TRIGGER trg_touch_tenant_battle_cards/.test(mig069) && /ENABLE TRIGGER trg_touch_tenant_battle_cards/.test(mig069));
ok("069 hardcodes no row/category IDs", !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(mig069));
ok("069 keeps the legacy category table (no DROP TABLE / DELETE of categories)",
   !/DROP TABLE/i.test(mig069) && !/DELETE FROM public\.tenant_bc_categories/.test(mig069));

// ── (b) rankd-app: categories fully removed from the Battle Card path ────────
ok("no bcCategories state anywhere", !/bcCategories|setBcCategories/.test(app));
ok("no INITIAL_BC_CATEGORIES constant", !/INITIAL_BC_CATEGORIES/.test(app));
ok("no category service imports / handlers", !/getTenantBcCategories|handleSaveBcCategory|handleDeleteBcCategory|dbSaveBcCategory|dbDeleteBcCategory/.test(app));

// ── (b) Shared filter helpers + tag chips (Quiz-style visual behavior) ───────
ok("BcTagFilters chip component exists (All + tag pills)", /function BcTagFilters\(/.test(app) && /All \(\$\{allCount\}\)/.test(app.replace(/`/g, "")) || /All \(\{allCount\}\)/.test(app) || /All \(/.test(app.slice(app.indexOf("function BcTagFilters("), app.indexOf("function BcTagFilters(") + 900)));
ok("search covers title/subtitle/summary/tags", /bcMatchesSearch/.test(app) && /c\.summary/.test(app) && /bcCardTags\(c\)\.some/.test(app));

// ── (b) Manager screen: one list (active+archived), tags-only editor, ≥1 tag ─
const adminStart = app.indexOf("function BattleCardsAdminScreen(");
const admin = app.slice(adminStart, app.indexOf("function BattleCardsScreen(", adminStart));
ok("manager splits active vs archived", /const activeCards\s+=/.test(admin) && /const archivedCards\s+=/.test(admin));
ok("manager archive/restore via canonical onSetArchived", /onSetArchived\(/.test(admin));
ok("manager exposes NO permanent Delete", !/title="Delete"/.test(admin) && !/permanently removed/.test(admin));
ok("manager has NO category UI/selectors/Uncategorized", !/Uncategorized/.test(admin) && !/categor/i.test(admin));
ok("editor requires >=1 tag (honest block + message)", /if \(tags\.length === 0\) \{ setShowTagError\(true\); return; \}/.test(admin) && /Add at least one tag before saving/.test(admin));
ok("editor has a tag authoring control", /const addTag = /.test(admin) && /const removeTag = /.test(admin));
ok("manager renders tag filter chips", /<BcTagFilters/.test(admin));
ok("manager active count uses filtered active source", /Active · \{filteredActive\.length\}/.test(admin));
ok("manager honest load error + retry", /Couldn't load battle cards/.test(admin));

// ── (b) Learner screen: active-only, tags-only, no categories ────────────────
const learnerStart = app.indexOf("function BattleCardsScreen(");
const learner = app.slice(learnerStart, app.indexOf("function ViewAllToggle(", learnerStart));
ok("learner shows active only", /visibleCards = cards\.filter\(c => !bcIsArchived\(c\)\)/.test(learner));
ok("learner has NO category language", !/categor/i.test(learner));
ok("learner renders tag filter chips + search", /<BcTagFilters/.test(learner) && /placeholder="Title, subtitle, summary, tags/.test(learner));
ok("learner error guard before empty state", learner.indexOf("if (loadError)") > -1 && learner.indexOf("if (loadError)") < learner.indexOf("No battle cards yet"));
ok("learner persists list/filter state across nav (sessionStorage)", /ralli_bc_search/.test(learner) && /ralli_bc_tags/.test(learner));

// ── (b) Detail view: distinct hierarchy, no filter controls, responsive ──────
const detail = app.slice(app.indexOf("function BattleCardDetail("), app.indexOf("function BattleCardsAdminScreen("));
ok("detail has a Back to Battle Cards action", /← Back to Battle Cards/.test(detail));
ok("detail header shows tags", /bcCardTags\(card\)\.map/.test(detail));
ok("detail has NO tag-filter controls", !/BcTagFilters/.test(detail));
ok("detail grid is responsive (auto-fit, not fixed 3-col)",
   /repeat\(auto-fit, minmax\(240px, 1fr\)\)/.test(detail) && !/gridTemplateColumns: "1fr 1fr 1fr"/.test(detail));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
