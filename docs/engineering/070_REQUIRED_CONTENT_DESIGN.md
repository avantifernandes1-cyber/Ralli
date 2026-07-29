# Migration 070 — Battle Card required-content enforcement (DESIGN + IMPLEMENTATION)

**Status: implemented locally, NOT applied to production, NOT merged.**
File: `supabase/migrations/070_battle_card_required_content.sql`.
Tests: `supabase/tests/070_battle_card_required_content.test.sql`.
Applied + tested only against a local `supabase db reset`. Awaiting read-only
production preflight approval before applying.

## Objective

Enforce, at the database, the same required content the editor already enforces, so
a **direct API write** (a manager/user token hitting PostgREST, bypassing the
editor) cannot create or keep a meaningless Battle Card. Required: **Title**,
**≥1 meaningful tag**, **Their Strengths**, **Their Weaknesses**, **Why We Win**.
**Optional:** Subtitle, Summary, Talk Track, In-Depth sections.

## 1. Exact serialized-format audit (the real serializer, not HTML/Markdown assumed)

The body fields (`strength`, `weakness`, `our_win`) store the output of the shared
Lesson/Battle-Card editor's `htmlToMd()` serializer (rankd-app.jsx). It is a
**markdown subset**, produced by walking the contentEditable DOM. Traced outputs of
what is actually **stored** (after `htmlToMd`'s final
`.replace(/\n{3,}/g,"\n\n").replace(/^\n+|\n+$/g,"")`):

| Editor content | Stored string (exact) |
|---|---|
| plain text | `Hello world` |
| bold | `**Hello**` |
| italic | `*Hello*` |
| underline | `__Hello__` |
| unordered list (2 items) | `- one\n- two` |
| ordered list (2 items) | `1. one\n2. two` |
| line break inside a block | `a\nb` |
| empty paragraph `<p><br></p>` | `` (empty string) |
| several empty paragraphs | `` (empty string) |
| empty list `<ul></ul>` / `<ul><li></li></ul>` | `` / `- ` |
| whitespace-only paragraph | `   ` (the spaces, trailing `\n` trimmed) |
| non-breaking spaces (`&nbsp;`) | `  ` (U+00A0 preserved from `textContent`) |
| formatting-only (empty bold) | `****` (or `**`, `____`, `__ __`) |

Key consequences that drive the SQL:
- A **non-empty** string can carry **no visible text** (`****`, `- `, `1. `, `   `,
  ` `, `\n`). So `btrim(col) <> ''` is **insufficient**.
- The only "syntax" characters are line-leading list markers (`- `, `N. `) and the
  emphasis markers `*` and `_`. Everything else — letters, digits, `.`/`,`/`-`
  inside prose — is real content and must stay meaningful (`24/7 world-class
  support.` is meaningful).
- Bodies are **markdown, never raw HTML** (the renderer emits escaped React
  elements — no `dangerouslySetInnerHTML`), so the server does **not** parse or
  sanitise HTML.

## 2. Meaningful-content helper

`public.battle_card_has_meaningful_text(text) → boolean`, `IMMUTABLE PARALLEL SAFE`,
mirrors the frontend `bcPlainText`:
1. `replace(md, U+00A0, ' ')` — normalise non-breaking spaces to ordinary space.
2. strip line-leading `- ` / `N. ` list markers.
3. strip emphasis markers `*` and `_`.
4. `~ '[^[:space:]]'` — TRUE iff any visible (non-whitespace) character remains.

Returns **false** for null / `''` / whitespace / ` ` / `\n` / `****` / `__ __` /
`- ` / `1. `; **true** for real text in any supported formatting. (Verified by 17
helper assertions in the test.)

**Tags** are validated inline in the trigger: at least one element whose `btrim` is
non-blank — `null`, `{}`, `{''}`, `{'   '}` all fail; `{'crm'}` passes. (A normalized,
nonblank value, not merely a non-empty array.)

## 3. Enforcement design — BEFORE trigger with non-regression (not a CHECK)

