-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 033: Unified assignment engine — per-user rows + source provenance
-- Run after 032_assignment_notifications.sql
--
-- Problem being fixed:
--   tenant_assignments currently stores team/group assignments as ONE row per
--   target (assigned_to.type = 'team'|'group'), with per-rep status computed
--   at read time by expanding current team membership (see
--   resolveAssignedUsers/buildQuizAssignmentRows in rankd-app.jsx). That made
--   status display easy but makes per-user duplicate prevention and "N
--   assigned / M skipped" summaries impossible, because there's no row to
--   check eligibility against per individual.
--
-- Fix:
--   Every NEW assignment is created at the user level — assigned_to is always
--   { type: 'individual', userId, userName }. We add `source_*` columns to
--   preserve WHERE the assignment came from (an individual pick, a team
--   assignment, an org-wide group assignment, or a future automation) so
--   reporting/auditing/bulk-management stay possible without re-deriving it
--   from assigned_to.
--
-- Backward compatibility:
--   Existing rows with assigned_to.type IN ('team','group') are left as-is
--   structurally — they keep rendering via the existing
--   dynamic-membership-expansion code path in the app; only new writes go
--   through the fan-out engine, and old aggregate rows and new per-user rows
--   coexist indefinitely. This migration DOES backfill source_type/source_id/
--   source_label on those legacy rows (see below) so their provenance
--   metadata is accurate — the rows themselves are not restructured.
--
-- Why no DB-level UNIQUE constraint for "one active assignment":
--   "Active" depends on quiz_attempts / lesson_completions, which live in
--   other tables — Postgres can't express that in a constraint. Duplicate
--   prevention stays an application-layer concern (see 026's note), now
--   implemented in contentService.js's createAssignments().
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.tenant_assignments
  ADD COLUMN IF NOT EXISTS source_type  TEXT NOT NULL DEFAULT 'individual'
    CHECK (source_type IN ('individual', 'team', 'group', 'automation')),
  ADD COLUMN IF NOT EXISTS source_id    UUID,             -- teamId / orgId / automation id (null for individual)
  ADD COLUMN IF NOT EXISTS source_label TEXT;             -- team name / org name / automation label, snapshotted at assign time

COMMENT ON COLUMN public.tenant_assignments.source_type  IS 'How this assignment was created: individual pick, team fan-out, org-wide group fan-out, or automation. Legacy rows predating this column default to individual even if assigned_to.type is team/group.';
COMMENT ON COLUMN public.tenant_assignments.source_id    IS 'teamId/orgId/automation id this assignment fanned out from. Null for direct individual assignments.';
COMMENT ON COLUMN public.tenant_assignments.source_label  IS 'Human-readable source name, snapshotted at assign time (team/org may be renamed or deleted later).';

CREATE INDEX IF NOT EXISTS tenant_assignments_source_idx
  ON public.tenant_assignments (source_type, source_id);

-- Helpful for the new engine's eligibility lookups (per-user active-assignment check).
CREATE INDEX IF NOT EXISTS tenant_assignments_assignee_idx
  ON public.tenant_assignments (tenant_id, content_type, content_id, (assigned_to->>'userId'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Backfill: correct source_type/source_id/source_label for rows that predate
-- this migration and were aggregate team/group assignments.
--
-- Historical assigned_to shapes (the only code path that ever wrote this
-- column before this migration existed — AssignContentModal.handleAssign,
-- rankd-app.jsx):
--   individual: { type: "individual", userId, userName }             — no team/org identifier at all
--   team:       { type: "team",       teamId, teamName }
--   group:      { type: "group",      orgId }                        — never carried a label field
--
-- So there is no "source_id"/"source_label" to ever populate for a legacy
-- individual row — there was never a team/org identifier in that JSON to
-- extract one from. That is a fact about the data, not an assumption:
-- individual rows are excluded from the corrective UPDATE below because
-- there's nothing to correct, not because individual rows are assumed to
-- always want NULL — see the verification queries further down, which check
-- this rather than assume it.
--
-- 2026-07-19 correction: the first version of this backfill required
-- source_type = 'individual' AND source_id IS NULL AND source_label IS NULL
-- ALL to hold before touching a row. That's wrong — it means a legacy
-- team/group row with an incorrect source_type = 'individual' but a
-- source_id or source_label that was already populated (by hand, or by any
-- other process) would be skipped entirely, and its source_type would never
-- get corrected. Each column is now corrected independently:
--   * source_type is resynced from assigned_to->>'type' whenever it
--     differs — regardless of what source_id/source_label currently hold.
--   * source_id is populated from teamId/orgId only when source_id IS
--     CURRENTLY NULL and the JSON holds a valid one — COALESCE(source_id, ...)
--     means an existing non-null value (correct, or manually set) is always
--     preserved untouched, never recomputed or nulled out.
--   * source_label follows the same COALESCE-preserve pattern from teamName.
--
-- Only rows where assigned_to->>'type' IN ('team','group') are eligible at
-- all — new fan-out rows created by createAssignments() always have
-- assigned_to->>'type' = 'individual' (the fanned-out person) even when
-- their source_type is legitimately 'team'/'group'/'automation', so they
-- can never match this WHERE clause and this backfill can never clobber
-- their intentionally-different source_type. This is the one invariant that
-- must never change here, independent of how the rest of the WHERE clause
-- is refined.
--
-- Idempotent / rerun-safe: the WHERE clause is an OR of "this specific
-- column still needs fixing" conditions. After one successful run,
-- source_type always matches assigned_to->>'type' and source_id/source_label
-- are populated wherever the JSON has data for them — every branch of the OR
-- evaluates false on every row, so a rerun matches zero rows and writes
-- nothing.
--
-- teamId/orgId are cast to UUID defensively: a malformed or missing value in
-- old JSONB data does not abort the migration, it just leaves source_id NULL
-- for that row (source_type still gets corrected to 'team'/'group').
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.tenant_assignments
SET
  source_type  = assigned_to->>'type',
  source_id    = COALESCE(
                   source_id,  -- never overwrite an existing value, correct or manually set
                   CASE
                     WHEN assigned_to->>'type' = 'team'
                          AND (assigned_to->>'teamId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (assigned_to->>'teamId')::UUID
                     WHEN assigned_to->>'type' = 'group'
                          AND (assigned_to->>'orgId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                       THEN (assigned_to->>'orgId')::UUID
                     ELSE NULL
                   END
                 ),
  source_label = COALESCE(
                   source_label,  -- never overwrite an existing value, correct or manually set
                   CASE
                     WHEN assigned_to->>'type' = 'team' THEN NULLIF(assigned_to->>'teamName', '')
                     ELSE NULL  -- group's historical JSON never carried a label field to derive from
                   END
                 )
WHERE assigned_to->>'type' IN ('team', 'group')  -- never touches new fan-out rows — see note above
  AND (
        source_type IS DISTINCT FROM (assigned_to->>'type')
     OR (source_id    IS NULL AND assigned_to->>'type' = 'team'  AND (assigned_to->>'teamId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
     OR (source_id    IS NULL AND assigned_to->>'type' = 'group' AND (assigned_to->>'orgId')  ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
     OR (source_label IS NULL AND assigned_to->>'type' = 'team'  AND NULLIF(assigned_to->>'teamName', '') IS NOT NULL)
      );

-- ─────────────────────────────────────────────────────────────────────────────
-- Verification — five independent checks, each isolating one specific way
-- the backfill could be wrong. All five should return zero rows after this
-- migration runs, and stay at zero on every rerun.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Team rows with an incorrect source_type.
-- SELECT id, assigned_to, source_type, source_id, source_label
--   FROM public.tenant_assignments
--   WHERE assigned_to->>'type' = 'team' AND source_type IS DISTINCT FROM 'team';

-- 2. Group rows with an incorrect source_type.
-- SELECT id, assigned_to, source_type, source_id, source_label
--   FROM public.tenant_assignments
--   WHERE assigned_to->>'type' = 'group' AND source_type IS DISTINCT FROM 'group';

-- 3. Individual rows with an incorrect source_type.
--    Important: "assigned_to->>'type' = 'individual' AND source_type IN
--    ('team','group','automation')" is NOT an error — that's exactly what a
--    correct new-engine fan-out row looks like (the fanned-out person is
--    always assigned_to.type = 'individual'; source_type carries where the
--    assignment actually came from). The only combination that's always
--    wrong, regardless of assigned_to.type or when the row was created, is a
--    row claiming source_type = 'individual' (i.e. "no team/org behind this")
--    while still holding a source_id or source_label — that's internally
--    contradictory on its face.
-- SELECT id, assigned_to, source_type, source_id, source_label
--   FROM public.tenant_assignments
--   WHERE source_type = 'individual' AND (source_id IS NOT NULL OR source_label IS NOT NULL);

-- 4. Missing source_id where the JSON contains a valid one.
-- SELECT id, assigned_to, source_type, source_id
--   FROM public.tenant_assignments
--   WHERE source_id IS NULL
--     AND (
--           (assigned_to->>'type' = 'team'  AND (assigned_to->>'teamId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
--        OR (assigned_to->>'type' = 'group' AND (assigned_to->>'orgId')  ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
--         );

-- 5. Missing source_label where the JSON contains a valid one.
-- SELECT id, assigned_to, source_type, source_label
--   FROM public.tenant_assignments
--   WHERE source_label IS NULL
--     AND assigned_to->>'type' = 'team'
--     AND NULLIF(assigned_to->>'teamName', '') IS NOT NULL;

-- Rerun safety check — run the UPDATE above twice in a row against the same
-- data; the second run's "UPDATE n" row count should be 0 (every OR branch
-- in the WHERE clause evaluates false once the first run has corrected it).
