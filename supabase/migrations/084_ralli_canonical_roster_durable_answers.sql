-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 084: Ralli Live CANONICAL ROSTER + DURABLE ANSWER SUBMISSION
--
-- Fixes the proven multi-player integrity failure (session c8c83584 "Dre's Quiz"):
-- the host froze its scoring roster from EPHEMERAL realtime state at the first
-- reveal and persisted answers only at reveal from a client-supplied, unauthenticated
-- playerId — so a durably-joined learner whose realtime presence/answer missed the
-- Q0 snapshot was silently dropped from answers/scores/scoreboard/final players.
--
-- This migration makes the DATABASE the source of truth for BOTH membership and
-- answers, server-authoritatively:
--   1. game_roster_members — an immutable canonical roster snapshot created ATOMICALLY
--      inside rpc_start_session (one locked transaction: authorize → lock → confirm →
--      resolve eligible authenticated learners → snapshot identity/team → started).
--   2. game_answer_submissions — durable, first-write-locked, idempotent per-learner raw
--      answers written by the LEARNER via rpc_submit_game_answer (player_id = auth.uid();
--      never client-supplied), with a SERVER receipt timestamp. No correctness stored.
--   3. rpc_begin_question_reveal — the deterministic reveal boundary: locks the session
--      (same lock order as submission), closes submissions, returns the canonical roster +
--      durable submissions for the host to grade with the ONE existing JS grader.
--
-- Additive + forward-only. Does NOT change grading/scoring formulas (client keeps the
-- single canonical grader), analytics, or the 072 verification tables. Superseded RPCs
-- are faithful supersets of the deployed bodies. No leaderboard rank is computed here.
-- ─────────────────────────────────────────────────────────────────────────────

-- 0. Durable server-stamped question start (trustworthy deadline + future speed source).
ALTER TABLE public.game_sessions
  ADD COLUMN IF NOT EXISTS current_question_started_at timestamptz;
COMMENT ON COLUMN public.game_sessions.current_question_started_at IS
  'Server timestamp stamped when a question phase begins (084). Trustworthy submission-deadline base and future latency source (server_received_at - this). NOT client time_ms.';

-- ══ PART 1 — CANONICAL ROSTER TABLE ═════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.game_roster_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  uuid NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  tenant_id   text NOT NULL,
  player_id   text NOT NULL,            -- profiles.id (= auth.uid), stable identity
  name        text,
  emoji       text,
  team_id     uuid,                     -- team-at-game-start snapshot
  team_name   text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','left')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_roster_session_player UNIQUE (session_id, player_id)
);
COMMENT ON TABLE public.game_roster_members IS
  'Immutable canonical Ralli Live roster snapshot, created atomically at game start from eligible authenticated same-tenant learner participants (084). Identity/team frozen at start. Presence/heartbeat are connected-now only and NEVER change membership. Only status may flip active<->left (rejoin/leave); no member added or removed after start.';
CREATE INDEX IF NOT EXISTS idx_roster_session ON public.game_roster_members(session_id);
CREATE INDEX IF NOT EXISTS idx_roster_tenant  ON public.game_roster_members(tenant_id);

-- ══ PART 2 — DURABLE ANSWER SUBMISSIONS TABLE ═══════════════════════════════════
CREATE TABLE IF NOT EXISTS public.game_answer_submissions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id     uuid NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  tenant_id      text NOT NULL,               -- server-derived
  player_id      text NOT NULL,               -- auth.uid(); never client-supplied
  question_idx   integer NOT NULL,
  q_type         text NOT NULL,               -- from the frozen snapshot (shape only)
  option_idx     integer,                     -- mc/tf
  answer_text    text,                        -- type/open
  numeric_value  numeric,                     -- slider (0 preserved)
  answer_json    jsonb,                       -- match: [{leftIdx,rightIdx}]
  submitted_at   timestamptz NOT NULL DEFAULT now(),   -- SERVER receipt
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_submission_session_player_q UNIQUE (session_id, player_id, question_idx)
);
COMMENT ON TABLE public.game_answer_submissions IS
  'Durable, first-write-locked, idempotent per-learner RAW answer submissions (084). player_id = auth.uid() (never client-supplied); server receipt timestamp. NO correctness/points/rank/solution stored. Reveal grades these with the shared canonical grader.';
