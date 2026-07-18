# Ralli Infrastructure Audit Report
**Date:** 2026-07-16  
**Scope:** Supabase migrations, RLS policies, RPC functions, env vars, tenant isolation

---

## 1. Issues Found and Fixed

### BUG — tenant_settings UPDATE blocked for orgAdmin (FIXED — migration 031)

**Severity:** High (silent data loss)

**Root cause:** `004_tenant_provisioning.sql` created the `tenant_settings_update` policy scoped to `is_ralli_admin()` only. Supabase RLS silently drops UPDATE rows that fail policy checks — no error is returned to the client, so writes appeared to succeed but persisted nothing.

**Affected code paths:**
- `OrgSetupScreen.handleSaveBranding` — writes `branding.primaryColor` during onboarding
- `OrgSetupScreen.handleSaveFeatures` — writes `features` flags during onboarding
- `App.handleSaveRolePermissions` — writes `role_permissions` from Settings panel

**Fix:** `031_tenant_settings_org_admin_update.sql` — adds `"tenant_settings_update_org_admin"` policy allowing orgAdmin to UPDATE their own tenant's row (`tenant_id = get_my_tenant_id() AND get_my_role() = 'orgAdmin'`). RLS policies on the same table are OR-combined, so the existing ralli_admin path is unaffected.

> **Note:** `OrgDetailScreen.handleFeatureToggle` (line ~12238) is called by ralli_admin in the admin panel — already works under the existing policy.

### Previously fixed (migration 028)

`update_tenant` RPC and the `tenants` UPDATE RLS policy previously used `get_my_role() = 'ralli_admin'`, missing the legacy `'superadmin'` alias. Migration `028_fix_tenants_update_rls.sql` switched both to `is_ralli_admin()`, which handles both values. **Verified resolved.**

---

## 2. RPCs and Migrations Verified

### Migrations — all 31 present and sequential

001 through 031 confirmed in `supabase/migrations/`. No gaps.

### RPC audit — all 17 RPCs matched

Every RPC called by the frontend was cross-referenced against its defining migration.

| RPC | Defined in | Frontend caller |
|-----|-----------|-----------------|
| `accept_invitation` | 005, updated 014 | InviteScreen |
| `assign_member_team` | 014 | TeamsScreen |
| `cancel_member_invite` | 009, updated 011 | OrgDetailScreen |
| `complete_onboarding` | 013 | OrgSetupScreen |
| `create_member_invite` | 007, updated 014 (adds p_team_id) | provisioningService |
| `create_member_invite_admin` | 009 | OrgDetailScreen |
| `deactivate_tenant` | 008 | OrganizationsScreen |
| `delete_tenant` | 008 | OrganizationsScreen |
| `get_invitation_by_token` | 005 | InviteScreen |
| `get_my_tenant_invitations` | 011 | OrgDetailScreen (orgAdmin) |
| `get_tenant_invitations` | 009 | OrgDetailScreen (ralli_admin) |
| `reactivate_tenant` | 008 | OrganizationsScreen |
| `remove_member` | 009 | OrgDetailScreen |
| `resend_member_invite` | 009, updated 011 | OrgDetailScreen |
| `update_member` | 009 | OrgDetailScreen |
| `update_tenant` | 009 | OrgDetailScreen / OrganizationsScreen |
| `provision_tenant` | 004 | provisioningService |

All parameters match between callers and definitions. No missing RPCs.

### update_tenant RPC — verified complete

`009_admin_management.sql` defines `update_tenant(p_tenant_id, p_name, p_plan, p_seat_limit, p_status, p_domain, p_admin_email)`. It also:
- Updates `tenant_settings.branding.companyName` when name changes
- Updates `tenant_settings.feature_access` when plan changes (via `get_plan_features()`)

This cascade is internal to the SECURITY DEFINER function and bypasses RLS — no additional policy needed for this path.

---

## 3. RLS and Tenant Isolation Result

**Overall verdict: Tenant isolation is solid. One bug found and fixed.**

| Table | Policy coverage | Result |
|-------|----------------|--------|
| `tenants` | ralli_admin UPDATE (028 — covers superadmin alias); tenant members SELECT own row | ✓ |
| `profiles` | get_my_tenant_id() scopes all reads/writes; SECURITY DEFINER helpers prevent recursion | ✓ |
| `tenant_settings` | SELECT: all authenticated (scoped by tenant_id); UPDATE: was ralli_admin only — **fixed in 031** | Fixed |
| `tenant_courses/lessons/quizzes` | Full RLS: tenant members read, orgAdmin/manager write, all scoped by tenant_id | ✓ |
| `tenant_assignments` | SELECT/INSERT/UPDATE: tenant_id scoped; orgAdmin/manager write | ✓ |
| `lesson_completions` | INSERT: own user_id only; SELECT: users read own, managers read tenant | ✓ |
| `user_point_events` | Immutable ledger; INSERT: own user only; SELECT: tenant members | ✓ |
| `game_sessions` | Scoped by tenant_id; manager/orgAdmin create | ✓ |
| `game_session_participants` | Cross-tenant check enforced in app before INSERT | ✓ |
| `tenant_teams` | orgAdmin/manager write; members read own tenant | ✓ |
| `tenant_invitations` | orgAdmin/ralli_admin read/write; token-based accept is anon-callable SECURITY DEFINER | ✓ |
| `quiz_attempts` / `readiness_scores` / `ai_insights` | tenant_id scoped; UNIQUE constraints prevent duplication | ✓ |
| `tenant_battle_cards` / `tenant_bc_categories` | tenant_id scoped | ✓ |

