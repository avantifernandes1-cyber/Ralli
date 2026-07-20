-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 034: Atomic assignment creation — closes the concurrent-duplicate
-- race in createAssignments() (contentService.js).
-- Run after 033_unified_assignment_engine.sql.
--
-- Problem being fixed:
--   createAssignments() previously computed "who already has an active
--   assignment" in JS, then issued a separate INSERT for eligible users.
--   Two concurrent calls for the same tenant+content (two managers, a
--   double-click, a retried request) could both read "no active assignment"
--   before either INSERT committed, and both insert — a duplicate active
--   assignment for the same user+content. A plain UNIQUE constraint can't
--   fix this because "active" depends on quiz_attempts/lesson_completions,
--   which live in other tables and Postgres can't reference from a
--   constraint on tenant_assignments (see 026's note, reaffirmed in 033).
--
-- Fix:
--   create_assignments_atomic() does the eligibility check AND the inserts
--   in one transaction, serialized per (tenant_id, content_type, content_id)
--   via pg_advisory_xact_lock. A second concurrent call for the same content
--   blocks until the first transaction commits, then correctly sees the
--   first call's new rows as active and skips accordingly. The lock is
--   transaction-scoped — released automatically on commit or rollback, no
--   manual unlock needed, no risk of a held lock outliving a crashed request.
--
-- Security model — SECURITY DEFINER (revised; was SECURITY INVOKER):
--   A SECURITY INVOKER version of this function was audited and rejected.
--   Reason: this function needs COMPLETE visibility into profiles,
--   quiz_attempts, lesson_completions, and tenant_courses for the tenant it's
--   acting on, for every caller the app permits to create assignments
--   (ralli_admin, orgAdmin, manager). Checking each table's existing RLS
--   policy against that requirement found it does NOT hold for every
--   permitted caller:
--
--     * quiz_attempts_tenant_read (022_ai_insights.sql) is
--         USING (tenant_id IN (SELECT tenant_id FROM profiles WHERE id = auth.uid()))
--       with NO ralli_admin bypass. ralli_admin's own profiles.tenant_id is
--       NULL (they belong to no tenant), so this policy resolves to
--       "tenant_id IN (NULL)" for a ralli_admin caller — which matches ZERO
--       rows, for ANY tenant. tenant_assignments_insert
--       (017_tenant_assignments.sql) explicitly lets ralli_admin create
--       assignments for any tenant, so a ralli_admin-initiated call under
--       SECURITY INVOKER would see no quiz_attempts at all for the target
--       tenant — completed users would be miscounted as still-active,
--       incorrectly blocking their legitimate reassignment. A real,
--       concrete gap for a real, permitted caller — not hypothetical.
--
--     * lesson_completions_select (010_content_tables.sql) is
--         USING (profile_id = auth.uid() OR get_my_role() IN ('ralli_admin','orgAdmin','manager'))
--       with NO tenant scoping at all in the role branch — the opposite
--       problem: any orgAdmin/manager of ANY tenant can read
--       lesson_completions for EVERY tenant. This happens to make lesson/
--       course completion checks "complete" for our purposes, but only by
--       accident, via a pre-existing cross-tenant over-exposure that is out
--       of scope to fix here (flagged separately, not touched by this
--       migration — see the audit notes for this fix).
--
--   Net result: relying on the underlying tables' RLS to jointly produce a
--   correct, tenant-complete eligibility calculation is not something we can
--   assume — it's false for at least one permitted caller (ralli_admin +
--   quiz_attempts) today, and would silently break again if any of these
--   four policies changes independently in the future.
--
--   Fix: create_assignments_atomic() is SECURITY DEFINER with a locked-down
--   search_path, so its internal reads bypass RLS entirely and their
--   correctness depends only on the WHERE clauses written in this file (all
--   explicitly tenant_id-scoped), not on five different tables' policies
--   staying simultaneously correct. Because RLS is bypassed, the function
--   manually replicates tenant_assignments_insert's own authorization check
--   before doing anything else:
--     * auth.uid() must resolve to a real, authenticated caller.
--     * the caller's profile must have role IN ('ralli_admin','orgAdmin','manager').
--     * a non-ralli_admin caller's own tenant_id must exactly match
--       p_tenant_id — they cannot supply another tenant's ID. Only
--       ralli_admin may act cross-tenant, identical to the existing INSERT
--       policy's own bypass (not a new capability introduced here).
--   This reuses get_my_role()/get_my_tenant_id() (003_fix_rls.sql) — the
--   same SECURITY DEFINER helpers every other RLS policy in this schema
--   already relies on — rather than hand-rolling a second, potentially
--   divergent implementation of "what does profiles.role/tenant_id say".
--
--   The two helper functions below stay SECURITY INVOKER. That's still safe:
--   Postgres evaluates privileges using the CURRENT effective role at each
--   point in the call stack, and a SECURITY DEFINER function's body executes
--   as its owner for its whole duration — so when create_assignments_atomic
--   calls a SECURITY INVOKER helper, that helper "invokes as" the definer's
--   owner (already-elevated), not the original end-user session. The
--   helpers still work correctly with full visibility when called from
--   inside create_assignments_atomic, without themselves needing to be
--   SECURITY DEFINER. To make sure that elevation can't be reached any other
--   way, EXECUTE on both helpers is explicitly revoked from PUBLIC/
--   authenticated below — they are only reachable via the definer function's
--   internal calls, never directly over RPC. If either helper is ever
--   called directly by an ordinary session (which it can't be, per the
--   grants below), it would just run under that caller's own RLS as an
--   invoker function normally would — no privilege bypass either way.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Helper: expand one assigned_to JSONB value into the user IDs it covers ───
-- Used both for legacy aggregate rows (assigned_to.type = 'team'/'group') and
-- new per-user rows (assigned_to.type = 'individual') so eligibility checks
-- are correct regardless of when the existing assignment was created.
CREATE OR REPLACE FUNCTION public._assignment_target_user_ids(p_tenant_id UUID, p_assigned_to JSONB)
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_type TEXT := p_assigned_to->>'type';
BEGIN
  IF v_type = 'individual' THEN
    IF p_assigned_to->>'userId' IS NOT NULL AND (p_assigned_to->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN QUERY SELECT (p_assigned_to->>'userId')::UUID;
    END IF;
    RETURN;
  END IF;

  IF v_type = 'team' THEN
    IF p_assigned_to->>'teamId' IS NULL OR NOT ((p_assigned_to->>'teamId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') THEN
      RETURN;
    END IF;
    RETURN QUERY
      SELECT id FROM public.profiles
      WHERE tenant_id = p_tenant_id
        AND team_id = (p_assigned_to->>'teamId')::UUID
        AND status NOT IN ('inactive', 'suspended');
    RETURN;
  END IF;

  IF v_type = 'group' THEN
    RETURN QUERY
      SELECT id FROM public.profiles
      WHERE tenant_id = p_tenant_id
        AND status NOT IN ('inactive', 'suspended')
        AND role NOT IN ('ralli_admin', 'orgAdmin');
    RETURN;
  END IF;

  RETURN;
END;
$$;

-- ── Helper: which users have completed a piece of content ───────────────────
-- Mirrors getCompletedUserIds() in contentService.js. Course completion
-- requires every lesson in the course's lesson_ids; an empty or missing
-- (or cross-tenant) course never counts anyone as complete.
CREATE OR REPLACE FUNCTION public._content_completed_user_ids(p_tenant_id UUID, p_content_type TEXT, p_content_id TEXT)
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_lesson_ids   JSONB;
  v_lesson_count INT;
BEGIN
  IF p_content_type = 'quiz' THEN
    RETURN QUERY
      SELECT DISTINCT user_id FROM public.quiz_attempts
      WHERE tenant_id = p_tenant_id AND quiz_id = p_content_id::UUID AND passed = true;
    RETURN;
  END IF;

  IF p_content_type = 'lesson' THEN
    RETURN QUERY
      SELECT DISTINCT profile_id FROM public.lesson_completions
      WHERE tenant_id = p_tenant_id AND lesson_id = p_content_id;
    RETURN;
  END IF;

  IF p_content_type = 'course' THEN
    SELECT lesson_ids INTO v_lesson_ids
      FROM public.tenant_courses
      WHERE id = p_content_id::UUID AND tenant_id = p_tenant_id; -- tenant-scoped, same fix as getCompletedUserIds()

    IF v_lesson_ids IS NULL OR jsonb_array_length(v_lesson_ids) = 0 THEN
      RETURN; -- missing/cross-tenant/empty course — nobody counts as complete
    END IF;
    v_lesson_count := jsonb_array_length(v_lesson_ids);

    RETURN QUERY
      SELECT profile_id
      FROM public.lesson_completions
      WHERE tenant_id = p_tenant_id
        AND lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
      GROUP BY profile_id
      HAVING COUNT(DISTINCT lesson_id) >= v_lesson_count;
    RETURN;
  END IF;

  RETURN;
END;
$$;

-- ── Main entry point: atomic check-then-insert-then-skip ─────────────────────
-- p_candidates: JSONB array of { "userId": "<uuid>", "userName": "<text>" },
-- already resolved and tenant/status-validated by resolveTargetCandidates()
-- in contentService.js. This function does NOT re-derive the candidate list
-- (team/group membership resolution is safe to do outside the lock, since
-- membership isn't what races); it only makes the eligibility-check-and-
-- insert step atomic, which is where the race actually lives.
CREATE OR REPLACE FUNCTION public.create_assignments_atomic(
  p_tenant_id     UUID,
  p_content_type  TEXT,
  p_content_id    TEXT,
  p_candidates    JSONB,
  p_due_at        TEXT,
  p_required      BOOLEAN,
  p_assigned_by   UUID,
  p_source_type   TEXT,
  p_source_id     UUID,
  p_source_label  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_role   TEXT;
  v_caller_tenant UUID;
  v_lock_key      BIGINT;
  v_active_ids    UUID[];
  v_candidate     JSONB;
  v_user_id       UUID;
  v_user_name     TEXT;
  v_eligible      JSONB[] := ARRAY[]::JSONB[];
  v_skipped       JSONB[] := ARRAY[]::JSONB[];
  v_created       JSONB[] := ARRAY[]::JSONB[];
  v_new_row       public.tenant_assignments%ROWTYPE;
BEGIN
  -- Manual authorization — required because SECURITY DEFINER bypasses RLS,
  -- so tenant_assignments_insert's own WITH CHECK no longer runs for the
  -- INSERT below. This block is that same check, replicated exactly:
  -- get_my_role() IN ('ralli_admin','orgAdmin','manager') AND
  -- (get_my_role() = 'ralli_admin' OR tenant_id = get_my_tenant_id()).
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'create_assignments_atomic: must be authenticated';
  END IF;

  v_caller_role   := public.get_my_role();
  v_caller_tenant := public.get_my_tenant_id();

  IF v_caller_role IS NULL THEN
    RAISE EXCEPTION 'create_assignments_atomic: caller profile not found';
  END IF;

  IF v_caller_role NOT IN ('ralli_admin', 'orgAdmin', 'manager') THEN
    RAISE EXCEPTION 'create_assignments_atomic: unauthorized role %', v_caller_role;
  END IF;

  -- A non-ralli_admin caller can only ever act on their own tenant — this is
  -- the check that prevents a caller from supplying another tenant's ID.
  IF v_caller_role != 'ralli_admin' AND v_caller_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'create_assignments_atomic: tenant mismatch — caller does not belong to tenant %', p_tenant_id;
  END IF;

  IF p_content_type NOT IN ('quiz', 'lesson', 'course') THEN
    RAISE EXCEPTION 'create_assignments_atomic: invalid content_type %', p_content_type;
  END IF;

  -- Serialize every concurrent call for this exact tenant+content combination.
  -- Transaction-scoped: released automatically at commit/rollback, so a
  -- crashed request can never leave the lock held.
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_content_type || ':' || p_content_id, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Active = currently targeted by an existing assignment row (own or via
  -- legacy team/group expansion) AND not completed. Completed users are
  -- intentionally excluded here so they remain eligible for reassignment.
  SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::UUID[])
  INTO v_active_ids
  FROM (
    SELECT expand.user_id AS uid
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = p_content_type
      AND ta.content_id = p_content_id
  ) AS all_targeted
  WHERE uid NOT IN (
    SELECT completed.id FROM public._content_completed_user_ids(p_tenant_id, p_content_type, p_content_id) AS completed(id)
  );

  -- Partition candidates into eligible / skipped. Re-validates tenant +
  -- inactive/suspended status here too (defense in depth) — the caller is
  -- expected to have already filtered these via resolveTargetCandidates().
  FOR v_candidate IN SELECT * FROM jsonb_array_elements(COALESCE(p_candidates, '[]'::jsonb))
  LOOP
    v_user_id := CASE
      WHEN (v_candidate->>'userId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      THEN (v_candidate->>'userId')::UUID
      ELSE NULL
    END;
    v_user_name := v_candidate->>'userName';

    IF v_user_id IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM public.profiles
      WHERE id = v_user_id AND tenant_id = p_tenant_id AND status NOT IN ('inactive', 'suspended')
    ) THEN
      v_skipped := v_skipped || jsonb_build_object('userId', v_user_id, 'userName', v_user_name, 'reason', 'not_in_tenant_or_ineligible', 'dueAt', NULL);
      CONTINUE;
    END IF;

    IF v_user_id = ANY(v_active_ids) THEN
      v_skipped := v_skipped || jsonb_build_object('userId', v_user_id, 'userName', v_user_name, 'reason', 'already_assigned', 'dueAt', p_due_at);
    ELSE
      v_eligible := v_eligible || jsonb_build_object('userId', v_user_id, 'userName', v_user_name);
    END IF;
  END LOOP;

  -- Insert eligible rows. Still inside the locked transaction — no other
  -- call for this tenant+content can interleave between the check above and
  -- these inserts. RLS is bypassed here (SECURITY DEFINER), which is why the
  -- role/tenant check above exists — it's the actual authorization gate now,
  -- deliberately kept equivalent to tenant_assignments_insert's WITH CHECK.
  FOR v_candidate IN SELECT * FROM unnest(v_eligible)
  LOOP
    INSERT INTO public.tenant_assignments (
      tenant_id, content_type, content_id, assigned_to, due_at, required,
      assigned_by, source_type, source_id, source_label
    ) VALUES (
      p_tenant_id, p_content_type, p_content_id,
      jsonb_build_object('type', 'individual', 'userId', v_candidate->>'userId', 'userName', v_candidate->>'userName'),
      NULLIF(p_due_at, 'Open'),
      COALESCE(p_required, false),
      p_assigned_by,
      p_source_type,
      p_source_id,
      p_source_label
    )
    RETURNING * INTO v_new_row;

    v_created := v_created || to_jsonb(v_new_row);
  END LOOP;

  RETURN jsonb_build_object(
    'created',       to_jsonb(v_created),
    'skipped',       to_jsonb(v_skipped),
    'assignedCount', COALESCE(array_length(v_created, 1), 0),
    'skippedCount',  COALESCE(array_length(v_skipped, 1), 0)
  );
END;
$$;

-- Internal helpers are never exposed over RPC — only reachable via
-- create_assignments_atomic()'s own internal calls (see security-model
-- comment above for why that's still safe: they stay SECURITY INVOKER, no
-- privilege is gained by finding a way to call them directly, and this
-- REVOKE just keeps them off the public API surface entirely).
REVOKE EXECUTE ON FUNCTION public._assignment_target_user_ids FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public._content_completed_user_ids FROM PUBLIC;

-- create_assignments_atomic is the only function authenticated sessions can
-- call directly. Explicitly revoke the default PUBLIC grant first so 'anon'
-- (unauthenticated) cannot invoke it — belt and suspenders alongside the
-- auth.uid() IS NULL check inside the function itself.
REVOKE EXECUTE ON FUNCTION public.create_assignments_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_assignments_atomic TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('_assignment_target_user_ids', '_content_completed_user_ids', 'create_assignments_atomic');
-- -- prosecdef should be TRUE only for create_assignments_atomic; false for both helpers.
--
-- SELECT grantee, privilege_type FROM information_schema.role_routine_grants
--   WHERE routine_name IN ('_assignment_target_user_ids', '_content_completed_user_ids', 'create_assignments_atomic');
-- -- Expect: only create_assignments_atomic granted to 'authenticated'; no PUBLIC grants on any of the three.
--
-- Manual race test (run two sessions concurrently against the same
-- tenant/content/candidate before either commits):
-- SELECT create_assignments_atomic('<tenant>', 'quiz', '<quizId>',
--   '[{"userId":"<repId>","userName":"Test Rep"}]'::jsonb, 'Open', false, '<managerId>', 'individual', NULL, NULL);
-- -- Expect: exactly one call returns assignedCount=1, the other assignedCount=0/skippedCount=1.
--
-- Manual cross-tenant test: as an orgAdmin/manager of tenant A, call
-- create_assignments_atomic with p_tenant_id = tenant B's UUID.
-- -- Expect: exception "tenant mismatch — caller does not belong to tenant B".