CREATE INDEX IF NOT EXISTS idx_sub_session_q ON public.game_answer_submissions(session_id, question_idx);
CREATE INDEX IF NOT EXISTS idx_sub_player    ON public.game_answer_submissions(player_id);

-- ── Immutability: both tables are append-only truth. Block ALL client UPDATE/DELETE. ──
CREATE OR REPLACE FUNCTION public.game_roster_block_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  -- Allow only the status active<->left flip on UPDATE; forbid identity/membership edits and all DELETE.
  IF (TG_OP = 'DELETE') THEN
    RAISE EXCEPTION 'game_roster_members is immutable (no delete)';
  END IF;
  IF NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.player_id IS DISTINCT FROM OLD.player_id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.emoji IS DISTINCT FROM OLD.emoji OR NEW.team_id IS DISTINCT FROM OLD.team_id
     OR NEW.team_name IS DISTINCT FROM OLD.team_name OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'game_roster_members identity is immutable (only status may change)';
  END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION public.game_submission_block_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'game_answer_submissions is append-only; UPDATE/DELETE not permitted';
END; $$;

DROP TRIGGER IF EXISTS trg_roster_block ON public.game_roster_members;
CREATE TRIGGER trg_roster_block BEFORE UPDATE OR DELETE ON public.game_roster_members
  FOR EACH ROW EXECUTE FUNCTION public.game_roster_block_mutation();
DROP TRIGGER IF EXISTS trg_sub_block ON public.game_answer_submissions;
CREATE TRIGGER trg_sub_block BEFORE UPDATE OR DELETE ON public.game_answer_submissions
  FOR EACH ROW EXECUTE FUNCTION public.game_submission_block_mutation();

-- ── RLS + grants ────────────────────────────────────────────────────────────────
ALTER TABLE public.game_roster_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_answer_submissions   ENABLE ROW LEVEL SECURITY;

