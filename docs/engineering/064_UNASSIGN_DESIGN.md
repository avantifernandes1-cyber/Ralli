# Migration 064 — Manager Unassign (AS BUILT — awaiting production apply)

Status: **WRITTEN + LOCALLY VALIDATED, NOT APPLIED TO PRODUCTION.** Approved in
concept with corrections; this doc is updated to match the shipped
`supabase/migrations/064_manager_unassign.sql` and its test harness. 063 stays
exactly as applied. Do not apply 064 to production without explicit approval.

## As-built summary (supersedes the pre-approval draft below)

- **Authorization** uses the CANONICAL assignment-management rule (017/026/034
  and 063 archive_*): `is_ralli_admin() OR get_my_role() IN ('orgAdmin','manager')`.
  `manager` is included (required). No invented `superadmin` literal — ralli_admin
  AND superadmin are both handled by `is_ralli_admin()`.
- **No free-form reason.** Signature is `unassign_assignment(p_assignment_id uuid)`;
  the server sets `cancelled_reason='manager_unassigned'`, `cancelled_at=now()`,
  `cancelled_by=auth.uid()`. Archive-driven cancellation keeps its own server
  reason (`content_archived`) and leaves `cancelled_by` NULL (a content action,
  not an individual — no false attribution).
- **Hard-delete closed.** 064 drops the 017 `tenant_assignments_delete` RLS policy
  and REVOKEs DELETE from authenticated/anon. Tenant offboarding still cascades
  via the tenants FK; service_role retains privileged maintenance (bypasses RLS).
- **cancelled_by uuid NULL REFERENCES profiles(id) ON DELETE SET NULL** — the same
  retention model 017 uses for `assigned_by`: deleting a profile clears attribution
  but never destroys the history row.
