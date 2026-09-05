# Migration 091 — Learner Lifecycle — Manual QA Checklist

Run on the READY preview **after** 091 is applied to the preview's database. Two clearly separated lanes:
Manager/Admin (member administration) and Learner (self-service + readiness visibility). Each item lists the
expected result. Nothing here should be run against production until 091 is applied and signed off.

Preconditions: preview built & READY; 091 applied to the preview DB; at least one org (tenant) with one
orgAdmin/manager, two active learners, and a second org for transfer tests.

---

## Lane A — Manager / Admin (member administration)

- [ ] **Deactivate a learner** (member admin → remove/deactivate). Expect: the learner disappears from the
      readiness dashboard immediately; their history is retained (not shown to a manager of a different org).
- [ ] **Reactivate the same learner.** Expect: the learner reappears; their readiness recomputes within a
      couple of minutes (async via the recovery sweep); no duplicate history rows.
- [ ] **Change a learner → manager/orgAdmin.** Expect: the learner drops off the readiness/leaderboard
      population immediately (managers are non-scorable).
- [ ] **Change a manager → learner.** Expect: they appear as a scorable learner; readiness materialises
      within a couple of minutes.
- [ ] **Transfer a learner from org A to org B** (via invite acceptance into B, or the transfer path).
      Expect: succeeds even if the learner already has readiness history; org-A readiness disappears; org-B
      readiness is computed fresh from org-B activity only; **org-A managers still see the learner's org-A
      history; org-B managers never see any org-A data.**
- [ ] **Remove then re-invite a learner.** Expect: removal is reversible; on re-invite the learner is active
      again and readiness recomputes; prior history stays under its original org.
- [ ] **No-op edit** (e.g., change only the display name). Expect: succeeds; readiness/current score
      unchanged; no recompute churn.
- [ ] **Team assignment/unassignment only** (no role/status/tenant change). Expect: succeeds; tenant-level
      readiness is NOT erased by a team change.
- [ ] **Authorization:** a plain learner cannot deactivate/transfer/role-change another member (the action
      is rejected). An orgAdmin can only administer members of their own org.
- [ ] **Cross-org isolation:** as an org-B manager, you cannot see any org-A learner's readiness or history.
- [ ] **Permanent organization deletion (history contract):** deleting an entire org (`delete_tenant`)
      permanently removes that org's readiness history **by design** — history is preserved across learner
      removal/transfer but is intentionally cascaded away when the whole tenant is deleted. Verify only the
      deleted org's readiness data is gone and other orgs are untouched. (History survives a learner leaving,
      NOT the organization being deleted.)

## Lane B — Learner (self-service + visibility)

- [ ] **Sign up / first login with no profile yet.** Expect: a profile is created (via `ensure_self_profile`)
      with role=user, status=active, no org; the app loads normally.
- [ ] **Edit safe profile fields** (name, nickname, avatar emoji, profile picture, notification prefs).
      Expect: all save successfully.
- [ ] **Attempt self-escalation (negative test).** Using the browser devtools/API, a learner attempts to
      `update` their own `role`, `status`, `tenant_id`, or `team_id` directly. Expect: **rejected** (no column
      privilege / guard). Safe-field edits above still work.
- [ ] **Take quizzes and accrue readiness as an active learner.** Expect: readiness updates as before.
- [ ] **After being deactivated by an admin.** Expect: the learner no longer appears in any readiness view;
      re-activation restores them.
- [ ] **After being transferred to a new org.** Expect: the learner sees only the new org's content and
      readiness; cannot read the old org's data.

## Regression spot-checks (both lanes)

- [ ] Invitation acceptance for a brand-new user still works (creates the profile in the invited org).
- [ ] Existing dashboards/leaderboards render; active-learner counts match expectations.
- [ ] No console/network errors on the member-admin and profile-edit screens.

---

**History-retention contract (091):** a learner removed / deactivated / transferred keeps their readiness
history under its ORIGINAL tenant (the user FK is identity `ON DELETE RESTRICT`, so a learner leaving never
erases it, and an individual account cannot be hard-deleted out from under its history). Permanently deleting
the ENTIRE organization (`delete_tenant`) DOES remove that org's tenant-scoped history — the history
`tenant_id → tenants` and `(formula_version_id,tenant_id) → readiness_formula_versions` FKs are pre-existing
`ON DELETE CASCADE` and are intentionally left unchanged. **History does not survive tenant deletion; only
learner-lifecycle changes.**

**Out of scope for 091 (do NOT test as fixed here):** the `user_point_events` self-award vulnerability
(tracked in KNOWN_BUGS as the immediate next security task); the GDPR/anonymisation workflow required before
permanent ACCOUNT deletion (the individual-profile RESTRICT gate); broader content-access for
suspended/invited/unknown-status profiles (separate high-priority audit).
