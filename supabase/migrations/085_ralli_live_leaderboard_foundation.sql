-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 085: Ralli Live LEADERBOARD FOUNDATION (prospective, server-authoritative)
--
-- Builds the durable substrate for a Ralli-Live-only organization/team/individual
-- leaderboard, ranked by CONFIDENCE-ADJUSTED VERIFIED ACCURACY. Additive + forward-only.
-- Does NOT modify migration 084 (that file is byte-identical). Supersedes only
-- rpc_set_session_phase to ALSO record per-question EXPOSURE (a faithful superset).
--
-- Contract (approved):
--   adjusted_accuracy = (verified_correct + 20 * tenant_mean_accuracy) / (eligible_questions_faced + 20)
--   • verified_correct        — authoritative game_answer_verifications (072) only.
--   • eligible_questions_faced — game_question_exposures rows only (this migration), minus
--                                open-ended questions still PENDING a manual verdict.
--   • Ranked only when faced >= 20 across >= 3 completed real games in the timeframe; else rank NULL.
--   • Speed is NOT in the primary score: it is a tie-break (after adjusted accuracy @ 4dp) and powers
--     "Fast and Accurate" only; correct answers only; server-derived (submitted_at - exposed_at) / limit.
--   • Legacy (pre-exposure) sessions are excluded from ranking (never backfilled/inferred).
--   • Teams use the migration-084 immutable roster team snapshot; median of eligible members' adjusted
--     accuracy; >=2 eligible AND >=50% of active learners eligible.
--   • Managers/orgAdmins/ralli_admins/anonymous/suspended/inactive excluded from rankings (records kept).
-- ─────────────────────────────────────────────────────────────────────────────

-- ══ PART 1 — PER-QUESTION EXPOSURE (immutable, server-authoritative) ═════════════
-- One row proves: this canonical player was durably active for this session when this
-- specific question began. Denominator source of truth.
CREATE TABLE IF NOT EXISTS public.game_question_exposures (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    uuid NOT NULL REFERENCES public.game_sessions(id) ON DELETE CASCADE,
  tenant_id     text NOT NULL,
  player_id     text NOT NULL,                 -- canonical roster player (= profiles.id / auth.uid)
  question_idx  integer NOT NULL,
  question_id   text,                          -- immutable snapshot question id, when available (integrity guard)
  exposed_at    timestamptz NOT NULL,          -- server question-start time (durable per-question start)
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_exposure_session_player_q UNIQUE (session_id, player_id, question_idx)
);
COMMENT ON TABLE public.game_question_exposures IS
  'Immutable per-question exposure (085): one row per canonical roster member DURABLY ACTIVE at a question start. The leaderboard denominator (eligible_questions_faced). Never derived from final roster status; never backfilled for pre-085 sessions.';
CREATE INDEX IF NOT EXISTS idx_exposure_session ON public.game_question_exposures(session_id);
CREATE INDEX IF NOT EXISTS idx_exposure_player  ON public.game_question_exposures(player_id);
CREATE INDEX IF NOT EXISTS idx_exposure_tenant  ON public.game_question_exposures(tenant_id);
CREATE INDEX IF NOT EXISTS idx_exposure_sess_player_q ON public.game_question_exposures(session_id, player_id, question_idx);

-- Immutable: block ALL client UPDATE/DELETE (append-only truth).
CREATE OR REPLACE FUNCTION public.game_exposure_block_mutation()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RAISE EXCEPTION 'game_question_exposures is append-only; UPDATE/DELETE not permitted';
END; $$;
DROP TRIGGER IF EXISTS trg_exposure_block ON public.game_question_exposures;
CREATE TRIGGER trg_exposure_block BEFORE UPDATE OR DELETE ON public.game_question_exposures
  FOR EACH ROW EXECUTE FUNCTION public.game_exposure_block_mutation();