-- Roster: authenticated same-tenant may READ (host/learner see their tenant's roster). No client writes.
DROP POLICY IF EXISTS roster_tenant_read ON public.game_roster_members;
CREATE POLICY roster_tenant_read ON public.game_roster_members
  FOR SELECT TO authenticated USING (tenant_id = (public.get_my_tenant_id())::text);

-- Submissions: a learner may READ ONLY THEIR OWN. No client INSERT/UPDATE/DELETE (only the
-- SECURITY DEFINER submit RPC writes). Host/manager read submissions ONLY via the reveal RPC.
DROP POLICY IF EXISTS sub_own_read ON public.game_answer_submissions;
CREATE POLICY sub_own_read ON public.game_answer_submissions
  FOR SELECT TO authenticated USING (player_id = auth.uid()::text);

REVOKE ALL    ON public.game_roster_members     FROM anon, authenticated;
REVOKE ALL    ON public.game_answer_submissions FROM anon, authenticated;
GRANT  SELECT ON public.game_roster_members     TO authenticated;
GRANT  SELECT ON public.game_answer_submissions TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_roster_members     TO service_role;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_answer_submissions TO service_role;

-- ══ PART 3 — ATOMIC START + CANONICAL ROSTER (supersede rpc_start_session, 083) ═══
-- Faithful superset of the 083 start guard, PLUS: in the SAME locked transaction, resolve the
-- eligible authenticated learner participants, snapshot them into game_roster_members, and only
-- then transition to 'started'. Fail closed (no start) if no eligible learners or roster insert
-- yields none. Returns {ok, session_id, roster:[...]} — the extra `roster` field is additive and
-- does not break the old caller (which reads only ok/session_id/reason).
CREATE OR REPLACE FUNCTION public.rpc_start_session(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_qstatus text; v_n int; v_roster jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session id required' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id FOR UPDATE;   -- lock session (consistent order)
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.demo_mode IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'demo session is not server-persisted' USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.status <> 'waiting' THEN
    RAISE EXCEPTION 'session not startable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  IF v_s.question_snapshot IS NULL THEN
    RAISE EXCEPTION 'session has no question snapshot' USING ERRCODE = 'check_violation';
  END IF;
  SELECT q.status INTO v_qstatus FROM public.tenant_quizzes q
    WHERE q.id::text = v_s.quiz_id AND q.tenant_id::text = v_s.tenant_id FOR SHARE;
  IF v_qstatus IS DISTINCT FROM 'active' THEN
    UPDATE public.game_sessions SET status = 'canceled', ended_at = now(), live_question = NULL
     WHERE id = v_s.id AND status = 'waiting';
    RETURN jsonb_build_object('ok', false, 'reason', 'quiz_unavailable', 'session_id', v_s.id);
  END IF;

  -- Canonical roster: eligible authenticated learner participants of THIS exact session, resolved
  -- server-side from durable rows (participant active/joined) ⋈ active role='user' same-tenant profile.
  -- Identity + team snapshotted from durable data (never presence/answer payloads).
  -- Team snapshot resolved EXACTLY like 071: same-tenant tenant_teams row only, else NULL
  -- (guest/no-team/cross-tenant team → NULL; never guessed). Immutable for the game.
  INSERT INTO public.game_roster_members (session_id, tenant_id, player_id, name, emoji, team_id, team_name)
  SELECT v_s.id, v_s.tenant_id, gsp.player_id,
         COALESCE(gsp.name, p.name), gsp.emoji, tt.id, tt.name
  FROM public.game_session_participants gsp
  JOIN public.profiles p ON p.id::text = gsp.player_id
  LEFT JOIN public.tenant_teams tt ON tt.id = p.team_id AND tt.tenant_id::text = v_s.tenant_id
  WHERE gsp.session_id = v_s.id
    AND gsp.status IN ('active','joined')
    AND p.tenant_id::text = v_s.tenant_id
    AND p.role = 'user'
    AND p.status = 'active'
  ON CONFLICT (session_id, player_id) DO NOTHING;

  SELECT count(*) INTO v_n FROM public.game_roster_members WHERE session_id = v_s.id;
  IF v_n = 0 THEN
    -- Fail closed: never start a real game with no eligible learners. Session stays 'waiting'.
    RAISE EXCEPTION 'no eligible learner participants; cannot start' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.game_sessions SET status = 'started', started_at = now() WHERE id = v_s.id AND status = 'waiting';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_startable', 'session_id', v_s.id);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', player_id, 'name', name, 'emoji', emoji,
                    'team_id', team_id, 'team_name', team_name, 'status', status) ORDER BY name, player_id)
    INTO v_roster FROM public.game_roster_members WHERE session_id = v_s.id;
  RETURN jsonb_build_object('ok', true, 'session_id', v_s.id, 'roster', COALESCE(v_roster,'[]'::jsonb));
END;
$function$;

-- ══ PART 4 — PHASE RPC superset (081) + server-stamp question start ══════════════
-- Carries 081's scoreboard-invalidation behavior; additionally stamps a SERVER
-- current_question_started_at when entering a 'question' phase (trustworthy deadline base).
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL THEN RAISE EXCEPTION 'session id required' USING ERRCODE = 'no_data_found'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.status IN ('completed', 'canceled', 'ended') THEN
    RAISE EXCEPTION 'session not mutable (status=%)', v_s.status USING ERRCODE = 'check_violation';
  END IF;
  UPDATE public.game_sessions SET
    phase = p_phase,
    current_question_index = CASE WHEN p_set_cqi    THEN p_cqi           ELSE current_question_index END,
    paused                 = CASE WHEN p_set_paused THEN p_paused        ELSE paused END,
    live_question          = CASE WHEN p_set_live   THEN p_live_question ELSE live_question END,
    live_scoreboard        = CASE WHEN p_phase <> 'scoreboard' THEN NULL ELSE live_scoreboard END,
    scoreboard_version     = CASE WHEN p_phase <> 'scoreboard' AND live_scoreboard IS NOT NULL
                                  THEN scoreboard_version + 1 ELSE scoreboard_version END,
    -- 084: server-stamp the question-start whenever a NEW question phase begins (cqi set to this q).
    current_question_started_at = CASE WHEN p_phase = 'question' THEN now() ELSE current_question_started_at END
  WHERE id = v_s.id;
  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ══ PART 5 — DURABLE ANSWER SUBMISSION (learner, server-authoritative) ═══════════
