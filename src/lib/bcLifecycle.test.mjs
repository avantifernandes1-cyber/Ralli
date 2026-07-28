// Battle Card lifecycle — frontend guards (migration 068 slice).
// Run: node src/lib/bcLifecycle.test.mjs   (no creds, no DB, no browser)
//
// contentService.js imports the supabase client (import.meta.env), so it can't be
// imported in plain Node. This test (a) extracts and really executes the pure
// normalizeCardTags logic, and (b) asserts the structural invariants of the slice
// in rankd-app.jsx / contentService.js source. Runtime UI behaviour is exercised
// in live QA per the deployment sequence.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const svc = readFileSync(join(here, "contentService.js"), "utf8");
const mig = readFileSync(join(here, "..", "..", "supabase", "migrations", "068_battle_card_lifecycle.sql"), "utf8");

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// ── (a) Real behaviour: normalizeCardTags ────────────────────────────────────
const m = svc.match(/function normalizeCardTags\(tags\)\s*\{[\s\S]*?\n\}/);
ok("normalizeCardTags is defined in contentService", !!m);
if (m) {
  // eslint-disable-next-line no-new-func
  const normalizeCardTags = new Function(`${m[0]}; return normalizeCardTags;`)();
  ok("trims whitespace", JSON.stringify(normalizeCardTags(["  aws  "])) === JSON.stringify(["aws"]));
  ok("drops blank/whitespace-only tags", JSON.stringify(normalizeCardTags(["", "   ", "x"])) === JSON.stringify(["x"]));
  ok("dedupes case-insensitively, keeps first casing/order",
     JSON.stringify(normalizeCardTags(["AWS", "aws", "Azure", "  aws"])) === JSON.stringify(["AWS", "Azure"]));
  ok("preserves existing distinct tags",
     JSON.stringify(normalizeCardTags(["gcp", "aws", "azure"])) === JSON.stringify(["gcp", "aws", "azure"]));
  ok("handles non-array / nullish input", JSON.stringify(normalizeCardTags(null)) === "[]" && JSON.stringify(normalizeCardTags(undefined)) === "[]");
}

// ── (b) Service: server-authoritative provenance + canonical archive path ────
const cardToDb = svc.match(/function cardToDb\([\s\S]*?\n\}/)?.[0] ?? "";
const catToDb  = svc.match(/function categoryToDb\([\s\S]*?\n\}/)?.[0] ?? "";
ok("cardToDb no longer sends created_by (trigger owns it)", !/created_by/.test(cardToDb));
ok("cardToDb no longer sends updated_at (server clock)", !/updated_at/.test(cardToDb));
ok("cardToDb normalizes tags", /normalizeCardTags\(card\.tags\)/.test(cardToDb));
ok("categoryToDb no longer sends created_by/updated_at", !/created_by/.test(catToDb) && !/updated_at/.test(catToDb));
ok("canonical setBattleCardArchived exists and only flips status",
   /export async function setBattleCardArchived/.test(svc) && /\.update\(\{ status: archived \? "archived" : "active" \}\)/.test(svc));
ok("hard-delete deleteBattleCard export removed", !/export async function deleteBattleCard/.test(svc));
ok("getTenantBattleCards selects status + archived_at", /getTenantBattleCards[\s\S]*?status, archived_at/.test(svc));
// No .delete() on the cards table anywhere in the service (categories may still delete).
ok("service never calls .delete() on tenant_battle_cards",
   !/from\("tenant_battle_cards"\)[\s\S]{0,80}\.delete\(\)/.test(svc));

// ── (b) Migration 068: client hard-delete of cards is closed at the DB ────────
ok("068 drops the card DELETE policy", /DROP POLICY IF EXISTS bc_cards_admin_delete ON public\.tenant_battle_cards/.test(mig));
ok("068 revokes DELETE on cards from authenticated", /REVOKE DELETE ON public\.tenant_battle_cards FROM authenticated/.test(mig));
ok("068 revokes DELETE on cards from anon", /REVOKE DELETE ON public\.tenant_battle_cards FROM anon/.test(mig));
ok("068 does NOT touch category DELETE (unchanged)", !/bc_categories_admin_delete/.test(mig) && !/REVOKE DELETE ON public\.tenant_bc_categories/.test(mig));
ok("068 adds no client-facing hard-delete RPC", !/CREATE (OR REPLACE )?FUNCTION[^;]*delete[^;]*battle/i.test(mig));

// ── (b) rankd-app: learner filtering, honest states, no demo flash ───────────
const learnerStart = app.indexOf("function BattleCardsScreen(");
const learner = app.slice(learnerStart, learnerStart + 14000);
ok("learner filters archived out (visibleCards, status !== archived)",
   /visibleCards = cards\.filter\(c => \(c\.status \?\? "active"\) !== "archived"\)/.test(learner));
ok("learner error guard returns BEFORE the empty state",
   learner.indexOf("if (loadError)") > -1 && learner.indexOf("if (loadError)") < learner.indexOf("No battle cards yet"));
ok("learner Retry wired", /onRetry\?\.\(\)/.test(learner));
ok("learner category count uses active cards", /const count = visibleCards\.filter/.test(learner));

// ── (b) rankd-app: manager active/archived split, archive/restore, no delete ─
const adminStart = app.indexOf("function BattleCardsAdminScreen(");
const admin = app.slice(adminStart, app.indexOf("function BattleCardDetail(", adminStart));
ok("manager splits active vs archived", /const activeCards\s+=/.test(admin) && /const archivedCards\s+=/.test(admin));
ok("manager has archive + restore via canonical onSetArchived", /onSetArchived\(/.test(admin));
ok("manager card rows expose no permanent Delete", !/title="Delete"/.test(admin) && !/permanently removed/.test(admin));
ok("editor has explicit Uncategorized option", /<option value="">Uncategorized<\/option>/.test(admin));
ok("editor has a tags authoring control", /const addTag = /.test(admin) && /const removeTag = /.test(admin));
ok("manager category count uses active cards", /const count = activeCards\.filter/.test(admin));
ok("manager honest load error + retry", /Couldn't load battle cards/.test(admin));

// ── (b) rankd-app: App load lifecycle + no-flash gating + responsive detail ──
ok("load effect surfaces error (not silent empty)", /if \(catErr \|\| cardErr\) \{ setBcError/.test(app));
ok("bcLoaded gates render so no demo flash for real tenants", /!bcLoaded && !bcError/.test(app));
ok("archive/restore handler is the single UI path", /handleSetBattleCardArchived/.test(app) && !/handleDeleteBattleCard/.test(app));
const detail = app.slice(app.indexOf("function BattleCardDetail("), app.indexOf("function BattleCardDetail(") + 3000);
ok("detail grid is responsive (auto-fit, not fixed 3-col)",
   /repeat\(auto-fit, minmax\(240px, 1fr\)\)/.test(detail) && !/gridTemplateColumns: "1fr 1fr 1fr"/.test(detail));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