ALTER TABLE public.game_question_exposures ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS exposure_tenant_read ON public.game_question_exposures;
CREATE POLICY exposure_tenant_read ON public.game_question_exposures
  FOR SELECT TO authenticated USING (tenant_id = (public.get_my_tenant_id())::text);
REVOKE ALL ON public.game_question_exposures FROM anon, authenticated;
GRANT  SELECT ON public.game_question_exposures TO authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_question_exposures TO service_role;

-- Documented freshness threshold — reuses the established Ralli Live 40s heartbeat/stale contract.
CREATE OR REPLACE FUNCTION public.ralli_heartbeat_fresh_window()
RETURNS interval LANGUAGE sql IMMUTABLE SET search_path = '' AS $$ SELECT interval '40 seconds' $$;

-- ══ PART 2 — SUPERSEDE rpc_set_session_phase: record exposure at question start ═══
-- Faithful superset of the 084 body. ADDITIONALLY, on the authoritative transition INTO a
-- 'question' phase, insert one exposure row per DURABLY-ACTIVE canonical roster member for the
-- exact question index being started. Idempotent (ON CONFLICT DO NOTHING); never removes rows;
-- never derives from final status. Durably active = canonical roster status='active' AND the
-- participant row is not left/completed AND its heartbeat is fresh (<= 40s). Explicit Leave /
-- stale / rejoin-after are all handled by this point-in-time snapshot.
CREATE OR REPLACE FUNCTION public.rpc_set_session_phase(p_session_id uuid, p_phase text, p_set_cqi boolean, p_cqi integer, p_set_paused boolean, p_paused boolean, p_set_live boolean, p_live_question jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE v_uid uuid := auth.uid(); v_s public.game_sessions; v_qidx int; v_qid text;
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
    current_question_started_at = CASE WHEN p_phase = 'question' THEN now() ELSE current_question_started_at END
  WHERE id = v_s.id;

  -- 085: durable per-question EXPOSURE snapshot at question start (only for a real, started session).
  IF p_phase = 'question' AND v_s.demo_mode = false AND v_s.status = 'started' THEN
    v_qidx := CASE WHEN p_set_cqi THEN p_cqi ELSE v_s.current_question_index END;
    v_qid  := v_s.question_snapshot -> v_qidx ->> 'id';
    INSERT INTO public.game_question_exposures (session_id, tenant_id, player_id, question_idx, question_id, exposed_at)
    SELECT v_s.id, v_s.tenant_id, r.player_id, v_qidx, v_qid, now()
    FROM public.game_roster_members r
    JOIN public.game_session_participants gsp
      ON gsp.session_id = v_s.id AND gsp.player_id = r.player_id
    WHERE r.session_id = v_s.id
      AND r.status = 'active'                                   -- canonical membership, not left
      AND gsp.status IN ('active','joined')                    -- not explicitly left/completed
      AND gsp.last_seen_at IS NOT NULL
      AND (now() - gsp.last_seen_at) <= public.ralli_heartbeat_fresh_window()  -- durable heartbeat fresh
    ON CONFLICT (session_id, player_id, question_idx) DO NOTHING;             -- idempotent, immutable
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

-- ══ PART 3 — ORGANIZATION TIMEZONE (tenant-owned) ════════════════════════════════
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'UTC';
COMMENT ON COLUMN public.tenants.timezone IS
  'IANA timezone for this org (085). Calendar leaderboard boundaries are computed in it. Default UTC when unset. Changing it changes future query boundaries only — never stored session timestamps.';

-- Read the caller''s org timezone (authenticated same-tenant).
CREATE OR REPLACE FUNCTION public.rpc_get_org_timezone()
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_tid uuid := public.get_my_tenant_id(); v_tz text;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_tid IS NULL THEN RETURN 'UTC'; END IF;
  SELECT COALESCE(timezone,'UTC') INTO v_tz FROM public.tenants WHERE id = v_tid;
  RETURN COALESCE(v_tz,'UTC');
END; $function$;

-- Update the org timezone — manager/orgAdmin only; validated against PostgreSQL IANA names.
CREATE OR REPLACE FUNCTION public.rpc_set_org_timezone(p_tz text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_tid uuid := public.get_my_tenant_id(); v_role text;
BEGIN
  IF v_uid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  IF v_tid IS NULL THEN RAISE EXCEPTION 'no tenant' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT role INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('orgAdmin','manager','ralli_admin') THEN
    RAISE EXCEPTION 'not authorized to change organization settings' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_tz IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_tz) THEN
    RAISE EXCEPTION 'invalid IANA timezone: %', p_tz USING ERRCODE='check_violation';
  END IF;
  UPDATE public.tenants SET timezone = p_tz, updated_at = now() WHERE id = v_tid;
  RETURN jsonb_build_object('ok', true, 'timezone', p_tz);
END; $function$;

-- ══ PART 4 — VERIFICATION OUTBOX/QUEUE (server-driven, retryable) ═════════════════
CREATE TABLE IF NOT EXISTS public.game_verification_queue (
  session_id      uuid PRIMARY KEY REFERENCES public.game_sessions(id) ON DELETE CASCADE,  -- one job per session
  tenant_id       text NOT NULL,
  state           text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','processing','completed','failed')),
  attempts        integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,                       -- short message only; NEVER answers/snapshots/secrets
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.game_verification_queue IS
  'Durable outbox (085): one job per completed real session, driving server-owned retryable invocation of verify-game-session. Idempotent by session_id. last_error carries NO answer/snapshot/secret material.';
CREATE INDEX IF NOT EXISTS idx_verif_queue_due ON public.game_verification_queue(state, next_attempt_at);
ALTER TABLE public.game_verification_queue ENABLE ROW LEVEL SECURITY;  -- no policies → only service_role/definer functions
REVOKE ALL ON public.game_verification_queue FROM anon, authenticated;
GRANT  SELECT, INSERT, UPDATE, DELETE ON public.game_verification_queue TO service_role;

-- Enqueue exactly once when a REAL session durably reaches 'completed'. Enqueue only (no outbound HTTP
-- from the trigger — a server-owned worker/sweep does the invocation).
CREATE OR REPLACE FUNCTION public.enqueue_session_verification()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.status = 'completed' AND (OLD.status IS DISTINCT FROM 'completed') AND NEW.demo_mode = false THEN
    INSERT INTO public.game_verification_queue (session_id, tenant_id, state, next_attempt_at)
    VALUES (NEW.id, NEW.tenant_id, 'pending', now())
    ON CONFLICT (session_id) DO NOTHING;   -- duplicate completion events never create duplicate work
  END IF;
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS trg_enqueue_verification ON public.game_sessions;
CREATE TRIGGER trg_enqueue_verification AFTER UPDATE OF status ON public.game_sessions
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_session_verification();

-- Worker claim: service_role only. Atomically claim the next due pending job (skip-locked) and mark processing.
CREATE OR REPLACE FUNCTION public.rpc_claim_verification_job()
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_sid uuid; v_tid text; v_att int;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::json->>'role') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE='insufficient_privilege';
  END IF;
  SELECT session_id, tenant_id, attempts INTO v_sid, v_tid, v_att
  FROM public.game_verification_queue
  WHERE state = 'pending' AND next_attempt_at <= now()
  ORDER BY next_attempt_at ASC
  FOR UPDATE SKIP LOCKED LIMIT 1;
  IF v_sid IS NULL THEN RETURN jsonb_build_object('claimed', false); END IF;
  UPDATE public.game_verification_queue
     SET state='processing', attempts = attempts + 1, updated_at = now()
   WHERE session_id = v_sid;
  RETURN jsonb_build_object('claimed', true, 'session_id', v_sid, 'tenant_id', v_tid, 'attempt', v_att + 1);
END; $function$;

-- Worker complete: mark terminal success or schedule an exponential-backoff retry (fail after 6 attempts).
CREATE OR REPLACE FUNCTION public.rpc_complete_verification_job(p_session_id uuid, p_ok boolean, p_error text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_att int;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL
     AND (current_setting('request.jwt.claims', true)::json->>'role') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE='insufficient_privilege';
  END IF;
  IF p_ok THEN
    UPDATE public.game_verification_queue SET state='completed', last_error=NULL, updated_at=now()
     WHERE session_id = p_session_id;
  ELSE
    SELECT attempts INTO v_att FROM public.game_verification_queue WHERE session_id = p_session_id;
    UPDATE public.game_verification_queue
       SET state = CASE WHEN v_att >= 6 THEN 'failed' ELSE 'pending' END,
           next_attempt_at = now() + make_interval(secs => LEAST(3600, power(2, v_att)::int * 30)),
           last_error = left(coalesce(p_error,''), 500),   -- short, no answer/snapshot material
           updated_at = now()
     WHERE session_id = p_session_id;
  END IF;
  RETURN jsonb_build_object('ok', true);
END; $function$;

-- ══ PART 5 — LEADERBOARD RPCs (aggregate-only, tenant/role-safe) ══════════════════
-- Shared eligibility semantics implemented ONCE here (never in React):
--   faced   = exposures in eligible sessions, EXCLUDING open questions still pending a manual verdict.
--   correct = game_answer_verifications.verified_correct = true for those exposed questions.
--   ranked  = faced >= 20 AND distinct eligible games >= 3 within [p_from, p_to).
--   adjusted_accuracy = (correct + 20*tenant_mean) / (faced + 20); tenant_mean over ranked-eligible
--                       learners in the window, or the neutral prior 0.5 when there is no baseline.

-- 5a. INDIVIDUALS. p_team_id optional filter (a learner may pass only their OWN team; managers any).
CREATE OR REPLACE FUNCTION public.rpc_ralli_leaderboard_individuals(p_from timestamptz, p_to timestamptz, p_team_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_tid uuid := public.get_my_tenant_id(); v_role text; v_my_team uuid;
BEGIN
  IF v_uid IS NULL OR v_tid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  SELECT role, team_id INTO v_role, v_my_team FROM public.profiles WHERE id = v_uid;
  -- Team scoping: a learner may only filter to their OWN team; managers/admins may filter any same-tenant team.
  IF p_team_id IS NOT NULL AND v_role NOT IN ('orgAdmin','manager','ralli_admin') AND p_team_id IS DISTINCT FROM v_my_team THEN
    RAISE EXCEPTION 'not authorized to view another team' USING ERRCODE='insufficient_privilege';
  END IF;

  RETURN (
  WITH elig_sessions AS (
    SELECT s.id FROM public.game_sessions s
    WHERE s.tenant_id = v_tid::text AND s.demo_mode = false AND s.status = 'completed'
      AND s.ended_at >= p_from AND s.ended_at < p_to
      AND EXISTS (SELECT 1 FROM public.game_question_exposures e WHERE e.session_id = s.id)
  ),
  faced_raw AS (
    SELECT e.player_id, e.session_id, e.question_idx, e.exposed_at,
           (SELECT gs.question_snapshot -> e.question_idx ->> 'type' FROM public.game_sessions gs WHERE gs.id = e.session_id) AS qtype,
           v.verified_correct
    FROM public.game_question_exposures e
    JOIN elig_sessions es ON es.id = e.session_id
    LEFT JOIN public.game_answer_verifications v
           ON v.session_id = e.session_id AND v.player_id = e.player_id AND v.question_idx = e.question_idx
  ),
  graded AS (  -- drop open-ended questions still pending a manual verdict (verified_correct IS NULL)
    SELECT * FROM faced_raw WHERE NOT (qtype = 'open' AND verified_correct IS NULL)
  ),
  spd AS (     -- median normalized correct-response time per learner (server-derived; valid only)
    SELECT g.player_id,
           percentile_cont(0.5) WITHIN GROUP (
             ORDER BY EXTRACT(EPOCH FROM (sub.submitted_at - g.exposed_at))
                      / NULLIF((SELECT COALESCE((gs.question_snapshot -> g.question_idx ->> 'timeLimit')::numeric,20) FROM public.game_sessions gs WHERE gs.id = g.session_id),0)
           ) AS median_norm_speed
    FROM graded g
    JOIN public.game_answer_submissions sub
      ON sub.session_id = g.session_id AND sub.player_id = g.player_id AND sub.question_idx = g.question_idx
    WHERE g.verified_correct IS TRUE
      AND sub.submitted_at >= g.exposed_at                                   -- non-negative
      AND EXTRACT(EPOCH FROM (sub.submitted_at - g.exposed_at))
          <= (SELECT COALESCE((gs.question_snapshot -> g.question_idx ->> 'timeLimit')::numeric,20) FROM public.game_sessions gs WHERE gs.id = g.session_id)  -- at/under limit
    GROUP BY g.player_id
  ),
  per_learner AS (
    SELECT g.player_id,
           count(*) AS faced,
           count(*) FILTER (WHERE g.verified_correct IS TRUE) AS correct,
           count(DISTINCT g.session_id) AS games,
           count(*) FILTER (WHERE g.session_id IN (SELECT session_id FROM public.game_roster_members)) AS faced_084,
           count(DISTINCT g.session_id) FILTER (WHERE g.session_id NOT IN (SELECT session_id FROM public.game_roster_members)) AS legacy_games
    FROM graded g GROUP BY g.player_id
  ),
  learners AS (
    SELECT pl.*, pr.name, pr.team_id, sp.median_norm_speed
    FROM per_learner pl
    JOIN public.profiles pr ON pr.id::text = pl.player_id
    LEFT JOIN spd sp ON sp.player_id = pl.player_id
    WHERE pr.role = 'user' AND pr.status = 'active' AND pr.tenant_id = v_tid
      AND (p_team_id IS NULL OR pr.team_id = p_team_id)
  ),
  eligible AS (SELECT * FROM learners WHERE faced >= 20 AND games >= 3),
  tmean AS (SELECT COALESCE(sum(correct)::numeric / NULLIF(sum(faced),0), 0.5) AS m FROM eligible),
  scored AS (
    SELECT l.*,
           (l.faced >= 20 AND l.games >= 3) AS enough,
           round(l.correct::numeric / NULLIF(l.faced,0), 4) AS raw_acc,
           round((l.correct + 20 * (SELECT m FROM tmean)) / (l.faced + 20), 6) AS adj_acc
    FROM learners l
  ),
  ranked AS (
    SELECT s.*,
      CASE WHEN s.enough THEN dense_rank() OVER (
        ORDER BY round(s.adj_acc,4) DESC, s.raw_acc DESC, s.faced DESC,
                 s.median_norm_speed ASC NULLS LAST, lower(s.name), s.player_id
      ) END AS rnk
    FROM scored s WHERE s.enough  -- dense_rank window only over ranked learners
  ),
  everyone AS (
    SELECT s.*, r.rnk FROM scored s LEFT JOIN ranked r USING (player_id)
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'player_id', player_id, 'name', name, 'team_id', team_id,
      'games', games, 'questions_faced', faced, 'verified_correct', correct,
      'raw_accuracy', raw_acc, 'adjusted_accuracy', adj_acc,
      'median_norm_speed', median_norm_speed,
      'enough_data', enough, 'rank', rnk,
      'games_084', faced_084, 'legacy_games', legacy_games,
      'questions_to_go', GREATEST(0, 20 - faced), 'games_to_go', GREATEST(0, 3 - games)
    ) ORDER BY (rnk IS NULL), rnk NULLS LAST, adj_acc DESC, lower(name)), '[]'::jsonb)
  FROM everyone);
END; $function$;

-- 5b. TEAMS. Median of eligible members' adjusted accuracy; >=2 eligible AND >=50% of active learners eligible.
CREATE OR REPLACE FUNCTION public.rpc_ralli_leaderboard_teams(p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_tid uuid := public.get_my_tenant_id();
BEGIN
  IF v_uid IS NULL OR v_tid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  RETURN (
  WITH elig_sessions AS (  -- teams use ONLY 084-roster sessions (immutable session-time team) with exposures
    SELECT s.id FROM public.game_sessions s
    WHERE s.tenant_id = v_tid::text AND s.demo_mode=false AND s.status='completed'
      AND s.ended_at >= p_from AND s.ended_at < p_to
      AND EXISTS (SELECT 1 FROM public.game_question_exposures e WHERE e.session_id = s.id)
      AND EXISTS (SELECT 1 FROM public.game_roster_members r WHERE r.session_id = s.id)
  ),
  faced_raw AS (
    SELECT e.player_id, e.session_id, e.question_idx,
           (SELECT gs.question_snapshot -> e.question_idx ->> 'type' FROM public.game_sessions gs WHERE gs.id = e.session_id) AS qtype,
           v.verified_correct,
           -- team-at-game = immutable 084 roster snapshot for THIS session
           (SELECT r.team_id FROM public.game_roster_members r WHERE r.session_id = e.session_id AND r.player_id = e.player_id) AS snap_team
    FROM public.game_question_exposures e
    JOIN elig_sessions es ON es.id = e.session_id
    LEFT JOIN public.game_answer_verifications v
           ON v.session_id = e.session_id AND v.player_id = e.player_id AND v.question_idx = e.question_idx
  ),
  graded AS (SELECT * FROM faced_raw WHERE NOT (qtype='open' AND verified_correct IS NULL)),
  -- a learner's data attributed to the team they were on per session; a member's adjusted accuracy is
  -- computed across their eligible exposures (team snapshot); we aggregate by the learner's session team.
  per_learner_team AS (
    SELECT g.snap_team AS team_id, g.player_id,
           count(*) AS faced, count(*) FILTER (WHERE g.verified_correct IS TRUE) AS correct,
           count(DISTINCT g.session_id) AS games
    FROM graded g WHERE g.snap_team IS NOT NULL GROUP BY g.snap_team, g.player_id
  ),
  learners AS (
    SELECT plt.*, pr.status AS pstatus, pr.role AS prole
    FROM per_learner_team plt JOIN public.profiles pr ON pr.id::text = plt.player_id
    WHERE pr.role='user' AND pr.status='active' AND pr.tenant_id = v_tid
  ),
  eligible AS (SELECT * FROM learners WHERE faced >= 20 AND games >= 3),
  tmean AS (SELECT COALESCE(sum(correct)::numeric / NULLIF(sum(faced),0), 0.5) AS m FROM eligible),
  member_scores AS (
    SELECT team_id, player_id,
           round((correct + 20*(SELECT m FROM tmean)) / (faced + 20), 6) AS adj_acc
    FROM eligible
  ),
  active_pop AS (  -- active learner population per team (current membership), for the 50% participation gate
    SELECT team_id, count(*) AS active_learners
    FROM public.profiles WHERE tenant_id = v_tid AND role='user' AND status='active' AND team_id IS NOT NULL
    GROUP BY team_id
  ),
  team_stats AS (
    SELECT ms.team_id,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ms.adj_acc)::numeric AS median_adj,
           count(*) AS eligible_members
    FROM member_scores ms GROUP BY ms.team_id
  ),
  teams AS (
    SELECT ts.team_id, tt.name AS team_name, ts.median_adj, ts.eligible_members,
           COALESCE(ap.active_learners,0) AS active_learners,
           round(100.0 * ts.eligible_members / NULLIF(ap.active_learners,0), 1) AS participation_pct,
           (ts.eligible_members >= 2 AND ap.active_learners IS NOT NULL
            AND ts.eligible_members >= ceil(0.5 * ap.active_learners)) AS enough
    FROM team_stats ts
    LEFT JOIN active_pop ap ON ap.team_id = ts.team_id
    LEFT JOIN public.tenant_teams tt ON tt.id = ts.team_id AND tt.tenant_id = v_tid
  ),
  ranked AS (
    SELECT t.*, dense_rank() OVER (
      ORDER BY round(t.median_adj,4) DESC, t.participation_pct DESC NULLS LAST, t.eligible_members DESC, lower(t.team_name)
    ) AS rnk
    FROM teams t WHERE t.enough
  ),
  everyone AS (SELECT t.*, r.rnk FROM teams t LEFT JOIN ranked r USING (team_id))
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
     'team_id', team_id, 'team_name', team_name,
     'median_adjusted_accuracy', median_adj, 'eligible_members', eligible_members,
     'active_learners', active_learners, 'participation_pct', participation_pct,
     'enough_data', enough, 'rank', rnk
   ) ORDER BY (rnk IS NULL), rnk NULLS LAST, median_adj DESC NULLS LAST, lower(team_name)), '[]'::jsonb)
  FROM everyone);
