# Migration 070 — Battle Card required-content constraint (PROPOSAL ONLY)

**Status: NOT created, NOT applied.** This document is a design proposal produced
after the Battle Card body fields were converted to the shared Lesson rich-text
editor. No `supabase/migrations/070_*.sql` file exists yet. Nothing here has run
against any database. Apply only after explicit approval and a fresh preflight.

---

## 1. Why `btrim(column) <> ''` is no longer sufficient

Before this change, the required Battle Card text fields (`strength`, `weakness`,
`our_win`) were plain textareas, so a server constraint of `btrim(column) <> ''`
correctly rejected an empty field.

They now store the **Lesson markdown subset** (the exact format the shared editor
serializes via `htmlToMd`):

| Markup | Serialized form |
|---|---|
| bold | `**text**` |
| italic | `*text*` |
| underline | `__text__` |
| bullet list | `- item` (one per line) |
| numbered list | `1. item` (one per line) |
| empty editor | `""` (the editor collapses `<p><br></p>`, empty lists, and whitespace to the empty string) |

Because a field can now contain **markup with no visible text**, a plain
`btrim(column) <> ''` check would wrongly accept meaningless content. All of the
following are non-empty strings yet have **zero readable characters**:

- `****`  (empty bold markers)
- `**   **`  (bold wrapping only spaces)
- `__ __`  (underline wrapping a space)
- `- \n- \n- `  (bullet markers, no item text)
- `1. \n2. `  (numbered markers, no item text)

The frontend already rejects these — `bcInvalidFields` validates the required
rich fields with `bcPlainText(value)`, which strips list markers and `*`/`_`
emphasis characters and then trims. The server constraint must apply the **same
meaningful-text test** to stay authoritative (a direct PostgREST/SQL write must
not be able to create a card the UI would reject).

> Note: the value stored is markdown, **never raw HTML** — the editor round-trips
> through `htmlToMd`, and the renderer (`renderMarkdown`) emits escaped React
> elements, never `dangerouslySetInnerHTML`. So the server check does **not** need
> to parse or sanitize HTML; it only needs to strip the five markdown-subset
> markers and confirm a visible character remains.

## 2. Proposed server-side meaningful-text helper

An `IMMUTABLE` SQL helper that mirrors `bcPlainText` (rankd-app.jsx): strip
line-leading list markers, strip emphasis markers, trim, and test for any
remaining character.

```sql
-- PROPOSAL — do not apply yet.
create or replace function public.bc_has_meaningful_text(md text)
returns boolean
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      -- strip line-leading "- " and "N. " list markers
      regexp_replace(coalesce(md, ''),
                     '(^|\n)[[:space:]]*(-[[:space:]]+|[0-9]+\.[[:space:]]+)', '\1', 'g'),
      -- strip bold/italic/underline markers (the only emphasis markup in the subset)
      '[*_]', '', 'g'
    )
  ) <> '';
$$;
```

Rationale for `IMMUTABLE`: the output depends only on the input, so it is safe in
a `CHECK` constraint and index-eligible.

## 3. Proposed constraints (`NOT VALID`)

```sql
-- PROPOSAL — do not apply yet.
alter table public.tenant_battle_cards
  add constraint bc_title_present      check (btrim(title) <> '')                     not valid,
  add constraint bc_tags_present       check (coalesce(array_length(tags, 1), 0) >= 1) not valid,
  add constraint bc_strength_meaningful check (public.bc_has_meaningful_text(strength)) not valid,
  add constraint bc_weakness_meaningful check (public.bc_has_meaningful_text(weakness)) not valid,
  add constraint bc_ourwin_meaningful   check (public.bc_has_meaningful_text(our_win))  not valid;
```

- `title` stays a plain-text check (`btrim <> ''`) — it is not a rich field.
- `tags` requires ≥ 1 entry (matches the UI's ≥ 1-tag rule).
- `strength` / `weakness` / `our_win` use the meaningful-text helper.
- `summary`, `talk_track`, and In-Depth section bodies are **optional** rich
  fields and get **no** constraint (consistent with the editor: not marked `*`).

## 4. Why `NOT VALID`, and the two existing incomplete cards

Reconciliation before applying requires a preflight of the current data. There are
two known incomplete active cards (titles **"without a tag"** and **"okay"**,
row ids beginning `ff7b4997` and `302e519c`) whose `strength` / `weakness` /
`our_win` are blank. A plain (validated) constraint would **fail to add** because
those rows violate it.

`NOT VALID` is therefore required and correct here:

- The constraint is enforced on **every INSERT and UPDATE going forward**, so no
  new or edited card can be saved without meaningful required content — the
  server becomes authoritative, matching the UI.
- Existing rows are **not** retroactively checked, so the two incomplete cards are
  **left exactly as they are** — not deleted, not auto-filled, not fabricated.
- The moment a manager edits one of those two cards, the UI already forces the
  required fields, and the `UPDATE` will be checked by the constraint — so they
  get remediated by a human on next edit, naturally.

**Do not run `VALIDATE CONSTRAINT`** until the two incomplete cards have been
completed by their owners; validating earlier would fail on that legacy data.
The preflight (below) reports the exact set to remediate first.

## 5. Pre-apply preflight (read-only — run before authoring the migration)

```sql
-- How many active cards would violate the proposed constraints today?
select id, title,
       (btrim(title) = '')                          as title_blank,
       (coalesce(array_length(tags,1),0) < 1)       as no_tags,
       not public.bc_has_meaningful_text(strength)  as strength_empty,
       not public.bc_has_meaningful_text(weakness)  as weakness_empty,
       not public.bc_has_meaningful_text(our_win)   as ourwin_empty
from public.tenant_battle_cards
where status = 'active'
order by title;
```

(The helper would need to exist first; for a pure read-only preflight, inline the
two `regexp_replace` calls instead of calling the function.)

## 6. Open decision for approval

1. Apply `bc_has_meaningful_text` + the five `NOT VALID` constraints as migration 070.
2. Keep the two incomplete cards untouched; do **not** `VALIDATE CONSTRAINT`.
3. Optionally, a later migration `VALIDATE`s the constraints once the preflight
   returns zero violations (i.e. after the incomplete cards are completed by hand).

No SQL from this document has been executed. Awaiting approval before creating
`supabase/migrations/070_battle_card_required_content.sql`.