`public.tenant_battle_cards_require_content()` — `BEFORE INSERT OR UPDATE`, sorts
before `trg_touch_tenant_battle_cards`, validates only (never mutates `NEW`, so 068
provenance is untouched):

- **Enforced only for the untrusted client roles** `authenticated` and `anon` (the
  roles PostgREST runs client requests under). `postgres` (migrations/seed) and
  `service_role` (backend/emergency, per 068) are exempt — a client cannot obtain
  service_role, so "direct API writes cannot bypass the editor" still holds.
- **INSERT** → the new card must be **fully valid** (Title, ≥1 tag, Strengths,
  Weaknesses, Why We Win). No legacy exemption on insert.
- **UPDATE** → **non-regression**: a required dimension that was **valid on OLD**
  must stay valid on NEW. Dimensions already invalid on a legacy row may stay
  invalid or be improved.

### Why not a CHECK constraint (even `NOT VALID`)

A CHECK evaluates the **final row** on every future UPDATE. A `NOT VALID` CHECK would
therefore **block a manager from archiving/restoring/retagging an incomplete legacy
card**, because the resulting row still fails the check. That is exactly the
"unexpectedly prevents archiving a legacy card" hazard called out in the brief. A
BEFORE trigger can compare OLD↔NEW and permit safe lifecycle/metadata operations
while still rejecting new invalid cards and content-removing edits — so the trigger
is the smallest honest design that does not weaken validation for new cards.

## 4. Legacy-row behaviour (the two incomplete production cards)

Both production incomplete cards have a Title and a tag but blank
`strength`/`weakness`/`our_win`. Under 070 they are **left exactly as they are** — not
auto-filled, rewritten, or invented. Exact effects (all proven in the test against an
owner-seeded incomplete legacy fixture):

| Operation on an incomplete legacy card | Result |
|---|---|
| edit unrelated metadata (subtitle/summary) | **allowed** (no required field regresses) |
| archive | **allowed** |
| restore | **allowed** |
| tag change keeping ≥1 tag | **allowed** |
| remove the last tag | **blocked** (regresses the tag requirement) |
| add/fix content (partial or full) | **allowed**; once fully valid it can never regress |
| provenance/timestamp triggers (068) | **unchanged** — server still owns `updated_by`/`updated_at`/`archived_at`; `created_by`/`created_at` immutable |

**Decision:** ship the trigger only; do **not** add a `NOT VALID` CHECK now (it would
block archiving the legacy cards). A future migration may add a *validated* CHECK as
belt-and-suspenders **after** both legacy cards are completed by hand and a preflight
returns zero violations. No legacy content is modified by 070.

## 5. Security & lifecycle preserved

070 is purely additive (one helper + one trigger). It does **not** modify 068/069 or
any column/policy/grant/data. Preserved and re-verified by the 068/069 regression
tests run alongside 070: lifecycle + provenance triggers (068), category→tag
conversion (069), tenant isolation, learner active-only reads, archive/restore,
hard-delete closure, service-role emergency access, the legacy category table, and
every existing id/content/timestamp.

## 6. Preflight before applying (read-only)

```sql
-- With the helper present, how many ACTIVE cards would a client be unable to
-- re-save without completing (i.e. are currently incomplete)?
SELECT id, title,
       btrim(coalesce(title,'')) = ''                              AS title_blank,
       NOT EXISTS (SELECT 1 FROM unnest(coalesce(tags,'{}')) t WHERE btrim(coalesce(t,''))<>'') AS no_tag,
       NOT public.battle_card_has_meaningful_text(strength)        AS strength_empty,
       NOT public.battle_card_has_meaningful_text(weakness)        AS weakness_empty,
       NOT public.battle_card_has_meaningful_text(our_win)         AS ourwin_empty
FROM public.tenant_battle_cards
WHERE status = 'active'
ORDER BY title;
```

Expect exactly the two known incomplete cards. No SQL from 070 has run against
production. **Stop for read-only production preflight approval before applying.**
