-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 037: Assignment-instance-aware lesson & course eligibility.
-- Run after 036_assignment_aware_quiz_eligibility.sql.
--
-- Problem being fixed:
--   Migration 036 fixed this exact bug for quizzes but explicitly left lesson/
--   course on the old, content-level check ("has this user EVER completed
--   this lesson/course"), reasoning at the time that lesson_completions
--   carried no timestamp to compare against an assignment's assigned_at.
--   That reasoning was wrong — lesson_completions.completed_at has existed
--   since 010_content_tables.sql. This migration is the lesson/course
--   counterpart to 036, using the timestamp that was there all along.
--
--   Confirmed bug, same shape as the quiz bug 036 fixed:
--     1. A brand-new lesson/course reassignment can be silently invisible —
--        _content_completed_user_ids() sees the user's OLD completion (from
--        before the new assignment existed) and reports them complete, so
--        create_assignments_atomic() treats the fresh assignment as already
--        resolved-eligible and the display layer marks it done on arrival.
--     2. create_assignments_atomic() would not block a second, immediate
--        duplicate lesson/course assignment for a user who completed it at
--        any point in the past — the stale completion satisfies the
--        "not completed" eligibility check even though their most recent
--        assignment is genuinely still unresolved.
--
-- Fix:
--   Eligibility evaluated per ASSIGNMENT INSTANCE, exactly like quiz:
--     * _lesson_assignment_active_user_ids(tenant_id, lesson_id) — a user is
--       "active" (blocks a new assignment) if their most recent assignment
--       row for this lesson has no lesson_completions row with
--       completed_at >= that assignment's assigned_at.
--     * _course_assignment_active_user_ids(tenant_id, course_id) — a user is
--       "active" if, of the course's lesson_ids, fewer than all of them have
--       a completion with completed_at >= their most recent course
--       assignment's assigned_at. An old completion from before the current
--       course assignment does not count toward resolving it, matching the
--       required behavior: every qualifying lesson completion must have
--       occurred after that course assignment's assigned_at.
--
--   create_assignments_atomic() now branches on all three content types
--   individually instead of quiz vs. "everything else".
--
--   _content_completed_user_ids() is left as-is — it's still a correct
--   answer to "has this user EVER completed X" (used for reporting), just no
--   longer what create_assignments_atomic() consults for lesson/course
--   eligibility, mirroring exactly how 036 already treated the quiz branch.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public._lesson_assignment_active_user_ids(p_tenant_id UUID, p_content_id TEXT)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
AS $$
  WITH targeted AS (
    -- Every (user, assigned_at) pair ever targeted for this lesson, expanded
    -- from every assignment row — individual rows and legacy team/group
    -- aggregate rows alike — via the same expansion the rest of this engine
    -- already uses.
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'lesson'
      AND ta.content_id = p_content_id
  ),
  latest AS (
    -- Only each user's MOST RECENT assignment instance for this lesson
    -- matters for "are they currently active" — earlier assignments are
    -- history and must not keep blocking reassignment forever.
    SELECT uid, MAX(assigned_at) AS latest_assigned_at
    FROM targeted
    GROUP BY uid
  )
  SELECT l.uid
  FROM latest l
  WHERE NOT EXISTS (
    SELECT 1 FROM public.lesson_completions lc
    WHERE lc.tenant_id = p_tenant_id
      AND lc.lesson_id = p_content_id
      AND lc.profile_id = l.uid
      AND lc.completed_at >= l.latest_assigned_at
  );
$$;

COMMENT ON FUNCTION public._lesson_assignment_active_user_ids IS
  'Users whose most recent lesson assignment for p_content_id has no qualifying '
  'completion (completed_at >= that assignment''s assigned_at) yet — i.e. still '
  'active and blocking a new assignment. Assignment-instance-aware, unlike '
  '_content_completed_user_ids() which only sees "completed ever". Lesson '
  'counterpart to _quiz_assignment_active_user_ids().';

REVOKE EXECUTE ON FUNCTION public._lesson_assignment_active_user_ids FROM PUBLIC;

CREATE OR REPLACE FUNCTION public._course_assignment_active_user_ids(p_tenant_id UUID, p_content_id TEXT)
RETURNS SETOF UUID
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_lesson_ids   JSONB;
  v_lesson_count INT;
