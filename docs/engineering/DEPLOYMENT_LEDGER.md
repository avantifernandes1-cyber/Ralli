# Deployment Ledger

Auditable record of migrations applied to **production** (`jdwqaypjxnnvxbqnxpet`) under
**Strategy A** — controlled, individual `apply_migration` only. Never `db push`,
never `migration repair`, never a manual `schema_migrations` insert, never a history rewrite.
Rollbacks are always new forward corrective migrations.

## 2026-07-23 — Phase 1 (readiness versioning 050–053) + Area 1 (quiz hardening 054)

Branch `fix/readiness-versioning` @ HEAD `a11ba6a` (050–053 committed in `6a8b864`, 054 in `a11ba6a`).
Applied via controlled `apply_migration` tool, individually and in order. SHA-256 re-confirmed
against committed HEAD immediately before each application.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 1 | `20260723172249` | readiness_versioning_tables | supabase/migrations/050_readiness_versioning_tables.sql | 6a8b864 | 3bf0409260439d5a251b3b5a972cbb1bf97856e736739904df5bae43443e26ea | 2026-07-23 17:22:49 | PASS — 6 tables, 12 composite FK/UQ, 3 indexes, 0 triggers, 0 seed rows |
| 2 | `20260723172446` | readiness_versioning_rls | supabase/migrations/051_readiness_versioning_rls.sql | 6a8b864 | b619b669d3ce98ac62b7ebc43113fa100d5c5a46ccd441db983af835bf0d118f | 2026-07-23 17:24:46 | PASS — RLS on all 6, 6 SELECT policies, 0 write policies, 2 helper fns |
| 3 | `20260723172603` | readiness_seed_v1_and_copy | supabase/migrations/052_readiness_seed_v1_and_copy.sql | 6a8b864 | cec8549462a5e9347cee5417998fe65e799902a9a0e696c4e40da25f0cc09020 | 2026-07-23 17:26:03 | PASS — 1 active v1 (threshold 93, hash 42fca5a2…), 2 copied = 2 legacy, 0 parity mismatch |
| 4 | `20260723173343` | readiness_enqueue_function | supabase/migrations/053_readiness_enqueue_function.sql | 6a8b864 | 676df306574d02dca56829c98b6dc19d60d27013c52b30c7ea4cd2bca34ce35e | 2026-07-23 17:33:43 | PASS — fn present (SECURITY DEFINER), revoked anon+authenticated, 0 triggers, 0 queue rows |
| 5 | `20260723174832` | quiz_server_grading | supabase/migrations/054_quiz_server_grading.sql | a11ba6a | 616989246513ecdc3059ac21594b12f9f51c283fd8e63a78681350d857c7d8af | 2026-07-23 17:48:32 | PASS — v2 RPC + provenance lockdown + revision; legacy path intact; parity holds |

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger rows 13 → 18.

**Local↔remote naming note (Strategy A):** repo uses `NNN_` numeric filenames; production ledger
uses timestamp versions (existing convention). `migration list` will always show a mismatch — that
is expected. The mapping in this table is the reconciliation of record.

**Deferred (not applied):** `038_realtime_tenant_assignments` (unapplied historically) and the
`027` dedup index (possible divergence) — each to be handled as a separate future forward migration.

**Not done post-054:** branch not pushed; preview not deployed. (The legacy-SELECT
**revocation** is migration **056**, not yet created — see below; 055 is the additive
learner-safe access layer.)

## 2026-07-24 — Answer confidentiality Stage 1 (learner-safe quiz access 055)