-- player_id = auth.uid() (NEVER client-supplied). Requires canonical roster membership + started
-- session + answerable phase + exact current question. Validates SHAPE against the frozen snapshot
-- (never correctness). First write locks; identical retry is idempotent; a conflicting different
-- answer is rejected. Records server submitted_at. Enforces the durable deadline + fixed grace.
CREATE OR REPLACE FUNCTION public.rpc_submit_game_answer(p_session_id uuid, p_question_idx integer, p_answer jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_s public.game_sessions;
  v_qtype text;
  v_limit int;
  v_deadline timestamptz;
  v_grace interval := interval '2 seconds';        -- fixed network grace (explicit, tested)
  v_opt int; v_txt text; v_num numeric; v_json jsonb;
  v_existing public.game_answer_submissions%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  IF p_session_id IS NULL OR p_question_idx IS NULL THEN RAISE EXCEPTION 'session id and question index required' USING ERRCODE = 'no_data_found'; END IF;

  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id FOR UPDATE;   -- same lock order as reveal
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;

  -- Canonical membership (active) — the ONLY way to be scored; forged ids impossible (uid is server).
  IF NOT EXISTS (SELECT 1 FROM public.game_roster_members r
                 WHERE r.session_id = v_s.id AND r.player_id = v_uid::text AND r.status = 'active') THEN
    RAISE EXCEPTION 'not a canonical participant of this session' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.status <> 'started' THEN RAISE EXCEPTION 'session not accepting answers (status=%)', v_s.status USING ERRCODE = 'check_violation'; END IF;
  IF v_s.phase IS DISTINCT FROM 'question' THEN RAISE EXCEPTION 'not in an answerable phase (phase=%)', v_s.phase USING ERRCODE = 'check_violation'; END IF;
  IF p_question_idx IS DISTINCT FROM v_s.current_question_index THEN
    RAISE EXCEPTION 'stale or future question (submitted=%, current=%)', p_question_idx, v_s.current_question_index USING ERRCODE = 'check_violation';
  END IF;

  -- Question type from the FROZEN snapshot (shape only; correctness never read).
  v_qtype := v_s.question_snapshot -> p_question_idx ->> 'type';
  IF v_qtype IS NULL THEN RAISE EXCEPTION 'no snapshot question at index %', p_question_idx USING ERRCODE = 'check_violation'; END IF;
  v_limit := COALESCE((v_s.question_snapshot -> p_question_idx ->> 'timeLimit')::int, 20);

  -- Durable deadline (server question-start + limit + grace). Legacy null start → skip (accept).
  IF v_s.current_question_started_at IS NOT NULL THEN
    v_deadline := v_s.current_question_started_at + make_interval(secs => v_limit) + v_grace;
    IF now() > v_deadline THEN RAISE EXCEPTION 'answer past deadline' USING ERRCODE = 'check_violation'; END IF;
  END IF;

  -- Shape validation per type (NO correctness). Normalize into typed columns.
  IF v_qtype IN ('mc','tf') THEN
    IF jsonb_typeof(p_answer->'option_idx') <> 'number' THEN RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
    v_opt := (p_answer->>'option_idx')::int;
    IF v_opt < 0 OR v_opt >= COALESCE(jsonb_array_length(v_s.question_snapshot -> p_question_idx -> 'options'), 2) THEN
      RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
  ELSIF v_qtype = 'slider' THEN
    IF jsonb_typeof(p_answer->'value') <> 'number' THEN RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
    v_num := (p_answer->>'value')::numeric;   -- 0 preserved (typeof number check, not truthiness)
  ELSIF v_qtype IN ('type','open') THEN
    IF jsonb_typeof(p_answer->'text') <> 'string' THEN RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
    v_txt := left(p_answer->>'text', 2000);
  ELSIF v_qtype = 'match' THEN
    IF jsonb_typeof(p_answer->'pairs') <> 'array' THEN RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
    -- every element {leftIdx,rightIdx} integer & in range; no duplicate left or right.
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_answer->'pairs') e
               WHERE jsonb_typeof(e->'leftIdx') <> 'number' OR jsonb_typeof(e->'rightIdx') <> 'number'
                  OR (e->>'leftIdx')::int < 0 OR (e->>'rightIdx')::int < 0
                  OR (e->>'leftIdx')::int >= COALESCE(jsonb_array_length(v_s.question_snapshot -> p_question_idx -> 'pairs'), 0)
                  OR (e->>'rightIdx')::int >= COALESCE(jsonb_array_length(v_s.question_snapshot -> p_question_idx -> 'pairs'), 0))
       OR (SELECT count(*) FROM jsonb_array_elements(p_answer->'pairs') e) <>
          (SELECT count(DISTINCT (e->>'leftIdx')) FROM jsonb_array_elements(p_answer->'pairs') e)
       OR (SELECT count(*) FROM jsonb_array_elements(p_answer->'pairs') e) <>
          (SELECT count(DISTINCT (e->>'rightIdx')) FROM jsonb_array_elements(p_answer->'pairs') e) THEN
      RAISE EXCEPTION 'invalid answer' USING ERRCODE = 'check_violation'; END IF;
    v_json := p_answer->'pairs';
  ELSE
    RAISE EXCEPTION 'unsupported question type' USING ERRCODE = 'check_violation';
  END IF;

  -- First-write lock + idempotency: try insert; on conflict, compare to the stored submission.
  BEGIN
    INSERT INTO public.game_answer_submissions
      (session_id, tenant_id, player_id, question_idx, q_type, option_idx, answer_text, numeric_value, answer_json)
    VALUES (v_s.id, v_s.tenant_id, v_uid::text, p_question_idx, v_qtype, v_opt, v_txt, v_num, v_json);
    RETURN jsonb_build_object('ok', true, 'idempotent', false, 'question_idx', p_question_idx);
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing FROM public.game_answer_submissions
      WHERE session_id = v_s.id AND player_id = v_uid::text AND question_idx = p_question_idx;
    IF v_existing.option_idx IS NOT DISTINCT FROM v_opt
       AND v_existing.answer_text IS NOT DISTINCT FROM v_txt
       AND v_existing.numeric_value IS NOT DISTINCT FROM v_num
       AND v_existing.answer_json IS NOT DISTINCT FROM v_json THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true, 'question_idx', p_question_idx);  -- identical retry
    END IF;
    RAISE EXCEPTION 'answer already locked for this question' USING ERRCODE = 'unique_violation';   -- conflicting change
  END;