BEGIN
  SELECT lesson_ids INTO v_lesson_ids
    FROM public.tenant_courses
    WHERE id = p_content_id::UUID AND tenant_id = p_tenant_id; -- tenant-scoped, matches _content_completed_user_ids()

  IF v_lesson_ids IS NULL OR jsonb_array_length(v_lesson_ids) = 0 THEN
    RETURN; -- missing/cross-tenant/empty course — nobody is "active"; mirrors
             -- _content_completed_user_ids(): nobody can complete it either.
  END IF;
  v_lesson_count := jsonb_array_length(v_lesson_ids);

  RETURN QUERY
  WITH targeted AS (
    SELECT expand.user_id AS uid, ta.assigned_at
    FROM public.tenant_assignments ta
    CROSS JOIN LATERAL public._assignment_target_user_ids(p_tenant_id, ta.assigned_to) AS expand(user_id)
    WHERE ta.tenant_id = p_tenant_id
      AND ta.content_type = 'course'
      AND ta.content_id = p_content_id
  ),
  latest AS (
    SELECT uid, MAX(assigned_at) AS latest_assigned_at
    FROM targeted
    GROUP BY uid
  )
  SELECT l.uid
  FROM latest l
  WHERE (
    -- Count only lessons whose completion happened at/after THIS course
    -- assignment's assigned_at — an old completion from a prior assignment
    -- does not count toward resolving the current one.
    SELECT COUNT(DISTINCT lc.lesson_id)
    FROM public.lesson_completions lc
    WHERE lc.tenant_id = p_tenant_id
      AND lc.profile_id = l.uid
      AND lc.lesson_id IN (SELECT jsonb_array_elements_text(v_lesson_ids))
      AND lc.completed_at >= l.latest_assigned_at
  ) < v_lesson_count;
END;
$$;

COMMENT ON FUNCTION public._course_assignment_active_user_ids IS
  'Users whose most recent course assignment for p_content_id does not yet have '
  'ALL of the course''s lessons completed at/after that assignment''s '
  'assigned_at — i.e. still active and blocking a new assignment. '
  'Assignment-instance-aware, unlike _content_completed_user_ids(). Course '
  'counterpart to _quiz_assignment_active_user_ids() / '
  '_lesson_assignment_active_user_ids().';

REVOKE EXECUTE ON FUNCTION public._course_assignment_active_user_ids FROM PUBLIC;

-- ── create_assignments_atomic(): branch the active-user computation per type ─
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
  -- Manual authorization — unchanged from 034/035/036.
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

  -- Active-user computation — assignment-instance-aware for every content
  -- type now. Quiz added in 036; lesson/course added here.
  IF p_content_type = 'quiz' THEN
    SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::UUID[])
    INTO v_active_ids
    FROM public._quiz_assignment_active_user_ids(p_tenant_id, p_content_id) AS t(uid);
  ELSIF p_content_type = 'lesson' THEN
    SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::UUID[])
    INTO v_active_ids
    FROM public._lesson_assignment_active_user_ids(p_tenant_id, p_content_id) AS t(uid);
  ELSE -- course
    SELECT COALESCE(array_agg(DISTINCT uid), ARRAY[]::UUID[])
    INTO v_active_ids
    FROM public._course_assignment_active_user_ids(p_tenant_id, p_content_id) AS t(uid);
  END IF;

  -- Partition candidates into eligible / skipped — unchanged from 034/036.
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

  -- Insert eligible rows — unchanged from 034/036.
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
--   WHERE proname IN ('_lesson_assignment_active_user_ids', '_course_assignment_active_user_ids', 'create_assignments_atomic');
--
-- Manual test — old lesson completion, new assignment must stay active:
--   1. Ensure a lesson_completions row exists for a user+lesson from BEFORE now.
--   2. Assign that same lesson to that user (creates a new tenant_assignments row).
--   3. Immediately try to assign it again — expect assignedCount=0, skipped
--      with reason='already_assigned' (blocked as an active duplicate).
--   4. Mark the lesson complete again (completed_at now, after step 2's
--      assigned_at) for that user — resolves it.
--   5. Assign the lesson again — expect assignedCount=1 (reassignment allowed).
--
-- Manual test — course, same shape, using every lesson in the course.
