// Frontend guardrail tests for the company history contract in MemberLifecyclePanel (rankd-app.jsx).
//
// Contract: history belongs to the organization where it was earned. Cross-org actions (Ralli-admin
// Transfer, and Ralli-admin reactivation of a detached user into a selected org) must WARN that history
// will not move and require explicit confirmation. Same-org reinvite (tenant orgAdmin → Deactivated Users)
// keeps history and shows a restoration note. No RLS widening, no cross-tenant copy, no new data call.
//
// rankd-app.jsx can't be imported headless (Vite/import.meta.env + a huge component tree), so these assert
// on the component source: the exact copy, the confirmation gating, and the absence of any data call or
// tenant-broadening in the guardrail additions.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const src = readFileSync(fileURLToPath(new URL("../../rankd-app.jsx", import.meta.url)), "utf8");

function panelBody() {
  const start = src.indexOf("function MemberLifecyclePanel(");
  assert.ok(start !== -1, "MemberLifecyclePanel exists");
  const next = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}
const panel = panelBody();
// Whitespace-normalized view (JSX wraps source lines; the rendered text collapses runs of whitespace).
const norm = panel.replace(/\s+/g, " ");

function slice(from, to, hay = panel) {
  const a = hay.indexOf(from);
  assert.ok(a !== -1, `anchor not found: ${from}`);
  const b = hay.indexOf(to, a + from.length);
  assert.ok(b !== -1, `end anchor not found after ${from}: ${to}`);
  return hay.slice(a, b + to.length);
}

const WARN_TITLE = "This learner’s history will not move with them.";
const WARN_BODY  = "Quiz attempts, learning progress, Ralli Live results, XP, and readiness history remain with the organization where they were earned. The learner will start fresh in the new organization.";
const SAME_ORG_NOTE = "Reinviting this learner to the same organization restores access to their preserved history.";

// ── 1. Warning copy exists exactly (as rendered) ───────────────────────────────
test("cross-org history warning uses the exact required copy", () => {
  assert.ok(norm.includes(WARN_TITLE), "warning title present verbatim");
  assert.ok(norm.includes(WARN_BODY), "warning body present verbatim");
});

// ── 2. Warning is shown for BOTH Transfer and global Reactivation ──────────────
test("warning is rendered in both the Transfer and Reactivate dialogs", () => {
  const refs = panel.match(/\{historyWarning\}/g) || [];
  assert.ok(refs.length >= 2, `expected historyWarning rendered >=2 times, got ${refs.length}`);
  const transferDialog = slice('confirm?.kind === "transfer"', "Transfer</button>");
  assert.ok(transferDialog.includes("{historyWarning}"), "transfer dialog shows the warning");
  const reactivateDialog = slice("Reactivate user", "Reactivate</button>");
  assert.ok(reactivateDialog.includes("{historyWarning}"), "reactivate dialog shows the warning");
});

// ── 3. Explicit confirmation is required (ack gate) after dest+role selected ────
test("Transfer requires explicit acknowledgement before enabling", () => {
  const d = slice('confirm?.kind === "transfer"', "Transfer</button>");
  assert.match(d, /checked=\{!!confirm\.ack\}/, "transfer has an ack checkbox bound to confirm.ack");
  assert.match(d, /disabled=\{!confirm\.destId \|\| !confirm\.ack \|\| !!busy\}/,
    "transfer button disabled until destId AND ack");
  assert.match(d, /disabled=\{!confirm\.destId\}/, "ack checkbox gated on destination selection");
});
test("global Reactivate requires explicit acknowledgement before enabling", () => {
  const d = slice("Reactivate user", "Reactivate</button>");
  assert.match(d, /checked=\{!!reactivate\.ack\}/, "reactivate has an ack checkbox bound to reactivate.ack");
  assert.match(d, /disabled=\{!reactivate\.destId \|\| !reactivate\.ack \|\| !!busy\}/,
    "reactivate button disabled until destId AND ack");
  assert.match(d, /disabled=\{!reactivate\.destId\}/, "ack checkbox gated on destination selection");
});

// ── 4. Same-tenant reinvite shows the restoration helper text (unchanged flow) ─
test("Deactivated Users (same-org reinvite) shows the restoration helper text", () => {
  assert.ok(norm.includes(SAME_ORG_NOTE), "same-org restoration note present verbatim");
  assert.match(panel, /onClick=\{\(\) => doReinvite\(d\)\}/, "reinvite still calls doReinvite");
});

// ── 5. No new data call, no tenant broadening, no history copy in the guardrail ─
test("guardrail additions introduce no data call, RLS widening, or history copy", () => {
  const warn = slice("const historyWarning = (", "  );");
  for (const forbidden of ["supabase", ".rpc(", ".from(", ".select(", "fetch(", "tenant_id"]) {
    assert.ok(!warn.includes(forbidden), `warning block must not contain ${forbidden}`);
  }
  assert.ok(!/\{[^}]*org[^}]*\}/i.test(warn), "warning must not interpolate an org name");
  assert.ok(!/deleted/i.test(warn), "warning must not claim history was deleted");
  assert.ok(!/history (was|is) (transferred|moved|copied)/i.test(warn), "warning must not claim history moved/copied");
  const tAck = slice("checked={!!confirm.ack}", "</label>");
  const rAck = slice("checked={!!reactivate.ack}", "</label>");
  for (const seg of [tAck, rAck]) {
    for (const forbidden of ["supabase", ".rpc(", ".from(", ".select(", "fetch("]) {
      assert.ok(!seg.includes(forbidden), `ack label must not contain ${forbidden}`);
    }
  }
  assert.match(panel, /doTransfer\(confirm\.member, confirm\.destId, confirm\.role\)/, "transfer still calls doTransfer");
  assert.match(panel, /onClick=\{doReactivate\}/, "reactivate still calls doReactivate");
});
