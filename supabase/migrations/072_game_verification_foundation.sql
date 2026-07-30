-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 072: Ralli Live server-authoritative VERIFICATION FOUNDATION
--
-- Additive and production-safe. Touches ONLY Ralli Live (game_sessions +
-- two NEW verification tables + one writer RPC). Does NOT edit any prior
-- migration and does NOT change grading, scoring, pacing, reveal, or analytics.
--
-- WHY
--   Every trust-bearing game fact today (game_answers.is_correct/points,
--   game_players.final_score/final_rank) is computed in the host's browser and
--   written via PostgREST — client-authored, and (for game_answers/sessions)
--   client-MUTABLE. A leaderboard must rank only INDEPENDENTLY VERIFIED results.
--   This migration builds the trust substrate WITHOUT ranking anything yet:
--
--     1. SNAPSHOT INTEGRITY — freeze game_sessions.question_snapshot write-once
--        (set only while 'waiting', immutable thereafter) and bind a content
--        hash, so verification can prove it graded the exact questions played.
--     2. IMMUTABLE VERIFICATION STORAGE — append-only, service-role-only records
--        of independently-graded correctness + eligibility, separate from (never
--        overwriting) the client-authored gameplay fields.
--     3. ATOMIC IDEMPOTENT WRITER RPC — the ONLY write path, callable only by the
--        trusted verification service (service_role); grading itself is done by
--        the shared JS grader in the Edge Function (no SQL grader — single source).
--
--   The leaderboard read RPC + UI remain BLOCKED (see 071_LEADERBOARD_DESIGN.md).
--   No leaderboard ranks are computed or stored here.
--
-- GUARANTEES
--   - Snapshot exists before play (written at create, status 'waiting') and is
--     frozen once set; later client updates cannot rewrite historical questions.
--   - Verification records: append-only + immutable (UPDATE blocked by trigger);
--     ordinary anon/authenticated clients cannot INSERT/UPDATE/DELETE them.
--   - Only service_role (the verification service) can write, atomically, via the
--     RPC; repeated verification is idempotent; partial failure rolls back whole.
--   - Missing snapshot → honest 'ineligible' (reason 'no_snapshot'); legacy
--     unsnapshotted sessions are NOT backfilled or guessed.
--   - Tenant is derived server-side; per-answer verdicts confined to one session.
--   - Client is_correct/points/final_score/final_rank stay as historical gameplay
--     fields and are never read as leaderboard truth.
--   - Response speed (time_ms) is client-authored (no server receipt timestamp);
--     NO verified speed is stored here (see 071 design doc §Response-time).
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PART 1 — SNAPSHOT INTEGRITY (freeze + hash-bind) ═════════════════════════════

ALTER TABLE public.game_sessions
  ADD COLUMN IF NOT EXISTS question_snapshot_hash      text,
  ADD COLUMN IF NOT EXISTS question_snapshot_frozen_at timestamptz;

COMMENT ON COLUMN public.game_sessions.question_snapshot_hash IS
  'md5 content fingerprint of question_snapshot, stamped server-side when the snapshot is first set (072). Verification binds to this exact hash. Immutable once set.';
COMMENT ON COLUMN public.game_sessions.question_snapshot_frozen_at IS
  'Server timestamp when question_snapshot was frozen (first set, while status=waiting) (072).';