END; $function$;

-- 5c. SELECTED-TEAM member breakdown. Learners may open ONLY their own team; managers any same-tenant team.
CREATE OR REPLACE FUNCTION public.rpc_ralli_team_members(p_team_id uuid, p_from timestamptz, p_to timestamptz)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $function$
DECLARE v_uid uuid := auth.uid(); v_tid uuid := public.get_my_tenant_id(); v_role text; v_my_team uuid;
BEGIN
  IF v_uid IS NULL OR v_tid IS NULL THEN RAISE EXCEPTION 'authentication required' USING ERRCODE='insufficient_privilege'; END IF;
  IF p_team_id IS NULL THEN RAISE EXCEPTION 'team id required' USING ERRCODE='no_data_found'; END IF;
  -- team must belong to caller's tenant
  IF NOT EXISTS (SELECT 1 FROM public.tenant_teams WHERE id = p_team_id AND tenant_id = v_tid) THEN
    RAISE EXCEPTION 'team not found in tenant' USING ERRCODE='no_data_found';
  END IF;
  SELECT role, team_id INTO v_role, v_my_team FROM public.profiles WHERE id = v_uid;
  IF v_role NOT IN ('orgAdmin','manager','ralli_admin') AND p_team_id IS DISTINCT FROM v_my_team THEN
    RAISE EXCEPTION 'not authorized to view another team''s members' USING ERRCODE='insufficient_privilege';
  END IF;
  -- reuse the individuals RPC scoped to the team (single formula source)
  RETURN public.rpc_ralli_leaderboard_individuals(p_from, p_to, p_team_id);
END; $function$;

-- ── Grants: authenticated may read leaderboards + own tz; tz update self-authorizes; queue is service-role. ──
REVOKE EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_set_session_phase(uuid, text, boolean, integer, boolean, boolean, boolean, jsonb) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_get_org_timezone()                         FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_get_org_timezone()                         TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_set_org_timezone(text)                     FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_set_org_timezone(text)                     TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_ralli_leaderboard_individuals(timestamptz, timestamptz, uuid) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_ralli_leaderboard_individuals(timestamptz, timestamptz, uuid) TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_ralli_leaderboard_teams(timestamptz, timestamptz)             FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_ralli_leaderboard_teams(timestamptz, timestamptz)             TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_ralli_team_members(uuid, timestamptz, timestamptz)            FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.rpc_ralli_team_members(uuid, timestamptz, timestamptz)            TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_claim_verification_job()                   FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_claim_verification_job()                   TO service_role;
REVOKE EXECUTE ON FUNCTION public.rpc_complete_verification_job(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.rpc_complete_verification_job(uuid, boolean, text) TO service_role;

-- No DML/backfill: existing sessions get NO exposure rows retroactively (they are "pre-leaderboard tracking"
-- and excluded from ranking). Rankings begin with games played after 085 is applied.