- **Completion check (instance-aware, per THIS row's assigned_at):** lesson —
  no `lesson_completions` at/after assigned_at ⇒ active (unassignable); course —
  fewer than all member lessons completed at/after assigned_at ⇒ active; quiz —
  a PASSING attempt at/after assigned_at ⇒ completed (a failed attempt is
  in_progress and remains unassignable). Completed ⇒ refused.
- **Concurrency:** `SELECT … FOR UPDATE` locks the one row; a second concurrent
  unassign serializes and returns the idempotent `already_cancelled` (original
  ender preserved). Team/group and not-found are refused with honest errors.
- **Local validation:** `supabase/tests/064_manager_unassign.test.sql` — 13 groups
  PASS (manager authority incl. role 'manager', learner refused, cross-tenant
  refused, completed lesson/course/quiz refused, predate + failed-quiz allowed,
  idempotent, other learner untouched, team refused, not-found, hard-delete
  blocked, DELETE policy gone, FK SET NULL). 063 harness still PASSES (no regression).

---

## Pre-approval draft (kept for provenance — see as-built above for what shipped)

Status: **NOT WRITTEN, NOT APPLIED.** This was the design returned before creating 064.

---

## 1. Why a migration is required (and why the current "Remove" is wrong)

Today the manager Assignments tab has a **"Remove"** button. It calls
`deleteAssignment(assignmentId)` in `contentService.js`, which runs a raw
`DELETE FROM tenant_assignments WHERE id = …`.

That is the exact opposite of the requested Unassign behavior:

| Requirement | Current "Remove" (`deleteAssignment`) |
|---|---|
| Never delete; preserve history | **Hard-deletes the row** — history is gone |
| Record who unassigned / when / reason | Impossible — the row no longer exists |
| Keep visible in manager history as "Unassigned" | Row vanishes from every view |
| Manager-authorized, tenant-scoped, per-user | Relies on table RLS only; no explicit role/tenant check in the delete |

So Unassign is **not** "wire a button to the existing path." It must become a
**cancellation** (set `cancelled_at` + `cancelled_reason` + `cancelled_by`),
reusing the 063 cancellation model that the three eligibility helpers already
honor — and the hard-delete `deleteAssignment` path must be retired for manager
unassign.

063's `cancelled_at` / `cancelled_reason` are **necessary but not sufficient**:
they capture *that* and *why (coarse)* a row ended, but not **who** ended it.
For a trustworthy audit trail of a deliberate manager action, we need the actor.

---

## 2. Exact schema change (additive only)

```sql
ALTER TABLE public.tenant_assignments
  ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES public.profiles(id);
```

- Nullable, no default, no backfill. Every existing cancelled row (the 063
  backfill + archive-driven cancellations) keeps `cancelled_by = NULL`, which
  reads honestly as "ended by the system / content archival," not by a person.
- No change to `cancelled_at` / `cancelled_reason` (063 columns untouched).
- No index needed (history views already scan the small per-tenant set).

**`cancelled_by` required? → YES.** Without it the history cannot answer "who
unassigned this rep," which is a stated requirement ("record who unassigned").
`cancelled_reason = 'manager_unassigned'` tells you it was a manager action;
`cancelled_by` tells you *which* manager. Both are needed for the audit trail.

---

## 3. RPC signature

```sql
CREATE OR REPLACE FUNCTION public.unassign_assignment(
  p_assignment_id uuid,
  p_reason        text DEFAULT 'manager_unassigned'
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$ … $$;
```

- One assignment id → cancels exactly that one `tenant_assignments` row. Never
  fans out to other rows, so another learner's assignment for the same content
  is untouched (per-user rows are the current default shape).
- `p_reason` defaults to the stable `'manager_unassigned'`; callers should not
  pass anything else for the manager-unassign path (kept as a param only so the
  same function could serve future reason-coded cancellations if ever needed).
- Mirrors the 063 RPC conventions (`SECURITY DEFINER`, pinned `search_path`,
  `GRANT EXECUTE … TO authenticated`).

---

## 4. Authorization & tenant checks (inside the function body)

```
v_actor   := auth.uid();
v_role    := get_my_role();          -- same helpers 063 uses
v_tenant  := get_my_tenant_id();

-- 1. Must be a manager (or ralli admin), never a learner.
if v_role not in ('orgAdmin','ralli_admin','superadmin') then
  raise exception 'not authorized to unassign';
end if;

-- 2. Row must exist AND belong to the caller's tenant (defense in depth on top
--    of RLS). ralli_admin/superadmin may act cross-tenant via is_ralli_admin().
select * into v_row from tenant_assignments where id = p_assignment_id;
if not found then raise exception 'assignment not found'; end if;
if not is_ralli_admin() and v_row.tenant_id <> v_tenant then
  raise exception 'assignment not in your tenant';
end if;

-- 3. State gate (see §5): only an ACTIVE/in-progress/overdue row may be
--    unassigned. Already-cancelled → idempotent no-op (do not overwrite the
--    original cancelled_by/at). Completed → refuse.
```

Because the function is `SECURITY DEFINER`, the explicit role + tenant checks
are what enforce authorization (they do not rely on the caller's RLS). This is
the same posture as `archive_lesson` / `archive_course` in 063.

---

## 5. State-transition rules

Let the current instance status come from the **same** resolution the helpers
use (completion/attempt dated `>= assigned_at`):

| Current state | Unassign allowed? | Result |
|---|---|---|
| not_started (active) | ✅ | set cancelled_at=now, cancelled_reason=p_reason, cancelled_by=actor |
| in_progress | ✅ | same |
| overdue (past due, unresolved) | ✅ | same |
| **completed** (resolved for current instance) | ❌ | `raise exception 'cannot unassign a completed assignment'` |
| already cancelled | ➖ | idempotent no-op — **do not** overwrite existing cancelled_* (preserve the first, true ender) |

"Completed cannot be unassigned" is enforced **server-side** by checking whether
a qualifying completion/attempt exists for this row's `content_type` /
`content_id` / assignee with event time `>= assigned_at` — the SQL analogue of
`resolveAssignmentStatus(...).isResolved`. The client also hides Unassign on
completed rows, but the RPC is the authority.

Reassignment is unaffected: `create_assignments_atomic` inserts a **new** row
with a fresh `assigned_at`; it never clears `cancelled_*` on the old row, so a
cancelled row stays cancelled in history and the new instance is independent.

---

## 6. Impact on the three eligibility helpers → **NONE**

`_quiz_assignment_active_user_ids`, `_lesson_assignment_active_user_ids`,
`_course_assignment_active_user_ids` (063) already filter `AND ta.cancelled_at
IS NULL`. Setting `cancelled_at` via the RPC therefore removes the row from
active/overdue/pending **through the existing filter** — no helper change, no
re-definition, no new status path. `cancelled_by` is audit metadata only; no
helper reads it. This is the key reason the change is additive and low-risk.

Learner-facing effect is automatic: Home / To-Do / Learn and the manager active
table all derive from those helpers (or the JS engine that mirrors them), so a
cancelled row disappears from counts and cards immediately, while the Ended
Assignments history (which intentionally loads `includeCancelled: true`) keeps
showing it as "Unassigned."

---

## 7. Rollback

Fully reversible, no data loss of live rows:

```sql
DROP FUNCTION IF EXISTS public.unassign_assignment(uuid, text);
-- Optional (only if the column must also go — it is harmless to keep):
ALTER TABLE public.tenant_assignments DROP COLUMN IF EXISTS cancelled_by;
```

Dropping the column would lose only the "who unassigned" audit metadata written
after 064; it does not affect `cancelled_at`/`cancelled_reason` or any active
assignment. Preferred rollback is to drop the function only and leave the
nullable column in place.

---

## 8. Client wiring (ships WITH 064, after approval)

- New `contentService.unassignAssignment(assignmentId)` → `supabase.rpc(
  "unassign_assignment", { p_assignment_id })`. **Replaces** `deleteAssignment`
  for the manager action (the hard-delete path is retired for unassign).
- The Assignments-tab "Remove" control becomes **"Unassign"**, offered only on
  active/in-progress/overdue individual rows (never completed, never legacy
  team/group aggregate rows). On success the row moves from the active table
  into the Ended Assignments history (already built this turn) as "Unassigned,"
  with the manager's name + date once `cancelled_by` is populated.
- Confirmation copy makes the archive-vs-unassign distinction explicit (§9).

---

## 9. Archive vs Unassign — user-facing distinction

| | **Archive content** | **Unassign** |
|---|---|---|
| Scope | The lesson/course itself | One learner's single assignment |
| Effect | Removes content from active use **and** cancels **all** its active assignments | Cancels **only** the selected learner's active row |
| Others | Everyone assigned loses it | Everyone else keeps their assignment |
| Restore | Restoring content does **not** revive cancelled assignments | N/A — reassign to restore, which creates a **new** instance |
| Control | "Archive" on the content card | "Unassign" on the per-rep assignment row |

Confirmation strings (planned):
- Archive: *"Archiving '{title}' removes it from active use and cancels it for
  everyone currently assigned. Restoring it later will not reassign anyone."*
- Unassign: *"Unassign '{title}' from {rep}? Their progress is kept for history.
  This removes only {rep}'s assignment — no one else is affected."*