-- BEFORE INSERT/UPDATE freeze trigger. Enforces write-once immutability of the
-- question snapshot and owns the hash/frozen_at columns (client values ignored).
-- Deliberately does NOT touch live_question, phase, paused, status, ended_at, or
-- any other column — phase recovery / pause-resume / analytics are unaffected.
CREATE OR REPLACE FUNCTION public.game_sessions_freeze_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.question_snapshot IS NOT NULL THEN
      -- A snapshot present at insert is frozen immediately.
      NEW.question_snapshot_hash      := md5(NEW.question_snapshot::text);
      NEW.question_snapshot_frozen_at := now();
    ELSE
      NEW.question_snapshot_hash      := NULL;
      NEW.question_snapshot_frozen_at := NULL;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.question_snapshot IS NULL AND NEW.question_snapshot IS NOT NULL THEN
    -- First (and only) set is allowed ONLY before the game is startable/joinable-
    -- past-waiting. This is exactly the create-time write (status still 'waiting');
    -- a snapshot can never be retro-attached to a started/completed/legacy session.
    IF NEW.status IS DISTINCT FROM 'waiting' THEN
      RAISE EXCEPTION 'question_snapshot can only be set while the session is waiting (status=%).', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    NEW.question_snapshot_hash      := md5(NEW.question_snapshot::text);
    NEW.question_snapshot_frozen_at := now();
    RETURN NEW;
  END IF;

  IF NEW.question_snapshot IS DISTINCT FROM OLD.question_snapshot THEN
    -- Any later change (rewrite OR clearing to NULL) of an existing snapshot is
    -- forbidden — historical questions are immutable once frozen.
    RAISE EXCEPTION 'question_snapshot is immutable once set (session %).', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  -- Snapshot unchanged: preserve the server-owned hash/frozen_at regardless of
  -- any client-supplied values on this UPDATE.
  NEW.question_snapshot_hash      := OLD.question_snapshot_hash;
  NEW.question_snapshot_frozen_at := OLD.question_snapshot_frozen_at;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.game_sessions_freeze_snapshot() IS
  'BEFORE INSERT/UPDATE on game_sessions: question_snapshot is write-once (settable only while waiting), immutable thereafter; owns question_snapshot_hash/frozen_at (client values ignored). Other columns untouched (072).';

DROP TRIGGER IF EXISTS trg_game_sessions_freeze_snapshot ON public.game_sessions;
CREATE TRIGGER trg_game_sessions_freeze_snapshot
  BEFORE INSERT OR UPDATE ON public.game_sessions
  FOR EACH ROW EXECUTE FUNCTION public.game_sessions_freeze_snapshot();

-- Backfill the hash for the sessions that ALREADY carry a snapshot, so existing
-- verifiable sessions bind to a stored hash too. This sets ONLY the two new
-- (currently all-NULL) columns; it changes no gameplay data. It does not create
-- snapshots for legacy null-snapshot sessions (those stay honestly unverifiable).
-- Runs BEFORE-trigger safe: it only writes the hash/frozen_at, snapshot unchanged.
UPDATE public.game_sessions
   SET question_snapshot_hash      = md5(question_snapshot::text),
       question_snapshot_frozen_at = COALESCE(question_snapshot_frozen_at, ended_at, created_at)
 WHERE question_snapshot IS NOT NULL
   AND question_snapshot_hash IS NULL;

-- ══ PART 2 — IMMUTABLE VERIFICATION STORAGE ═════════════════════════════════════

-- Session-level verification status (one canonical, durable row per verified
-- session). Append-only; no calculated leaderboard rank is ever stored.
CREATE TABLE IF NOT EXISTS public.game_session_verifications (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               uuid NOT NULL UNIQUE REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  tenant_id                text,                              -- server-derived from the session
  status                   text NOT NULL CHECK (status IN ('complete','ineligible')),
  reason                   text,                              -- null for 'complete'; honest reason otherwise
  grader_version           text NOT NULL,                     -- ruleset that produced the verdicts
  snapshot_hash            text,                              -- frozen question_snapshot hash bound at verify time
  question_count           integer,
  verified_scored_answers  integer NOT NULL DEFAULT 0,        -- rows with eligibility='scored'
  eligible_participant_count integer NOT NULL DEFAULT 0,      -- distinct active same-tenant learners w/ >=1 scored answer
  verification_source      text NOT NULL,                     -- e.g. 'edge:verify-game-session'
  verified_at              timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.game_session_verifications IS
  'Durable, append-only, service-role-only per-session verification status (072). Never stores leaderboard rank. Client gameplay fields remain the source of gameplay display, never leaderboard truth.';

-- Per-answer immutable verified verdicts (only for 'complete' sessions).
CREATE TABLE IF NOT EXISTS public.game_answer_verifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  verification_id     uuid NOT NULL REFERENCES public.game_session_verifications(id) ON DELETE CASCADE,
  session_id          uuid NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  answer_id           uuid REFERENCES public.game_answers(id) ON DELETE SET NULL,
  tenant_id           text,
  player_id           text NOT NULL,
  question_idx        integer NOT NULL,
  question_stable_id  text,                                   -- q.id from the frozen snapshot
  verified_correct    boolean,                                -- null when not auto-verifiable (open/unsupported/skipped)
  eligibility         text NOT NULL,                          -- scored|unanswered|skipped|open_manual|unsupported|malformed
  reason              text,
  grader_version      text NOT NULL,
  snapshot_hash       text NOT NULL,
  verification_method text NOT NULL DEFAULT 'auto',           -- auto|manual
  manual_grader_id    uuid,                                   -- profile id when a manual grade supplied the verdict
  verified_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_answer_verif_session_q_player UNIQUE (session_id, question_idx, player_id)
);