Branch `fix/readiness-versioning` @ HEAD `1c1d6ce` (055 committed in `1c1d6ce`, "fix: protect
learner quiz answers"). Applied via one controlled `apply_migration` call under Strategy A.
SHA-256 re-confirmed against the committed HEAD blob immediately before application.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 6 | `20260724000340` | 055_learner_safe_quiz_access | supabase/migrations/055_learner_safe_quiz_access.sql | 1c1d6ce | cc3c09a381e55f0a4bbbbba31ddc36a23d43978c42a9de4c246b7a00f747f941 | 2026-07-24 00:03:40 | PASS — see below |

**Verification (all read-only, post-apply):**
- Backfill: **1** snapshot total = the single exact-revision-match `server_v2` attempt; 1 v2-mismatch + 25 legacy remain unsnapshotted; 0 snapshots on untrusted rows.
- Learner RPCs present, `SECURITY DEFINER`, EXECUTE = authenticated only (anon/public denied): `list_quizzes_for_learner`, `get_quiz_for_attempt`, `get_quiz_review`, `list_my_quiz_attempts_safe`; internal helpers `_quiz_sanitize_for_attempt`/`_quiz_learner_can_access` locked (no anon/authenticated/public EXECUTE).
- `submit_quiz_attempt_atomic_v2`: writes the immutable snapshot in-transaction, stores `isCorrect` (no canonical `correct`), returns learner-safe object (no `to_jsonb(v_attempt)`).
- `quiz_attempt_solutions`: RLS enabled; single policy `qas_select_manager` (SELECT, manager/admin only); **no** INSERT/UPDATE/DELETE policy; no non-internal triggers.
- Legacy path intact: `submit_quiz_attempt_atomic` present; `quiz_attempts` (`own_insert`, `tenant_read`) and `tenant_quizzes` (select/insert/update/delete) policies **unchanged**.
- No unrelated schema change; no migration-056 objects; readiness pipeline inert (`readiness_recalc_queue` = 0 rows; 0 non-internal triggers on quiz tables).

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 19.

**Security status:** application data flow is learner-safe. Raw REST/API SELECT confidentiality is
**not yet closed** — `tenant_quizzes_select` and `quiz_attempts_tenant_read` still permit a learner's
own direct reads. (Sequencing note: the RLS legacy-SELECT revocation was renumbered to migration
**057** — a migration is atomic and cannot mix an "apply now" RPC change with an "apply later" RLS
change; 057 is not created/applied. Migration **056** below is the RPC-only Stage A.)

## 2026-07-24 — Answer confidentiality Stage A (RPC sanitization + tag RPC 056)

Branch `fix/readiness-versioning` @ `7162411` ("fix: sanitize quiz review answers + learner-safe
insight sources"). Applied via one controlled `apply_migration` (Strategy A). SHA-256 re-confirmed
against the committed HEAD blob immediately before application.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 7 | `20260724184808` | 056_quiz_learner_safe_insights | supabase/migrations/056_quiz_learner_safe_insights.sql | 7162411 | 2efe302b35d80cb0a7cf3c22e5fe1bae18d9a2837b9ba18b9c8da8b7a6f6727f | 2026-07-24 18:48:08 | PASS — see below |

**Verification (all read-only, post-apply):**
- Objects: `get_quiz_review(uuid)` replaced; `_quiz_answers_learner_safe(jsonb)` + `list_quiz_tags_for_learner()` created, correct signatures.
- Leak closed: as the affected learner (56dafe93) on a quiz with pre-055 server_v2 + legacy attempts, `get_quiz_review` returns `revealAvailable=false`, **0** canonical keys across all answers (was >0 pre-056), every answer projected to `{questionId, selected, isCorrect, timeSpent}`, `solutionsByAttempt={}` before a pass.
- Reveal source: `get_quiz_review` reads `quiz_attempt_solutions` only (never `tenant_quizzes`) — snapshot-only reveal (structural; prod has no official pass to exercise live).
- `list_quiz_tags_for_learner` = exactly `eligible ∪ own-attempt-history`, tenant-scoped, no extra/missing rows, no other-user widening, no cross-tenant.
- Grants: `get_quiz_review` + `list_quiz_tags_for_learner` EXECUTE = authenticated only (anon denied); `_quiz_answers_learner_safe` locked from authenticated + anon.
- No side effects: RLS policies on `tenant_quizzes`/`quiz_attempts`/`quiz_attempt_solutions` **unchanged** (baseline); table SELECT grants unchanged (9); **0** non-internal triggers; **0 rows changed by the migration** (the 2 newest attempts predate the 18:48:08 apply; 056 contains no DML). Legacy `submit_quiz_attempt_atomic` intact.
- Current production app operational: `main` (legacy) does not call these RPCs and reads tables directly (unchanged) → unaffected; applying 056 pre-merge is backward compatible.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 20.

**Update (2026-07-24, later):** the learner-safe frontend was merged to `main`
(`445bbef`) and deployed to production (Vercel READY), and migration **057** was
subsequently authored and applied — see below.

## 2026-07-24 — Answer confidentiality Stage B (learner RLS lockdown 057)

Branch `fix/quiz-learner-rls` @ `f00cff4` ("feat: migration 057 — learner RLS lockdown on
answer-bearing quiz tables"), branched from `main` @ `445bbef` (the deployed learner-safe app).
Applied via one controlled `apply_migration` (Strategy A). SHA-256 re-confirmed against the
committed blob immediately before application.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 8 | `20260724205419` | 057_quiz_learner_rls_lockdown | supabase/migrations/057_quiz_learner_rls_lockdown.sql | f00cff4 | 7f86da8ba21b5125109b198be7087a56113a5b9e058025c7ff745f02bd33d93f | 2026-07-24 20:54:19 | PASS — see below |

**Verification (all read-only, post-apply):**
- Policies after apply — both locked to `get_my_role() = ANY('{ralli_admin,orgAdmin,manager}') AND (ralli_admin OR tenant_id = get_my_tenant_id())`:
  - `tenant_quizzes_select`, `quiz_attempts_tenant_read`.
- Learner (role `user`, `SET ROLE authenticated`): direct SELECT `tenant_quizzes` = **0 rows**; `quiz_attempts` = **0** (own **and** others').
- Learner-safe RPCs still work: `list_quizzes_for_learner`=4 (catalog), `list_my_quiz_attempts_safe`=27 (Home/History/To-Do), `list_quiz_tags_for_learner`=4 (Knowledge by Topic), `get_quiz_for_attempt` returns sanitized questions (taking), `get_quiz_review` reveal=false + **0** canonical keys (failed review). Passed-review reveal is snapshot-only (structural — no official pass exists in production to exercise live).
- Manager (orgAdmin): direct SELECT `tenant_quizzes`=4, `quiz_attempts`=28 (tenant-scoped analytics/drilldowns retained); 0 other-tenant rows (isolation). Ralli admin: cross-tenant read retained (4 quizzes).
- Unchanged: `quiz_attempts_own_insert`, `tenant_quizzes_{insert,update,delete}`, `quiz_attempt_solutions.qas_select_manager` (manager-only, immutable). `submit_quiz_attempt_atomic_v2` (grading) + legacy `submit_quiz_attempt_atomic` intact. **056 `get_quiz_review` sanitization intact** (still uses `_quiz_answers_learner_safe`).
- No side effects: 0 rows changed (28/4/2; 057 has no DML), 9 table SELECT grants unchanged, 0 non-internal triggers, 7 total policies (2 replaced + 5 unchanged), no schema change.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 21.

**Security status — Quiz answer confidentiality is now FULLY CLOSED:** the learner-safe app is live
in production (main `445bbef`); migration **056** sanitizes `get_quiz_review` (no canonical keys pre
pass; reveal only from immutable snapshot after an official pass); migration **057** revokes learner
direct SELECT on `tenant_quizzes`/`quiz_attempts` — closing both the RPC-payload leak and the
raw-REST direct-read bypass. Managers/org admins/ralli admins retain required tenant-scoped access;
inserts, grading, and snapshot immutability are unchanged.

## 2026-07-24 — Quiz Taxonomy backend foundation (058 + 059)

Branch `feature/quiz-taxonomy` @ `f5af83f` ("feat(quiz-taxonomy): normalized tenant tag taxonomy +
attempt-time snapshots (backend foundation)"), branched from `main` @ `cca6c57`. Backend only — no
UI, no Heatmap aggregation. Applied as two controlled `apply_migration` calls (Strategy A), 058 then
059, each SHA-256 re-confirmed against the committed blob immediately before application.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 9  | `20260724222803` | 058_quiz_taxonomy | supabase/migrations/058_quiz_taxonomy.sql | f5af83f | 48a88f25a0eea4813741afc4a3e4a2374f6bc46d25ba5076f68bb1d840a71203 | 2026-07-24 22:28:03 | PASS |
| 10 | `20260724223007` | 059_attempt_taxonomy_snapshots | supabase/migrations/059_attempt_taxonomy_snapshots.sql | f5af83f | 8fbebb5566a40ec5d4bd03fb6490cc4edbc49e8aa606a303ec29f7795b5a9938 | 2026-07-24 22:30:07 | PASS |

**058 verification (read-only, post-apply):**
- Tables `tenant_quiz_tags` + `quiz_tag_map` created (0 rows). `tenant_quizzes.tags_classified_at` added; `normalized_label` is GENERATED ALWAYS.
- Constraints present: full-status `UNIQUE(tenant_id, normalized_label)` (`uq_tenant_quiz_tags_norm`), `UNIQUE(id,tenant_id)` on both new tags and `tenant_quizzes` (`uq_tenant_quizzes_id_tenant`), label-not-blank, no-self-merge, merged⇒archived, status check, composite tenant-consistency FKs on `quiz_tag_map`.
- RLS enabled; exactly 2 SELECT policies (`tenant_quiz_tags_select`, `quiz_tag_map_select`) gated `is_ralli_admin() OR (tenant match AND role IN {orgAdmin,manager})`; **no write policies** (all mutations via SECURITY DEFINER RPCs).
- Grants: managers/orgAdmin/ralli_admin get SELECT (default table privilege) + pass RLS → can read; learners hold the table grant but RLS excludes them (0 rows) and no write policy → no direct read/write. RPC EXECUTE = authenticated only; anon denied.
- RPCs (all `SECURITY DEFINER`, `search_path=''`): `create_quiz_tag(text)`, `rename_quiz_tag(uuid,text)`, `archive_quiz_tag(uuid)`, `restore_quiz_tag(uuid)`, `merge_quiz_tags(uuid,uuid)`, `set_quiz_tags(uuid,uuid[],boolean)`, `list_quiz_tags_for_learner()`.
- Data unchanged: 4 quizzes (all `tags='[]'`, all `tags_classified_at IS NULL` = awaiting), 28 attempts, 2 solution snapshots.

**059 verification (read-only, post-apply):**
- Tables `quiz_attempt_tag_snapshots` (envelope) + `quiz_attempt_tags` (links) created (0 rows). FKs: envelope.attempt_id→`quiz_attempts(id)` CASCADE; links.attempt_id→envelope CASCADE; links.tag_id→`tenant_quiz_tags(id)` **RESTRICT** (history-referenced tag can never be hard-deleted).
- RLS enabled; 2 SELECT-only policies (manager gate); **0 write policies** (immutable, matching `quiz_attempt_solutions`).
- `submit_quiz_attempt_atomic_v2` retains grading, idempotency (`idempotency_key` guard), XP economy (25/75/40/25), pass cutoff (`COALESCE(passing_score,100)`), answer sanitization (returns whitelist `v_stored`; **no `'correct'` key built** — verified), and the immutable solution-snapshot insert. Only added: the taxonomy-snapshot block, **gated by `tags_classified_at IS NOT NULL`** (a no-op while all quizzes are unclassified).
- `set_quiz_tags(uuid,uuid[],boolean)` explicit-classify contract present (three states awaiting/tagged/uncategorized).
- **056 intact** (`get_quiz_review` still sanitizes via `_quiz_answers_learner_safe`); **057 intact** (`tenant_quizzes_select`, `quiz_attempts_tenant_read` policies present).
- No data auto-classified or rewritten: all 4 quizzes remain awaiting (`tags_classified_at IS NULL`); **0** attempt snapshot envelopes; 28 attempts / 2 solutions unchanged; `quiz_tag_map` + `tenant_quiz_tags` = 0 rows (no test tags created); no triggers on `quiz_attempts`.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger rows 22–23. (Recorded uncommitted at apply time; committed on `feature/quiz-taxonomy` during the backend repository closeout.)

**Status:** Quiz Taxonomy backend foundation is live in production (versions `20260724222803`,
`20260724223007`), dormant until the Manager Quiz Tags UI ships (no product writer yet; learner-safe
RPC returns today's data unchanged). Migrations 056/057 remain intact.
