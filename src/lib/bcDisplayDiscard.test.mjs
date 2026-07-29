// Battle Cards — PROS/CONS display copy, Quiz-style card visuals, and the
// in-editor Discard / Back-warning flow. Structural guards only; the visual
// match is validated side-by-side in a real browser (see the correction report).
// Run: node src/lib/bcDisplayDiscard.test.mjs   (no creds, no DB, no browser)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = readFileSync(join(here, "..", "..", "rankd-app.jsx"), "utf8");
const detail = app.slice(app.indexOf("function BattleCardDetail("), app.indexOf("function BattleCardsAdminScreen("));
const admin  = app.slice(app.indexOf("function BattleCardsAdminScreen("), app.indexOf("function BattleCardsScreen("));

let pass = 0, fail = 0;
const ok = (n, cond, extra = "") => { if (cond) { pass++; console.log("PASS  " + n); } else { fail++; console.log("FAIL  " + n + (extra ? "  → " + extra : "")); } };

// ── (3) THEIR STRENGTHS / THEIR WEAKNESSES — restored labels in manager +
//        preview/learner surfaces; PROS/CONS (any casing) must NOT appear ──────
ok("detail shows THEIR STRENGTHS and THEIR WEAKNESSES panel labels",
   />THEIR STRENGTHS</.test(detail) && />THEIR WEAKNESSES</.test(detail));
ok("editor labels are Their Strengths / Their Weaknesses",
   /lbl\("Their Strengths", true\)/.test(admin) && /lbl\("Their Weaknesses", true\)/.test(admin));
ok("no PROS/CONS label anywhere in the Battle Card UI (detail)",
   !/\bPROS\b|\bCONS\b/i.test(detail));
ok("no PROS/CONS (any casing) label in the Battle Card editor/admin",
   !/lbl\("Pros"|lbl\("Cons"|>PROS<|>CONS<|>Pros<|>Cons</i.test(admin));
ok("WHY WE WIN panel is unchanged (not relabelled)", />WHY WE WIN</.test(detail));
ok("db field keys unchanged (strength/weakness/our_win, ourWin) — display-only change",
   /renderMarkdown\(card\.strength\)/.test(detail) && /renderMarkdown\(card\.weakness\)/.test(detail)
   && /setRich\("strength"\)/.test(admin) && /setRich\("weakness"\)/.test(admin));

// ── (2) Quiz-style card display: white surfaces + yellow TagChip pills ───────
ok("BcCardRow surface is white (not cardBg cream)",
   /border: `1px \$\{archived \? "dashed" : "solid"\} \$\{C\.border\}`, background: C\.white/.test(app));
ok("list rows render tags via the Quiz TagChip (yellow pill)",
   /bcCardTags\(card\)\.map\(t => <TagChip key=\{t\} label=\{t\} \/>\)/.test(app));
ok("detail header surface is white + tags via TagChip",
   /background: C\.white, padding: "20px 24px"/.test(detail) && /bcCardTags\(card\)\.map\(t => <TagChip key=\{t\} label=\{t\} \/>\)/.test(detail));
ok("detail PROS/CONS/WHY panels are white surfaces", (detail.match(/background: C\.white \}\}>/g) || []).length >= 3);
ok("selected FILTER chips are solid gold w/ dark text (distinct from pale info pills)",
   /background: on \? C\.orange : C\.white, color: on \? C\.text : C\.textSub/.test(app));
ok("Quiz TagChip component itself is untouched (still orangeLight pale pill)",
   /background: archived \? C\.muted : C\.orangeLight, color: archived \? C\.textMuted : C\.orange/.test(app));

// ── (1) In-editor Discard + Back warning ─────────────────────────────────────
ok("confirmExit state exists (leave keeps draft | discard destroys)", /const \[confirmExit, setConfirmExit\] = useState\(null\)/.test(admin));
ok("editorDirty compares draft to server baseline", /const editorDirty = \(\) => editorBaselineRef\.current != null && JSON\.stringify\(draft\) !== editorBaselineRef\.current/.test(admin));
ok("Back + Cancel both route through attemptLeave (warn when dirty)",
   (admin.match(/onClick=\{attemptLeave\}/g) || []).length >= 2 && /← Battle Cards/.test(admin) && />Cancel</.test(admin));
ok("Discard button shown only when dirty, labelled per new/edit",
   /dirty && \(/.test(admin) && /isNew \? "Discard Draft" : "Discard Changes"/.test(admin));
ok("discardAndExit removes ONLY this scoped draft, no DB write",
   /const discardAndExit = \(\) => \{[\s\S]*?localStorage\.removeItem\(bcDraftKey\(draftTenant, draftUser, editingCard\)\)/.test(admin)
   && !/onSaveCard|deleteBattleCard/.test(app.slice(app.indexOf("const discardAndExit"), app.indexOf("const discardAndExit") + 400)));
ok("discard confirm requires a click-through (no silent discard)",
   /confirmExit === "discard"[\s\S]*?onClick=\{discardAndExit\}/.test(admin));
ok("leave confirm keeps the draft (calls cancelEditCard, not discard)",
   /Your unsaved changes will be kept as a draft/.test(admin));
ok("discard shows no success toast (no toast.success in discard path)",
   !/toast\.success/.test(app.slice(app.indexOf("const discardAndExit"), app.indexOf("const discardAndExit") + 400)));

// ── Regression: draft isolation + guards intact ──────────────────────────────
ok("draft key still scoped by tenant+user+target", /function bcDraftKey\(tenant, user, target\)/.test(app));
ok("sign-out still clears all drafts (>=3 paths)", (app.match(/clearBattleCardDrafts\(\);/g) || []).length >= 3);
ok("no dangerouslySetInnerHTML (Lesson rich-text safety preserved)", !/dangerouslySetInnerHTML/.test(app));
ok("no categories returned to the Battle Card surfaces", !/bcCategories|INITIAL_BC_CATEGORIES|Uncategorized|categor/i.test(admin) && !/categor/i.test(detail));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
