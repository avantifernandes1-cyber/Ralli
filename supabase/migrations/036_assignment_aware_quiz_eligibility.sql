-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 036: Assignment-instance-aware quiz eligibility.
-- Run after 035_fix_quiz_reassignment_eligibility.sql.
--
-- Problem being fixed:
--   _content_completed_user_ids() answers "has this user EVER attempted this
--   quiz" with no reference to which assignment is being evaluated. That
--   collapses two different questions into one:
--     (a) has the user resolved their CURRENT (latest) assignment for this
--         quiz?
--     (b) has the user EVER attempted this quiz, at any point in the past?
--   create_assignments_atomic() needs (a) to decide whether a new assignment
--   should be blocked as an active duplicate. It was getting (b) instead.
--   Concretely: once a user has attempted a quiz even once, EVERY future
--   reassignment of that quiz is permanently treated as "already resolved" —
--   even a reassignment created seconds ago that the user hasn't touched yet.
--   This caused two confirmed, live-reproduced failures:
--     1. A brand-new reassignment could be silently dropped from the user's
--        Assigned Learning (HomeScreen's own completion check has the same
--        flaw — fixed client-side in rankd-app.jsx, this migration fixes the
--        server-side enforcement that fix depends on for consistency).
--     2. create_assignments_atomic() would NOT block a second, third, ...
--        immediate duplicate assignment for a user who'd attempted the quiz
--        at any point in the past — verified live: assigning, then
--        immediately re-assigning the same user+quiz with zero attempts in
--        between, succeeded twice in a row instead of being skipped.
--
-- Fix:
--   Eligibility must be evaluated per ASSIGNMENT INSTANCE, not per content.
--   For quiz content specifically: a user is "active" (blocks a new
--   assignment) if their MOST RECENT assignment row for this quiz has NO
--   quiz_attempts row created at or after that assignment's assigned_at.
--   Once a qualifying attempt exists (pass OR fail — matching 035's existing
--   "any attempt resolves it" rule), the user is resolved and eligible for
--   reassignment; an OLDER attempt, from before the current assignment was
--   created, no longer counts.
--
--   New helper: _quiz_assignment_active_user_ids(tenant_id, quiz_id) — for
--   every user ever targeted by any assignment row for this quiz (expanded
--   through the same _assignment_target_user_ids() used everywhere else in
--   this engine, so legacy team/group aggregate rows are handled identically
--   to new per-user rows), finds their latest assigned_at across all rows
--   that target them, and returns the user only if no qualifying attempt
--   exists after that latest assigned_at.
--
--   create_assignments_atomic() now branches on content_type: quiz content
--   uses the new assignment-aware helper; lesson/course content is
--   UNCHANGED — still uses _content_completed_user_ids() exactly as before.
--   Lesson/course completion has no per-assignment timestamp available today
--   (lesson_completions carries no timestamp in the current schema) and
--   changing that is a separate, larger change out of scope here — this
--   migration touches quiz eligibility only, per the confirmed bug.
--
--   _content_completed_user_ids() itself is left as-is (still used for
--   lesson/course, and still callable standalone for reporting) — its quiz
--   branch is simply no longer consulted by create_assignments_atomic().
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._quiz_assignment_active_user_ids(p_tenant_id UUID, p_content_id TEXT)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
AS $$
  WITH targeted AS (
    -- Every (user, assigned_at) pair ever targeted for this quiz, expanded from
    -- every assignment row — individual rows and legacy team/group aggregate
    -- rows alike — via the same expansion the rest of this engine already uses.
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'quiz'
      AND ta.content_id = p_content_id
  ),
  latest AS (
    -- Only each user's MOST RECENT assignment instance for this quiz matters
    -- for "are they currently active" — earlier assignments are history and
    -- must not keep blocking reassignment forever.
    SELECT uid, MAX(assigned_at) AS latest_assigned_at
    FROM targeted
    GROUP BY uid
  )
  SELECT l.uid
  FROM latest l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.quiz_attempts qa
    WHERE qa.tenant_id = p_tenant_id
      AND qa.quiz_id = p_content_id::UUID
      AND qa.user_id = l.uid
      AND qa.created_at >= l.latest_assigned_at
  );
$$;

COMMENT ON FUNCTION public._quiz_assignment_active_user_ids IS
  'Users whose most recent quiz assignment for p_content_id has no qualifying '
  'attempt (created_at >= that assignment''s assigned_at) yet — i.e. still '
  'active and blocking a new assignment. Assignment-instance-aware, unlike '
  '_content_completed_user_ids() which only sees "attempted ever".';

-- Same access model as the other internal helpers this engine already has:
-- SECURITY INVOKER (default), reachable only from inside the SECURITY
-- DEFINER create_assignments_atomic() call, never directly over RPC.
REVOKE EXECUTE ON FUNCTION public._quiz_assignment_active_user_ids FROM PUBLIC;

-- ── create_assignments_atomic(): branch the active-user computation ─────────
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
  -- Manual authorization — unchanged from 034/035.
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

  IF v_caller_role != 'ralli_admin' AND v_caller_tenant IS DISTINCT FROM p_tenant_id THEN
    RAISE EXCEPTION 'create_assignments_atomic: tenant mismatch — caller does not belong to tenant %', p_tenant_id;
  END IF;

  IF p_content_type NOT IN ('quiz', 'lesson', 'course') THEN
    RAISE EXCEPTION 'create_assignments_atomic: invalid content_type %', p_content_type;
  END IF;

  -- Serialize every concurrent call for this exact tenant+content combination.
  v_lock_key := hashtextextended(p_tenant_id::text || ':' || p_content_type || ':' || p_content_id, 0);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Active-user computation — assignment-instance-aware for quiz content
  -- (see _quiz_assignment_active_user_ids() above); unchanged content-level
  -- computation for lesson/course, exactly as in 034/035.
  IF p_content_type = 'quiz' THEN
    SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::UUID[])
    INTO v_active_ids
    FROM public._quiz_assignment_active_user_ids(p_tenant_id, p_content_id) AS t(uid);
  ELSE
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
  END IF;

  -- Partition candidates into eligible / skipped — unchanged from 034.
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

  -- Insert eligible rows — unchanged from 034.
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

REVOKE EXECUTE ON FUNCTION public.create_assignments_atomic FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.create_assignments_atomic TO authenticated;

-- ── Verify ────────────────────────────────────────────────────────────────────
-- SELECT proname, prosecdef FROM pg_proc
--   WHERE proname IN ('_quiz_assignment_active_user_ids', 'create_assignments_atomic');
--
-- Manual test — old attempt, new assignment must stay active:
--   1. Ensure a quiz_attempts row exists for a user+quiz from BEFORE now.
--   2. Assign that same quiz to that user (creates a new tenant_assignments row).
--   3. Immediately try to assign it again — expect assignedCount=0, skipped
--      with reason='already_assigned' (blocked as an active duplicate).
--   4. Record a new quiz_attempts row (created_at now, after step 2's
--      assigned_at) for that user+quiz — pass or fail, either resolves it.
--   5. Assign the quiz again — expect assignedCount=1 (reassignment allowed).
