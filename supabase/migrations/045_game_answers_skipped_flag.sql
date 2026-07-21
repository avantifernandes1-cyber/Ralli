-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli Live — distinguish "skipped by host" from "unanswered" in game_answers
--
-- Today game_answers only gets a row for players who actually submitted an
-- answer (doReveal() in rankd-app.jsx only iterates chAnswers). That means:
--   - A player who ran out of time without answering has NO row at all.
--   - A question the host skipped entirely has NO rows for anyone.
-- Both cases are therefore indistinguishable — "zero rows for this
-- question_idx" could mean either. Post-game analytics (Player Breakdown /
-- Questions drill-down) needs to tell them apart to show "No answer
-- submitted" vs "Question skipped by host" accurately.
--
-- This migration only adds the marker column. The accompanying app change
-- (doReveal now writes an explicit row for every known player, including
-- non-answerers with was_skipped=false; doSkip now writes one row per known
-- player with was_skipped=true) is what actually populates it going forward.
--
-- Nullable-safe default: existing rows all represent real submitted answers,
-- so backfilling false is correct and lossless. Sessions played before this
-- migration that have zero rows for a question remain ambiguous — the
-- analytics UI falls back to "Answer detail unavailable" for those rather
-- than guessing.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE game_answers
  ADD COLUMN IF NOT EXISTS was_skipped BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN game_answers.was_skipped IS 'true when the host skipped this question via Skip Question — distinguishes "skipped" from "ran out of time without answering" for post-game analytics.';
