-- Isolated prelude for the migration-085 harness. Base schema + 072 verifications + 084 deps
-- (roster/submissions) already present, so 085 applies cleanly on top. Reconstructed to match prod.
\set ON_ERROR_STOP on
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, aud text, role text, email text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claims', true)::json->>'sub','')::uuid $$;

CREATE TABLE public.tenants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text, name text, plan text, status text, seat_limit integer, admin_email text, logo_url text, domain text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.tenant_teams (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, description text, is_default boolean, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.tenant_quizzes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid, name text, questions jsonb, status text);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, email text, name text, role text, tenant_id uuid, status text, team_id uuid, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE OR REPLACE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.profiles (id) VALUES (NEW.id) ON CONFLICT (id) DO NOTHING; RETURN NEW; END; $$;
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- game_sessions WITH current_question_started_at (084 already applied in this prelude context)
CREATE TABLE public.game_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text, quiz_id text, host_id text, pin text, name text, status text, question_count integer, demo_mode boolean, player_count integer, started_at timestamptz, ended_at timestamptz, created_at timestamptz DEFAULT now(), current_question_index integer, phase text, paused boolean, live_question jsonb, question_snapshot jsonb, live_scoreboard jsonb, scoreboard_version bigint, current_question_started_at timestamptz);
CREATE TABLE public.game_session_participants (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, tenant_id text, player_id text, name text, emoji text, color text, joined_at timestamptz, status text, last_seen_at timestamptz);
CREATE TABLE public.game_answers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, tenant_id text, player_id text, player_name text, question_idx integer, option_idx integer, answer_text text, time_ms integer, is_correct boolean, points integer, answered_at timestamptz DEFAULT now(), answer_json jsonb, numeric_value numeric, was_skipped boolean);
-- 084 canonical tables
CREATE TABLE public.game_roster_members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, tenant_id text, player_id text, name text, emoji text, team_id uuid, team_name text, status text DEFAULT 'active', created_at timestamptz DEFAULT now(), CONSTRAINT uq_rm UNIQUE (session_id, player_id));
CREATE TABLE public.game_answer_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, tenant_id text, player_id text, question_idx integer, q_type text, option_idx integer, answer_text text, numeric_value numeric, answer_json jsonb, submitted_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now(), CONSTRAINT uq_sub UNIQUE (session_id, player_id, question_idx));
-- 072 verifications (authoritative correctness)
CREATE TABLE public.game_answer_verifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid, tenant_id text, player_id text, question_idx integer, verified_correct boolean, eligibility text, grader_version text, snapshot_hash text, verification_method text DEFAULT 'auto', manual_grader_id text, created_at timestamptz DEFAULT now(), CONSTRAINT uq_verif UNIQUE (session_id, question_idx, player_id));

CREATE OR REPLACE FUNCTION public.get_my_tenant_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$ SELECT tenant_id FROM public.profiles WHERE id = auth.uid() $function$;
CREATE OR REPLACE FUNCTION public.ralli_can_manage_session(p_host_id text, p_tenant text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO '' AS $function$
  SELECT auth.uid() IS NOT NULL AND ( p_host_id = auth.uid()::text OR EXISTS ( SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND ( (p.role IN ('orgAdmin','manager') AND p.tenant_id IS NOT NULL AND p.tenant_id::text = p_tenant) OR p.role = 'ralli_admin' ) ) );
$function$;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
