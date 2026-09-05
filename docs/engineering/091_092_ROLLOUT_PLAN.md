# Zero-Downtime Rollout — 091 (learner lifecycle) + 092 (profile-write lockdown)

A DB migration and a Vercel deploy cannot be atomic, so the profile-write hardening is split so that **every
intermediate state is compatible with whichever frontend is live**.

- Applying the full lockdown before the frontend switches would break the deployed `createMissingProfile`
  (it upserts `role`/`status` directly).
- Deploying the new frontend first would call `ensure_self_profile` before that RPC exists.

The split removes both hazards.

## Stage 1 — apply migration 091 (additive / backward-compatible)
Adds all lifecycle machinery and `ensure_self_profile`, applies the FK/eligibility/lifecycle changes, and
routes `accept_invitation`/`delete_tenant` through the advisory-first engine — **but leaves the legacy broad
`profiles` write grants intact and does NOT add the guard trigger**. The currently-deployed frontend keeps
working unchanged (its direct `role`/`status` upsert still succeeds; primary signup via `handle_new_user` is
unaffected). No new deadlock surface: the deployed frontend never directly changes `tenant_id` (the only
FK-key column), and all tenant-changing paths (`accept_invitation`, `delete_tenant`) route through the
advisory-first engine.
- Verify (read-only) after apply: composite→identity FKs on history/queue applied; `ensure_self_profile`
  present; guard trigger absent; broad grants still present; 3 existing crons + the new reconcile cron.
- Rollback: `docs/engineering/rollback_091_readiness_learner_lifecycle.sql` (two-mode, fails closed after
  lifecycle divergence).

## Stage 2 — deploy the `ffc0e2b` frontend, then verify
Deploy the frontend that uses `ensure_self_profile` (creation) and the lifecycle RPCs (member admin). Verify
in production:
- [ ] Signup (new user) creates a profile and loads.
- [ ] Existing-account login loads the profile.
- [ ] Invitation acceptance places the user in the invited org.
- [ ] Missing-profile recovery uses `ensure_self_profile` (force the fallback / check network calls).
- [ ] Profile edits (name, nickname, avatar, notification prefs) save.
- [ ] Member admin (role change / removal / reactivation) goes through the lifecycle RPCs.

## Stage 3 — apply migration 092 (close the bypass) — ONLY after Stage 2 verified
Adds the fail-closed guard trigger, revokes the broad `profiles` grants (re-granting only SELECT + the safe
presentation columns), removes direct client INSERT, and adds the own-row WITH CHECK.
- **Precondition (proven before applying):**
  - **Static caller scan** (this repo, `ffc0e2b`): no client `.from('profiles').insert|upsert`, and no
    `.update` of `role`/`status`/`tenant_id`/`team_id`. Verified — the only client profiles writes are
    `{name}` (handleUpdateMember) and `updateUserProfile` (`nickname`/`avatar_emoji`/`profile_pic_url`/
    `notif_prefs`), all in the safe-grant set; creation is `ensure_self_profile`; member admin is the
    lifecycle RPCs. `awardXp`→`upsertProfile({xp})` is dead (0 callers).
  - **Live QA** (Stage 2 checklist all green).
- Rollback: `docs/engineering/rollback_092_profile_write_lockdown.sql` (drops the guard, restores broad
  grants + the pre-092 own-row policy). Reverting 092 re-opens the direct self-escalation surface — use only
  to unblock a frontend regression, then re-apply once fixed.

## Independence & safety notes
- Applying 091 without 092 does not make security worse than today (the profiles-write hole is exactly the
  pre-existing one); it only defers *closing* it.
- The lifecycle RPCs stamp the per-user marker in Stage 1 already; it is a harmless no-op until 092's guard
  reads it, so no function needs re-editing when 092 lands.
- XP integrity (`user_point_events` self-award) remains the separate high-priority follow-up (KNOWN_BUGS);
  not touched by 091 or 092.
