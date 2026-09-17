# Learner History Contract (company-specific) — lifecycle design + QA

## Contract

**History belongs to the organization where it was earned.** It is tenant-scoped by the immutable
`tenant_id` stored on every history row, and every history read is scoped to the caller's *current* tenant.
There is no cross-tenant history and none is ever copied between tenants.

Consequences for the learner lifecycle:

- **Reinvite into the *same* organization** (tenant orgAdmin → Deactivated Users → Reinvite): the learner
  returns to the org they were removed from, so that org's `tenant_id` again matches their current tenant and
  **visibility of that organization's history is restored**. Nothing is recomputed or copied — the rows were
  never touched; they simply become visible again.
- **Transfer to a different organization** (Ralli-admin only) or **reactivating a detached user into a
  *different* organization** (Ralli-admin, from the global detached list): prior quiz attempts, learning
  progress, Ralli Live results, XP, and readiness history **do not move**. They remain with the organization
  where they were earned. **The learner starts fresh in the destination organization.**

This is not data loss. The historical rows continue to exist under the original tenant and remain visible to
that organization's managers and to Ralli admins. Moving a learner across orgs only changes which org's
history their *current* views resolve to.

### Hard constraints (do not violate)

- **Never widen RLS** to surface another tenant's history to the destination org.
- **Never copy historical records between tenants** to make them "follow" the learner.
- **Never claim history was deleted or transferred** in any UI copy.
- **Never expose which other organization holds a learner's history** to a non-authorized viewer. Only an
  existing Ralli-admin-only source may reveal that.

## Why (root cause this guardrail addresses)

"Remove from org" detaches a learner globally (`profiles.tenant_id → NULL`). Once detached, a Ralli-admin
reactivation or an invitation can attach them to *any* organization. If that destination differs from where
their history lives, all history silently disappears from the learner's and the new org manager's views —
because every history table (`quiz_attempts`, `user_point_events`, `readiness_score_history`,
`readiness_scores_current`, `lesson_completions`, game/roster tables) is scoped by the row's original
`tenant_id` vs. the caller's current tenant. The rows are intact; they are simply out of the new org's scope.
The fix is a **product contract + UI guardrail**, not a data or RLS change.

## UI guardrail (implemented in `MemberLifecyclePanel`, `rankd-app.jsx`)

Cross-org actions show a warning and require explicit acknowledgement; the same-org path shows a restoration
note and is unchanged.

1. **Ralli-admin Transfer Organization** confirmation displays:
   > **This learner's history will not move with them.**
   > Quiz attempts, learning progress, Ralli Live results, XP, and readiness history remain with the
   > organization where they were earned. The learner will start fresh in the new organization.
2. **Ralli-admin Reactivate** (detached user → selected org) shows the **same** warning.
3. Both require an **explicit acknowledgement checkbox** that is only enabled once a destination organization
   (and role) is selected; the action button stays disabled until the destination is chosen *and* the box is
   checked.
4. **Tenant-orgAdmin Deactivated Users → Reinvite** is unchanged (it returns the learner to the same tenant)
   and shows the concise note:
   > Reinviting this learner to the same organization restores access to their preserved history.
5. Copy never claims deletion/transfer and never names the org holding the history.

## QA checklist

Manager/admin, on the readiness preview (093 backend live):

1. **Same-org reinvite restores history.** As a tenant orgAdmin, remove a learner who has history, then
   Reinvite them from that org's Deactivated Users list; after they accept, their prior quiz/XP/readiness
   history is visible again. The restoration note is shown. *(No warning/checkbox here.)*
2. **Transfer shows the warning + requires confirmation.** As a Ralli admin, open Transfer for a learner: the
   history warning is visible; the Transfer button is disabled until a destination org is chosen **and** the
   acknowledgement box is checked.
3. **Global reactivate shows the warning + requires confirmation.** As a Ralli admin, reactivate a detached
   user into a selected org: same warning and acknowledgement gating.
4. **History does not move cross-org.** After a transfer/cross-org reactivation, the learner's new org shows
   no prior quiz/learning/Ralli Live/XP/readiness history; the original org still shows it intact.
5. **No leakage.** The destination org never sees the origin org's history; copy never says "deleted" or
   "transferred" and never names the other org.

Automated coverage: `src/lib/historyGuardrailUi.test.js` (exact copy, both dialogs warn, acknowledgement
gating, same-org note, and no data call / RLS-widening / history-copy introduced by the guardrail).