**RLS recursion:** Fixed in `003_fix_rls.sql` — all policies use `get_my_role()` and `get_my_tenant_id()` SECURITY DEFINER helpers instead of querying `profiles` inline.

**Cross-tenant data leak risk:** None identified. Every table policy uses `tenant_id = get_my_tenant_id()` or goes through a SECURITY DEFINER function that enforces the same check.

---

## 4. Supabase Dashboard — Manual Checks Required

Perform these in the Supabase dashboard for your project:

**a) Apply migration 031**
Go to **SQL Editor** and run the contents of `supabase/migrations/031_tenant_settings_org_admin_update.sql`. Verify the policy `tenant_settings_update_org_admin` appears in **Authentication → Policies → tenant_settings**.

**b) Verify all 31 migrations have been applied**
In **SQL Editor**, run:
```sql
SELECT tablename, policyname FROM pg_policies
WHERE tablename IN ('tenant_settings','tenants','profiles')
ORDER BY tablename, policyname;
```
Expected on `tenant_settings`: `tenant_settings_select`, `tenant_settings_update`, `tenant_settings_update_org_admin`.

**c) Confirm SECURITY DEFINER functions exist**
```sql
SELECT proname, prosecdef FROM pg_proc
WHERE proname IN ('get_my_role','get_my_tenant_id','is_ralli_admin','provision_tenant','update_tenant');
```
All five should return `prosecdef = true`.

**d) Confirm `handle_new_user` trigger is active**
```sql
SELECT trigger_name, event_manipulation, event_object_table
FROM information_schema.triggers
WHERE trigger_name = 'on_auth_user_created';
```
This trigger auto-creates a `profiles` row on signup. If missing, new real users will have no profile and will see blank screens.

**e) Check `tenant_lessons.type` constraint includes all current types**
```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'tenant_lessons'::regclass AND contype = 'c';
```
Should include: `'video','text','interactive','flipcard','recording'`. The `'quiz'` type is separate (lives in `tenant_quizzes`, not `tenant_lessons`).

---

## 5. Vercel Environment Variables — Required Confirmations

Go to **Vercel → Project Settings → Environment Variables** and verify these are set for Production (and Preview if needed):

| Variable | Required | Used by | Notes |
|----------|----------|---------|-------|
| `VITE_SUPABASE_URL` | **Yes** | Frontend Supabase client | Must have `VITE_` prefix to be browser-accessible |
| `VITE_SUPABASE_ANON_KEY` | **Yes** | Frontend Supabase client | Must have `VITE_` prefix |
| `RESEND_API_KEY` | **Yes** | `api/send-invite.js` | Returns 500 JSON error if missing; app shows copy-link fallback |
| `OPENAI_API_KEY` | No | `api/ai-insights.js` | Graceful degradation if missing: recommendations still work, AI summary returns `null` |
| `RESEND_FROM` | No | `api/send-invite.js` | Defaults to `"Ralli <onboarding@resend.dev>"`. On Resend free plan this address only delivers to your Resend account owner email. Set a custom verified domain to deliver to all users. |

> `.env.local` (local dev) currently has `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `RESEND_API_KEY` but **not** `OPENAI_API_KEY`. Add it locally to test AI insights.

---

## 6. Remaining Beta Blockers

### P0 — Must fix before users go live

| # | Issue | Action |
|---|-------|--------|
| 1 | `tenant_settings` orgAdmin UPDATE blocked | **Done — run migration 031 in Supabase** |
| 2 | `RESEND_FROM` using free-plan `onboarding@resend.dev` | Set up a verified sending domain in Resend and set `RESEND_FROM` in Vercel |
| 3 | `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in Vercel | Confirm set — frontend won't connect to Supabase otherwise |

### P1 — Should fix soon

| # | Issue | Action |
|---|-------|--------|
| 4 | `OPENAI_API_KEY` not set | Add to Vercel and `.env.local` for AI summary in InsightsScreen |
| 5 | `handle_new_user` trigger | Confirm active in Supabase dashboard (item 4d above) |

### P2 — Known limitations, acceptable for beta

| # | Issue | Notes |
|---|-------|-------|
| 6 | `role_permissions` loads from localStorage on app init | Production hook placeholder is noted in code; Supabase read-on-mount not yet wired |
| 7 | Game session PIN uniqueness not enforced at DB level | App generates 4-digit PIN; collision chance low at beta scale |
| 8 | `onboarding@resend.dev` restriction | Only blockers if inviting non-Resend-owner emails while on free plan |

---

## 7. Scope Boundary

This audit covered and is now complete for:
- All 31 Supabase migrations (schema, RLS, RPCs)
- All 17 RPCs called by the frontend
- Tenant isolation via RLS
- `update_tenant` RPC correctness
- Invite email env var handling (`RESEND_API_KEY`, `RESEND_FROM`)
- AI Insights env var handling (`OPENAI_API_KEY`)
- Real user fallback to demo data (confirmed: guarded by `user?._isReal` checks throughout)

**Files modified by this audit:**
- `supabase/migrations/031_tenant_settings_org_admin_update.sql` — new (fixes orgAdmin tenant_settings UPDATE)
- `INFRA_AUDIT.md` — new (this report)
