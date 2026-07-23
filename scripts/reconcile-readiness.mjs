#!/usr/bin/env node
/**
 * One-time readiness reconciliation — EXPLICIT operational tool (server-only).
 *
 * WHY: after the readiness formula changed (all-attempts → latest-attempt per
 * quiz), existing `readiness_scores` rows still hold OLD-formula values and are
 * NOT refreshed until each rep next triggers a recompute. The Leadership
 * Dashboard deliberately does not recompute on view. This recomputes the ACTIVE
 * SALES REPS of ONE tenant using the SAME pure formula
 * (src/lib/readinessFormula.js — no duplication). Org managers / platform admins
 * are EXCLUDED. Existing rows for excluded roles are reported, never deleted.
 *
 * SECURITY: uses a SERVER-ONLY service-role client (server/supabaseAdmin.mjs),
 * read from process.env — NEVER import.meta.env, NEVER a VITE_ variable:
 *   - SUPABASE_URL
 *   - SUPABASE_SERVICE_ROLE_KEY
 *
 * ─── HOW TO RUN ──────────────────────────────────────────────────────────────
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
 *     node scripts/reconcile-readiness.mjs <tenantId>            # DRY RUN (no writes)
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... RECONCILE_CONFIRM=1 \
 *     node scripts/reconcile-readiness.mjs <tenantId> --apply    # WRITES
 *
 * The dry run genuinely reads + computes and prints per-rep before/after with a
 * summary; it writes NOTHING. --apply requires BOTH an explicit tenantId AND
 * RECONCILE_CONFIRM=1. DO NOT run --apply against production without approval.
 * Never paste the service-role key into a VITE_ variable or into app code.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { reconcileReadiness } from "../server/reconcileReadiness.mjs";

const tenantId = process.argv[2];
const apply = process.argv.includes("--apply");

if (!tenantId) {
  console.error("Usage: node scripts/reconcile-readiness.mjs <tenantId> [--apply]");
  process.exit(2);
}
if (apply && process.env.RECONCILE_CONFIRM !== "1") {
  console.error("Refusing to --apply without RECONCILE_CONFIRM=1 in the environment. Run the dry run first.");
  process.exit(2);
}

const report = await reconcileReadiness(tenantId, { apply });
if (report.error) {
  console.error("Reconciliation failed to start:", report.error.message ?? report.error);
  process.exit(1);
}
console.log(`Tenant ${tenantId} — ${apply ? "APPLY" : "DRY RUN"}`);
for (const r of report.results) {
  const b = r.before ? String(r.before.score) : "—";
  const a = r.after ? String(r.after.score) : "—";
  console.log(`  ${r.userId}: before=${b} after=${a}${r.applied ? " [written]" : ""}${r.error ? `  ERROR: ${r.error}` : ""}`);
}
if (report.accidentalExcludedRows?.length) {
  console.log("Existing readiness rows for EXCLUDED roles (reported, not deleted):", report.accidentalExcludedRows.length);
}
console.log("Summary:", report.summary);
process.exit(report.summary.failures > 0 ? 1 : 0);
