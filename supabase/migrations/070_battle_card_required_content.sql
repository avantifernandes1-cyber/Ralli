-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 070: Battle Card required-content enforcement (server-authoritative)
--
-- Additive and production-safe. Does NOT edit applied migrations 068/069.
--
-- WHY
--   The editor already blocks saving a card without a Title, >=1 tag, Their
--   Strengths, Their Weaknesses, and Why We Win. This closes the same rule at the
--   database so a DIRECT API write (a manager token hitting PostgREST, bypassing
--   the editor) cannot create/keep a meaningless card. Subtitle, Summary, Talk
--   Track and In-Depth sections remain OPTIONAL.
--
-- WHY A HELPER (not btrim <> '')
--   The rich body fields (strength/weakness/our_win) store the shared Lesson
--   markdown SUBSET produced by htmlToMd (rankd-app.jsx). That serializer can emit
--   NON-EMPTY strings that carry NO visible text — e.g. "****" (empty bold),
--   "- " (empty bullet), "1. " (empty numbered item), "   " (spaces), a
--   non-breaking space U+00A0, or "\n" (line breaks). A plain btrim(col) <> ''
--   would wrongly accept these. battle_card_has_meaningful_text() strips the
--   subset's own syntax and checks for a remaining VISIBLE character — mirroring
--   the frontend bcPlainText() so client and server agree. (Bodies are markdown,
--   never raw HTML — the renderer emits escaped React elements — so no HTML
--   parsing/sanitising is needed here.)
--
-- WHY A TRIGGER (not a CHECK constraint)
--   Production holds two legacy incomplete cards (blank strength/weakness/our_win).
--   A CHECK — even NOT VALID — is re-checked on EVERY future UPDATE of a legacy row,
--   so it would BLOCK a manager from archiving/restoring/retagging an incomplete
--   legacy card (the final row still fails the check). A BEFORE trigger can compare
--   OLD vs NEW and enforce NON-REGRESSION instead:
--     - INSERT  → the new card must be fully valid (no legacy exemption).
--     - UPDATE  → a required field that was VALID on OLD must stay valid on NEW.
--   So legacy incomplete rows can still be archived, restored, retagged, have
--   metadata edited, and be partially or fully fixed — but a good card can never be
--   edited into a meaningless one, and the last good tag / a good required field can
--   never be stripped. New cards are always fully validated. See DEPLOYMENT/design
--   doc: docs/engineering/070_REQUIRED_CONTENT_DESIGN.md.
--
-- SCOPE OF ENFORCEMENT
--   Enforced ONLY for the untrusted API client roles (authenticated, anon) — the
--   roles PostgREST runs client requests under. The table owner (postgres, used by
--   migrations/seed) and service_role (backend/emergency, per migration 068) are
--   exempt, exactly as 068 preserves their access. A client cannot obtain
--   service_role (it is a server secret), so "direct API writes cannot bypass the
--   editor" still holds.
--
-- PRESERVES (untouched): 068 lifecycle + provenance triggers, 069 conversion,
--   tenant isolation, learner active-only reads, archive/restore, hard-delete
--   closure, service-role emergency access, the legacy category table, and every
--   existing id/content/timestamp. Purely additive: one IMMUTABLE helper + one
--   BEFORE INSERT/UPDATE trigger. No column, policy, grant, or data change.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1. Meaningful-text helper (mirrors the frontend bcPlainText) ────────────────
-- Returns TRUE iff, after removing the markdown-subset's own syntax, at least one
-- visible (non-whitespace) character remains. Normalises non-breaking spaces,
-- strips line-leading list markers ("- " / "N. ") and emphasis markers (*, _).
-- Real prose that merely CONTAINS '-', digits, '.' or '_' stays meaningful — only
-- line-leading list markers and paired emphasis characters are treated as syntax.
CREATE OR REPLACE FUNCTION public.battle_card_has_meaningful_text(md text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $$
  SELECT regexp_replace(
           regexp_replace(
             -- non-breaking space (U+00A0) → ordinary space, so it trims as whitespace
             replace(coalesce(md, ''), chr(160), ' '),
             -- strip line-leading unordered "- " and ordered "N. " list markers
             '(^|' || chr(10) || ')[ \t\r]*(-[ \t]+|[0-9]+\.[ \t]+)', '\1', 'g'
           ),
           -- strip bold/italic/underline markers (the only emphasis syntax: * and _)
           '[*_]', '', 'g'
         ) ~ '[^[:space:]]';
$$;

COMMENT ON FUNCTION public.battle_card_has_meaningful_text(text) IS
  'TRUE iff the Lesson/Battle-Card markdown-subset string contains visible text after stripping list/emphasis syntax and whitespace (incl. U+00A0). Mirrors frontend bcPlainText. Used by the 070 required-content trigger.';

-- ── 2. Required-content trigger (INSERT full-validity; UPDATE non-regression) ───
CREATE OR REPLACE FUNCTION public.tenant_battle_cards_require_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  n_title boolean; n_tags boolean; n_strength boolean; n_weakness boolean; n_ourwin boolean;
  o_title boolean; o_tags boolean; o_strength boolean; o_weakness boolean; o_ourwin boolean;
BEGIN
  -- Enforce only for untrusted API client roles. postgres (migrations/seed) and
  -- service_role (backend/emergency, per 068) are exempt.
  IF current_user NOT IN ('authenticated', 'anon') THEN
    RETURN NEW;
  END IF;

  n_title    := btrim(coalesce(NEW.title, '')) <> '';
  n_tags     := EXISTS (SELECT 1 FROM unnest(coalesce(NEW.tags, ARRAY[]::text[])) AS elem WHERE btrim(coalesce(elem, '')) <> '');
  n_strength := public.battle_card_has_meaningful_text(NEW.strength);
  n_weakness := public.battle_card_has_meaningful_text(NEW.weakness);
  n_ourwin   := public.battle_card_has_meaningful_text(NEW.our_win);

  IF (TG_OP = 'INSERT') THEN
    IF NOT (n_title AND n_tags AND n_strength AND n_weakness AND n_ourwin) THEN
      RAISE EXCEPTION USING
        ERRCODE = 'check_violation',
        MESSAGE = 'Battle card requires a title, at least one tag, and meaningful Their Strengths, Their Weaknesses, and Why We Win.';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: non-regression. A dimension valid on OLD must stay valid on NEW.
  -- Dimensions already invalid on a legacy row may stay invalid or be improved,
  -- so archive/restore, tag edits, metadata edits and content fixes are allowed;
  -- a good card can never be edited into an invalid one, nor a good field removed.
  o_title    := btrim(coalesce(OLD.title, '')) <> '';
  o_tags     := EXISTS (SELECT 1 FROM unnest(coalesce(OLD.tags, ARRAY[]::text[])) AS elem WHERE btrim(coalesce(elem, '')) <> '');
  o_strength := public.battle_card_has_meaningful_text(OLD.strength);
  o_weakness := public.battle_card_has_meaningful_text(OLD.weakness);
  o_ourwin   := public.battle_card_has_meaningful_text(OLD.our_win);

  IF (o_title    AND NOT n_title)
  OR (o_tags     AND NOT n_tags)
  OR (o_strength AND NOT n_strength)
  OR (o_weakness AND NOT n_weakness)
  OR (o_ourwin   AND NOT n_ourwin) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'check_violation',
      MESSAGE = 'Battle card update would remove required content that was previously present (title, a tag, Their Strengths, Their Weaknesses, or Why We Win).';
  END IF;

  RETURN NEW;
END;
$$;

-- Fires BEFORE the 068 provenance trigger (name sorts before trg_touch_*) and only
-- validates — it never modifies NEW, so 068's server-authoritative provenance is
-- untouched.
DROP TRIGGER IF EXISTS trg_battle_cards_require_content ON public.tenant_battle_cards;
CREATE TRIGGER trg_battle_cards_require_content
  BEFORE INSERT OR UPDATE ON public.tenant_battle_cards
  FOR EACH ROW EXECUTE FUNCTION public.tenant_battle_cards_require_content();

-- ─────────────────────────────────────────────────────────────────────────────
-- Verify (read-only):
--   SELECT public.battle_card_has_meaningful_text('****');            -- f
--   SELECT public.battle_card_has_meaningful_text('- ' || chr(10) || '- ');  -- f
--   SELECT public.battle_card_has_meaningful_text('**Fast** setup');  -- t
--   SELECT tgname FROM pg_trigger WHERE tgrelid='public.tenant_battle_cards'::regclass ORDER BY tgname;
-- Legacy: the two incomplete production cards are left exactly as they are. They
-- can still be archived/restored/retagged; any edit that keeps their good fields
-- good is allowed; the trigger only blocks removing content that is already valid.
-- A future migration MAY add a validated CHECK once both legacy cards are completed
-- by hand (do NOT add a NOT VALID CHECK now — it would block archiving them).
-- ─────────────────────────────────────────────────────────────────────────────
