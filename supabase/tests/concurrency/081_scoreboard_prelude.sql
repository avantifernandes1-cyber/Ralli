-- Minimal dependency prelude so the EXACT committed migration 081 file can be applied unchanged.
-- Provides ONLY the tables + identity stubs the 081 functions reference; defines NONE of the 081
-- objects (they come verbatim from supabase/migrations/081_ralli_live_scoreboard_recovery.sql).
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE public.game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text, quiz_id text NOT NULL,
  host_id text NOT NULL DEFAULT 'anon', pin text NOT NULL, name text,
  status text NOT NULL DEFAULT 'waiting', question_count int NOT NULL DEFAULT 0,
  demo_mode boolean NOT NULL DEFAULT false, started_at timestamptz, ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), current_question_index int NOT NULL DEFAULT 0,
  phase text NOT NULL DEFAULT 'waiting', paused boolean NOT NULL DEFAULT false,
  live_question jsonb, question_snapshot jsonb );
CREATE TABLE public.game_session_participants (
  session_id uuid, player_id text, tenant_id text, name text, emoji text, color text,
  status text DEFAULT 'active', joined_at timestamptz DEFAULT now(), last_seen_at timestamptz DEFAULT now(),
  PRIMARY KEY (session_id, player_id) );
CREATE TABLE public.game_answers ( session_id uuid, player_id text, player_name text, question_idx int, points int, is_correct boolean, answer_text text );
CREATE TABLE public.profiles ( id uuid PRIMARY KEY, tenant_id uuid, role text );
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
CREATE FUNCTION public.get_my_tenant_id() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-0000-0000-0000000000aa'::uuid $$;
CREATE FUNCTION public.ralli_can_manage_session(p_host text, p_tenant text) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