END;
$function$;

-- ══ PART 6 — ATOMIC REVEAL BOUNDARY (host) ══════════════════════════════════════
-- One locked transaction (same lock order as submission): authorize, confirm phase/question,
-- transition to 'reveal' (closing submissions for this qidx), and RETURN the canonical roster +
-- durable submissions + timing so the host grades with the shared JS grader. Deterministic race:
-- a submission that commits before this lock is included; one arriving after is rejected as stale
-- (phase is now 'reveal' / cqi advanced). Idempotent if already in reveal for this qidx.
CREATE OR REPLACE FUNCTION public.rpc_begin_question_reveal(p_session_id uuid, p_question_idx integer)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_roster jsonb; v_subs jsonb;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id FOR UPDATE;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_s.status <> 'started' THEN RAISE EXCEPTION 'session not live (status=%)', v_s.status USING ERRCODE = 'check_violation'; END IF;
  IF p_question_idx IS DISTINCT FROM v_s.current_question_index THEN
    RAISE EXCEPTION 'reveal for wrong question (asked=%, current=%)', p_question_idx, v_s.current_question_index USING ERRCODE = 'check_violation';
  END IF;
  -- Close submissions: move to reveal (idempotent if already there for this qidx).
  IF v_s.phase IS DISTINCT FROM 'reveal' THEN
    UPDATE public.game_sessions SET phase = 'reveal' WHERE id = v_s.id;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', player_id, 'name', name, 'emoji', emoji,
                    'team_id', team_id, 'team_name', team_name, 'status', status) ORDER BY name, player_id)
    INTO v_roster FROM public.game_roster_members WHERE session_id = v_s.id;
  SELECT jsonb_agg(jsonb_build_object(
           'player_id', player_id, 'question_idx', question_idx, 'q_type', q_type,
           'option_idx', option_idx, 'text', answer_text, 'numeric_value', numeric_value,
           'answer_json', answer_json, 'submitted_at', submitted_at))
    INTO v_subs FROM public.game_answer_submissions
    WHERE session_id = v_s.id AND question_idx = p_question_idx;

  RETURN jsonb_build_object(
    'ok', true, 'session_id', v_s.id, 'question_idx', p_question_idx,
    'question_started_at', v_s.current_question_started_at,
    'roster', COALESCE(v_roster,'[]'::jsonb), 'submissions', COALESCE(v_subs,'[]'::jsonb));
