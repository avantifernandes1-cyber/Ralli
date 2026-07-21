-- ─────────────────────────────────────────────────────────────────────────────
-- Ralli Live — Matching & Slider answer persistence
--
-- game_answers previously had no column that could represent a Matching
-- submission (an array of {leftIdx, rightIdx} pairs) or a Slider submission
-- (a single numeric value). Both question types were therefore completely
-- non-functional in live multiplayer play: even once UI/scoring exists,
-- there was nowhere to durably store what a player submitted.
--
-- answer_json  — Matching: [{ "leftIdx": 0, "rightIdx": 2 }, ...]. JSONB
--                (not a new normalized table) to match the low-ceremony shape
--                of the rest of this table and because this is per-answer,
--                per-question data with no independent query need — the
--                self-paced quiz-taking flow's `game_answers` equivalent
--                (question `answers` on quiz_attempts) already stores
--                structured answer data as JSON for the same reason.
-- numeric_value — Slider: the raw value the player set. NUMERIC (not INTEGER)
--                so a slider question configured with a fractional step still
--                stores the actual value rather than truncating it.
--
-- Both are nullable and additive — existing MC/TF/Type/Open rows are
-- unaffected, and option_idx/answer_text keep their existing meaning for
-- those types.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE game_answers
  ADD COLUMN IF NOT EXISTS answer_json    JSONB,
  ADD COLUMN IF NOT EXISTS numeric_value  NUMERIC;

COMMENT ON COLUMN game_answers.answer_json   IS 'Matching questions: array of {leftIdx, rightIdx} pairs the player submitted';
COMMENT ON COLUMN game_answers.numeric_value IS 'Slider questions: the numeric value the player submitted';