COMMENT ON TABLE public.game_answer_verifications IS
  'Immutable, append-only, service-role-only per-answer verified correctness + eligibility (072). Independently graded by the shared JS grader; client is_correct/points are never read. Speed is intentionally absent (client time_ms is unverified).';

CREATE INDEX IF NOT EXISTS idx_gsv_tenant_status ON public.game_session_verifications(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_gav_session      ON public.game_answer_verifications(session_id);
CREATE INDEX IF NOT EXISTS idx_gav_verification ON public.game_answer_verifications(verification_id);
CREATE INDEX IF NOT EXISTS idx_gav_player       ON public.game_answer_verifications(player_id);

-- ── Immutability: block ALL updates (content is append-only truth) ───────────────
CREATE OR REPLACE FUNCTION public.game_verifications_block_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION 'verification records are immutable (append-only); UPDATE is not permitted';
END;
$$;

COMMENT ON FUNCTION public.game_verifications_block_update() IS
  'BEFORE UPDATE guard making verification records immutable — no role may mutate a recorded verdict (072).';

DROP TRIGGER IF EXISTS trg_gsv_block_update ON public.game_session_verifications;
CREATE TRIGGER trg_gsv_block_update
  BEFORE UPDATE ON public.game_session_verifications
  FOR EACH ROW EXECUTE FUNCTION public.game_verifications_block_update();

DROP TRIGGER IF EXISTS trg_gav_block_update ON public.game_answer_verifications;
CREATE TRIGGER trg_gav_block_update
  BEFORE UPDATE ON public.game_answer_verifications
  FOR EACH ROW EXECUTE FUNCTION public.game_verifications_block_update();

-- ── RLS + grants: authenticated same-tenant READ only; NO client writes ─────────
ALTER TABLE public.game_session_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.game_answer_verifications  ENABLE ROW LEVEL SECURITY;

-- Read (authenticated, same tenant). No anon read (verification is tenant data).
-- No INSERT/UPDATE/DELETE policy for anon/authenticated at all → only service_role
-- (which bypasses RLS) and the SECURITY DEFINER writer RPC can write.
DROP POLICY IF EXISTS gsv_tenant_read ON public.game_session_verifications;
CREATE POLICY gsv_tenant_read ON public.game_session_verifications
  FOR SELECT TO authenticated
  USING (tenant_id = (public.get_my_tenant_id())::text);

DROP POLICY IF EXISTS gav_tenant_read ON public.game_answer_verifications;
CREATE POLICY gav_tenant_read ON public.game_answer_verifications
  FOR SELECT TO authenticated
  USING (tenant_id = (public.get_my_tenant_id())::text);

-- Grants: read to authenticated (RLS-scoped); NO write to anon/authenticated.
REVOKE ALL   ON public.game_session_verifications FROM anon, authenticated;
REVOKE ALL   ON public.game_answer_verifications  FROM anon, authenticated;
GRANT  SELECT ON public.game_session_verifications TO authenticated;
GRANT  SELECT ON public.game_answer_verifications  TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_session_verifications TO service_role;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_answer_verifications  TO service_role;

-- ══ PART 3 — ATOMIC, IDEMPOTENT WRITER RPC (service_role only) ═══════════════════
-- The single write path. Grading is NOT done here (no SQL grader): the trusted
-- Edge Function grades with the shared JS grader and passes per-answer verdicts.
-- This RPC re-derives tenant server-side, binds the frozen snapshot hash,
-- confines verdicts to this one session, and writes everything in one
-- transaction (all-or-nothing → a partial failure never leaves a session
-- appearing verified). Idempotent: a second call is a no-op returning the
-- existing status.
CREATE OR REPLACE FUNCTION public.record_game_verification(
  p_session_id     uuid,
  p_grader_version text,
  p_source         text,
  p_verdicts       jsonb   -- [] of {answer_id?, player_id, question_idx, question_stable_id?, verified_correct?, eligibility, reason?, verification_method?, manual_grader_id?}
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_session   public.game_sessions%ROWTYPE;
  v_existing  public.game_session_verifications%ROWTYPE;
  v_hash      text;
  v_verif_id  uuid;
  v_bad       integer;
  v_scored    integer;
  v_participants integer;
  v_qcount    integer;
BEGIN
  IF p_session_id IS NULL THEN
    RAISE EXCEPTION 'record_game_verification: session id required';
  END IF;

  -- Serialize concurrent verifications of the same session.
  SELECT * INTO v_session FROM public.game_sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'record_game_verification: session % not found', p_session_id;
  END IF;

  -- Idempotent: a terminal verification already exists → return it unchanged.
  SELECT * INTO v_existing FROM public.game_session_verifications WHERE session_id = p_session_id;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'status', v_existing.status, 'reason', v_existing.reason,
      'session_id', v_existing.session_id, 'idempotent', true,
      'grader_version', v_existing.grader_version,
      'verified_scored_answers', v_existing.verified_scored_answers,
      'eligible_participant_count', v_existing.eligible_participant_count);
  END IF;

  -- Only real, durably-completed sessions are verifiable. Not-completed / demo is
  -- a transient/ineligible caller error — raise so the caller can retry or stop.
  IF v_session.demo_mode IS TRUE THEN
    RAISE EXCEPTION 'record_game_verification: demo session % is not verifiable', p_session_id;
  END IF;
  IF v_session.status IS DISTINCT FROM 'completed' THEN
    RAISE EXCEPTION 'record_game_verification: session % is not completed (status=%)', p_session_id, v_session.status;
  END IF;

  -- Missing snapshot → honest, durable ineligible. Never guessed, never backfilled.
  IF v_session.question_snapshot IS NULL THEN
    INSERT INTO public.game_session_verifications
      (session_id, tenant_id, status, reason, grader_version, snapshot_hash,
       question_count, verified_scored_answers, eligible_participant_count, verification_source)
    VALUES
      (p_session_id, v_session.tenant_id, 'ineligible', 'no_snapshot', p_grader_version, NULL,
       NULL, 0, 0, p_source);
    RETURN jsonb_build_object('status','ineligible','reason','no_snapshot','session_id',p_session_id,'idempotent',false);
  END IF;

  -- Bind the frozen snapshot hash. If a stored (frozen) hash exists and disagrees
  -- with the current content, the snapshot changed under us → integrity error.
  v_hash := md5(v_session.question_snapshot::text);
  IF v_session.question_snapshot_hash IS NOT NULL
     AND v_session.question_snapshot_hash IS DISTINCT FROM v_hash THEN
    RAISE EXCEPTION 'record_game_verification: snapshot hash mismatch for session % (frozen=%, now=%)',
      p_session_id, v_session.question_snapshot_hash, v_hash;
  END IF;
  v_qcount := jsonb_array_length(COALESCE(v_session.question_snapshot, '[]'::jsonb));

  -- Confine verdicts to THIS session: any verdict referencing an answer_id that
  -- is not a game_answers row of this session is a cross-session integrity error.
  SELECT count(*) INTO v_bad
  FROM jsonb_array_elements(COALESCE(p_verdicts, '[]'::jsonb)) e
  WHERE (e->>'answer_id') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.game_answers ga
      WHERE ga.id = (e->>'answer_id')::uuid AND ga.session_id = p_session_id);
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'record_game_verification: % verdict(s) reference answers outside session %', v_bad, p_session_id;
  END IF;

  -- Counts (NOT ranks) computed from the verdicts BEFORE any insert, so the
  -- append-only session row is written once with its final values (the
  -- immutability trigger forbids a later UPDATE):
  --   verified_scored_answers   = verdicts with eligibility 'scored'
  --   eligible_participant_count = distinct players with a scored verdict who are
  --                                ACTIVE same-tenant LEARNERS (role 'user')
  SELECT count(*) FILTER (WHERE e->>'eligibility' = 'scored')
    INTO v_scored
  FROM jsonb_array_elements(COALESCE(p_verdicts, '[]'::jsonb)) e;

  SELECT count(DISTINCT e->>'player_id') INTO v_participants
  FROM jsonb_array_elements(COALESCE(p_verdicts, '[]'::jsonb)) e
  WHERE e->>'eligibility' = 'scored'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id::text = e->>'player_id'
        AND p.tenant_id::text = v_session.tenant_id
        AND p.role = 'user'
        AND p.status = 'active');

  -- Session-level row, written once with final counts (same transaction as the
  -- per-answer rows → all-or-nothing; a partial failure verifies nothing).
  INSERT INTO public.game_session_verifications
    (session_id, tenant_id, status, reason, grader_version, snapshot_hash,
     question_count, verified_scored_answers, eligible_participant_count, verification_source)
  VALUES
    (p_session_id, v_session.tenant_id, 'complete', NULL, p_grader_version, v_hash,
     v_qcount, COALESCE(v_scored,0), COALESCE(v_participants,0), p_source)
  RETURNING id INTO v_verif_id;

  -- Immutable per-answer verdicts. Tenant is server-derived (session).
  INSERT INTO public.game_answer_verifications
    (verification_id, session_id, answer_id, tenant_id, player_id, question_idx,
     question_stable_id, verified_correct, eligibility, reason, grader_version,
     snapshot_hash, verification_method, manual_grader_id)
  SELECT
    v_verif_id, p_session_id,
    NULLIF(e->>'answer_id','')::uuid, v_session.tenant_id,
    e->>'player_id',
    (e->>'question_idx')::int,
    e->>'question_stable_id',
    CASE WHEN e ? 'verified_correct' AND jsonb_typeof(e->'verified_correct')='boolean'
         THEN (e->>'verified_correct')::boolean ELSE NULL END,
    e->>'eligibility',
    e->>'reason',
    p_grader_version,
    v_hash,
    COALESCE(NULLIF(e->>'verification_method',''),'auto'),
    NULLIF(e->>'manual_grader_id','')::uuid
  FROM jsonb_array_elements(COALESCE(p_verdicts, '[]'::jsonb)) e;

  RETURN jsonb_build_object(
    'status','complete','session_id',p_session_id,'idempotent',false,
    'grader_version',p_grader_version,'snapshot_hash',v_hash,
    'question_count',v_qcount,'verified_scored_answers',COALESCE(v_scored,0),
    'eligible_participant_count',COALESCE(v_participants,0));
END;
$$;

COMMENT ON FUNCTION public.record_game_verification(uuid, text, text, jsonb) IS
  'Atomic, idempotent, service-role-only writer for Ralli Live verification (072). Grading is done by the shared JS grader in the Edge Function; this persists verdicts, derives tenant server-side, binds the frozen snapshot hash, confines verdicts to one session, and writes session+answer rows in one transaction. Idempotent no-op if already verified. Never computes leaderboard rank.';

-- Only the trusted verification service (service_role) may write verification
-- truth. Ordinary clients cannot execute this RPC (and cannot write the tables).
REVOKE ALL ON FUNCTION public.record_game_verification(uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_game_verification(uuid, text, text, jsonb) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (read-only):
--   \d+ public.game_sessions  → question_snapshot_hash, question_snapshot_frozen_at
--   \d+ public.game_session_verifications ; \d+ public.game_answer_verifications
--   SELECT proname, prosecdef FROM pg_proc WHERE proname='record_game_verification';
-- Leaderboard read RPC + UI remain deferred (071 design doc). No ranks stored.
-- ─────────────────────────────────────────────────────────────────────────────