END;
$function$;

-- ══ PART 7 — HOST GAME-STATE READ (roster + current-question submissions) for host refresh ══
CREATE OR REPLACE FUNCTION public.rpc_host_game_state(p_session_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_s public.game_sessions; v_roster jsonb; v_subs jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT jsonb_agg(jsonb_build_object('id', player_id, 'name', name, 'emoji', emoji,
                    'team_id', team_id, 'team_name', team_name, 'status', status) ORDER BY name, player_id)
    INTO v_roster FROM public.game_roster_members WHERE session_id = v_s.id;
  SELECT jsonb_agg(jsonb_build_object('player_id', player_id, 'question_idx', question_idx, 'q_type', q_type,
           'option_idx', option_idx, 'text', answer_text, 'numeric_value', numeric_value, 'answer_json', answer_json))
    INTO v_subs FROM public.game_answer_submissions
    WHERE session_id = v_s.id AND question_idx = v_s.current_question_index;
  RETURN jsonb_build_object('roster', COALESCE(v_roster,'[]'::jsonb),
                            'current_question_index', v_s.current_question_index,
                            'submissions', COALESCE(v_subs,'[]'::jsonb));
END;
$function$;

-- ══ PART 8 — AUTO-REVEAL COUNT (server-derived accepted submissions vs active roster) ══
CREATE OR REPLACE FUNCTION public.rpc_answer_progress(p_session_id uuid, p_question_idx integer)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_s public.game_sessions; v_answered int; v_active int;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE = 'insufficient_privilege'; END IF;
  SELECT * INTO v_s FROM public.game_sessions WHERE id = p_session_id;
  IF v_s.id IS NULL THEN RAISE EXCEPTION 'session not found' USING ERRCODE = 'no_data_found'; END IF;
  IF NOT public.ralli_can_manage_session(v_s.host_id, v_s.tenant_id) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT count(*) INTO v_answered FROM public.game_answer_submissions
    WHERE session_id = v_s.id AND question_idx = p_question_idx;
  SELECT count(*) INTO v_active FROM public.game_roster_members
    WHERE session_id = v_s.id AND status = 'active';
  RETURN jsonb_build_object('answered', v_answered, 'active', v_active);
END;
$function$;

-- ── Grants: EXECUTE to authenticated (RPCs self-authorize); anon revoked. ─────────
REVOKE EXECUTE ON FUNCTION public.rpc_start_session(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_start_session(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_submit_game_answer(uuid, integer, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_submit_game_answer(uuid, integer, jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_begin_question_reveal(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_begin_question_reveal(uuid, integer) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_host_game_state(uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_host_game_state(uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_answer_progress(uuid, integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_answer_progress(uuid, integer) TO authenticated, service_role;

-- No DML/backfill: existing/historical sessions get no roster or submissions retroactively
-- (they cannot be reconstructed honestly). New games use the canonical roster + durable answers.
