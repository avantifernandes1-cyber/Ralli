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

**Not done:** RLS lockdown migration **057** not created/applied; frontend not merged/deployed to
production; nothing else committed or pushed. Migration 055 unmodified.
