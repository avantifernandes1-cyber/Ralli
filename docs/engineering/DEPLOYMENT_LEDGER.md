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

## 2026-07-25 — Archived-tag integrity + shared taxonomy lock (060)

Branch `feature/quiz-tags-ui` @ `e1bab954581cbaf6fc2995ed1261d199c1d938e6`. Applied via one
controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
immediately before application. Forward migration — does NOT edit applied 058/059.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 24 | `20260725002148` | 060_archive_tag_integrity | supabase/migrations/060_archive_tag_integrity.sql | e1bab95 | c0e14a06a14b7b4cd72d007f3589495e38fe4f2bf8bcbc0bc72fffbeed161848 | 2026-07-25 00:21:48 | PASS |

**What 060 changes (three SECURITY DEFINER RPCs replaced; `search_path=''`; grants unchanged =
authenticated only):**
- `archive_quiz_tag` — atomic block-or-detach: rejects with a count-bearing error when the tag is
  the only active tag on ≥1 currently-mapped quiz; otherwise archives + detaches its current
  `quiz_tag_map` rows. Immutable attempt snapshots untouched (RESTRICT FK; tag archived not deleted).
- `set_quiz_tags` — server-authoritative ≥1-active-tag invariant: rejects empty / archived-only /
  foreign-tenant / merged-source sets; no "uncategorized" outcome. First-classification inheritance +
  grading preserved verbatim.
- `merge_quiz_tags` — 058 body verbatim + the shared lock (repoint source→active target, dedupe,
  source archived + merged_into=target).
- Conditional one-time cleanup: deletes an archived mapping only when the quiz keeps another active
  tag (never strands a quiz).
- All three mutators take the identical per-tenant advisory lock
  `pg_advisory_xact_lock(hashtextextended('quiz_taxonomy:'||tenant,0))`, serializing archive/assign/
  merge in a tenant.

**Post-apply verification (read-only):**
- Recorded version `20260725002148` / name `060_archive_tag_integrity`; migration rows 24.
- Lock present in all three (archive/set/merge); archive block+detach present; set requires active +
  no "uncategorized"; merge source→target present. (Behavioral execution proven by the local
  `060_archive_tag_integrity` harness — 11 sections; production RPCs were NOT invoked so no production
  data was mutated during verification.)
- **Conditional cleanup changed 0 production rows** (`quiz_tag_map` count 1 before and after — the
  only archived mapping, `dre`, was already removed by preview remediation). 0 archived current
  mappings; 0 stranded quizzes.
- Dre's Quiz keeps its active `testing` mapping; archived `dre` has 0 current mappings; all **17**
  historical `dre` attempt-tag snapshot links intact. Snapshots 17 envelopes / 17 links, attempts 28,
  solutions 2 — unchanged.
- **056/057 intact**: `get_quiz_review` still sanitizes via `_quiz_answers_learner_safe`;
  `submit_quiz_attempt_atomic_v2` keeps the immutable solution snapshot and builds no `correct` key;
  `tenant_quizzes_select` + `quiz_attempts_tenant_read` policies present. Grading/XP/passing/answer
  sanitization unchanged. No unrelated schema/RLS/grant/trigger/worker/Heatmap changes; 0 taxonomy
  triggers.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 24. This ledger update is intentionally left uncommitted.

## 2026-07-25 — Honest merged-tag collision messages (061)

Branch `feature/quiz-tags-ui` @ `7fe7f43cec1706fb03a207faa1de5848ee251405`. Applied via one
controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
immediately before application. Error-handling ONLY — does NOT edit applied migrations 058/059/060.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 25 | `20260725004220` | 061_merged_tag_error_messages | supabase/migrations/061_merged_tag_error_messages.sql | 7fe7f43 | 3ba62ec5baa11bf699d74eae10be7666d1e190686aa28436cd3bca27074bc9ec | 2026-07-25 00:42:20 | PASS |

**What 061 changes:** `create_quiz_tag` + `rename_quiz_tag` collision error text ONLY (both are
`SECURITY DEFINER`, `search_path=''`, EXECUTE=authenticated). Reservation-across-all-statuses,
insert/update, returns, role/tenant checks and grants are byte-identical to 058. Three honest
branches: active → `A tag named "X" already exists.`; plain archived → `A tag with this name is
archived. Restore it instead of creating a duplicate.`; merged → `<Source> was merged into <Target>
and cannot be recreated. Use <Target> instead.`

**Post-apply verification (read-only):**
- Recorded version `20260725004220` / name `061_merged_tag_error_messages`; migration rows 25.
- All three branches present in both `create_quiz_tag` and `rename_quiz_tag`.
- LIVE check against production `testing → avanti` (raised-and-caught, no mutation): both create and
  rename surface `testing was merged into avanti and cannot be recreated. Use avanti instead.`
- Merged `testing` still has `merged_into` set → not restorable/recreatable; plain archived tags stay
  restorable (restore logic untouched).
- **061 performs no DML**; the verification mutated nothing. Current production counts (3 tags [2
  active, 1 archived/merged], 2 `quiz_tag_map` rows, 22 snapshot envelopes / 22 links, 28 attempts, 2
  solutions) reflect ongoing preview QA between preflights, NOT this migration.
- **056–060 intact**: `get_quiz_review` sanitized via `_quiz_answers_learner_safe`;
  `submit_quiz_attempt_atomic_v2` keeps the solution snapshot; `archive_quiz_tag` retains the per-tenant
  advisory lock (060); `tenant_quizzes_select` + `quiz_attempts_tenant_read` policies present. Grants,
  RLS, tenant isolation and safe search_path unchanged; no unrelated schema/policy/trigger/data change;
  0 taxonomy triggers.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 25. This ledger update (rows 24–25) is intentionally left uncommitted.

## 2026-07-25 — Knowledge Heatmap canonical aggregation RPC (062)

Branch `feature/knowledge-heatmap` @ `e2cb621c809dceaf4a12b536c947d616e27f4aea`. Applied via one
controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
immediately before application. Additive read-only forward migration — does NOT edit applied
migrations 056–061.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 26 | `20260725034117` | 062_knowledge_heatmap_rpc | supabase/migrations/062_knowledge_heatmap_rpc.sql | e2cb621 | d678b7c211f2bfe6a932fea491aa83b5e09be0d167528d24f4ba4a4ffc5703ec | 2026-07-25 03:41:17 | PASS |

**What 062 adds (ONE `SECURITY DEFINER` function; `search_path=''`; EXECUTE=authenticated only,
anon/PUBLIC revoked):**
- `get_knowledge_heatmap(p_tenant_id uuid DEFAULT NULL)` — the single canonical topic-readiness
  aggregation for the manager Heatmap, learner Knowledge-by-Topic and rep drill-down. Attribution is
  ONLY the immutable attempt-time snapshots (`quiz_attempt_tag_snapshots` + `quiz_attempt_tags`); the
  mutable `quiz_tag_map` never rewrites history. Scores only from trusted attempts (`server_v2` +
  non-null score + snapshot envelope + active same-tenant learner); latest eligible attempt per
  learner×quiz; merged tags resolved transitively (cycle-safe, depth<32) + deduped on
  `(attempt, resolvedTag)`; multi-tag contributes once per topic, never summed into readiness.
- Full topic population: every ACTIVE tag is a manager row (no-evidence → `avgScore=null`, cells "—",
  never 0); plain-archived excluded; merged sources fold into their active target. Learners see only
  tags relevant via their own history/accessible quizzes. Every active learner is a column with the
  RPC-supplied authorized name (no `readiness_scores` dependence).
- Multi-tenant authorization: learner/orgAdmin/manager own-tenant only (foreign `p_tenant_id`
  rejected); ralli-admin may pass an explicit tenant; unknown/missing tenant rejected. Learners are
  self-scoped (no peer identities/metrics). Threshold from `tenant_settings.learning_settings`
  (`thresholdSource='tenant_settings'`) else 80 default (`'default'`), returned explicitly.

**Post-apply verification (read-only; production RPC invoked with `request.jwt.claims` impersonation,
raised-and-caught — no mutation):**
- Recorded version `20260725034117` / name `062_knowledge_heatmap_rpc`; exactly one 060/061/062 row
  each. Function present, `SECURITY DEFINER`, EXECUTE granted to `authenticated` (anon = 0).
- **Manager (orgAdmin DeAndre, own tenant)** output matched the preflight prediction exactly: topics
  `avanti` (avgScore 60, measured 1, learnersNoData 1, repsBelow 1) then `dre` (avgScore **null**,
  measured 0, learnersNoData 2, repScores []); learners **Amanda** + **avanti** with names; meta
  tenantId `0abdfcb1…`, totalActiveLearners 2, measuredLearners 1, totalAttempts 28,
  verifiedAttributed 3, legacyExcluded 19, awaitingClassification 6, threshold 93, thresholdSource
  `tenant_settings`.
- **Learner (avanti)**: self-only identity (`learners:[avanti]`, no peer), self-scoped meta
  (27/3/18/6); `avanti` topic avgScore 60 — **parity** with the manager cell for avanti.
- **ralli-admin (Avanti Fernandes, tenant NULL)** explicit `p_tenant_id=deandre-test` → the same
  2-topic / 2-learner TA matrix. **Rejections**: ralli-admin unknown tenant → `tenant not found`;
  orgAdmin and learner foreign tenant → `not authorized for the requested tenant`.
- No questions/answers/solutions/quiz content in any output (tag ids/labels/scores/counts/names only).
- **No data/objects changed by 062**: quiz_attempts 28, snapshots 22 / links 22, active tags 2,
  quiz_tag_map 3 — all unchanged. **056–061 intact**: `get_quiz_review` still sanitizes via
  `_quiz_answers_learner_safe`; `submit_quiz_attempt_atomic_v2` present; `tenant_quizzes_select` +
  `quiz_attempts_tenant_read` (057) present; snapshot-table RLS (059, manager/orgAdmin-only) present.
  No new policies/triggers; no unrelated schema change.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 26. This ledger update is intentionally left uncommitted.

## 2026-07-25 — Learn lifecycle integrity (063)

Branch `feature/learn-lifecycle-integrity` @ `80d5577c7703a973adb8ea7d75ed2d017cfa1daa`. Applied via
one controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
immediately before application. Additive forward migration — does NOT edit applied migrations
034/036/037/056–062.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 27 | `20260725130139` | 063_learn_lifecycle_integrity | supabase/migrations/063_learn_lifecycle_integrity.sql | 80d5577 | 682fa4ae43e8bd1bc42dab7eef9946e3eb39129ca4a867bfc8e0a0bd5af0d4ad | 2026-07-25 13:01:39 | PASS |

**What 063 adds:**
- `tenant_assignments.cancelled_at`/`cancelled_reason` (additive, nullable). A cancelled assignment is
  preserved for history but never active/overdue/pending and never blocks reassignment.
- Three `_*_assignment_active_user_ids` helpers replaced as faithful supersets of 036/037 (identical
  bodies + `AND ta.cancelled_at IS NULL`); `create_assignments_atomic` (034) delegates to them and is
  itself unchanged.
- Five `SECURITY DEFINER`, `search_path=''`, EXECUTE=authenticated (anon revoked) RPCs: `archive_lesson`
  (archives + cancels active assignments; blocks while the lesson is in an active course),
  `archive_course` (archives + cancels), `delete_lesson`/`delete_course` (block hard delete when
  referenced), `mark_lesson_complete` (server-authoritative tenant; cross-tenant/missing rejected).
- `lesson_completions_insert` RLS tightened to `WITH CHECK (profile_id = auth.uid() AND tenant_id =
  get_my_tenant_id())`.
- One-time, history-preserving backfill cancelling stranded/orphaned assignments.

**Post-apply verification (read-only; production RPCs invoked with impersonation, raised-and-caught —
no mutation):**
- Recorded version `20260725130139` / name `063_learn_lifecycle_integrity`; exactly one ledger row.
- `cancelled_at` + `cancelled_reason` present. All 5 RPCs present, `SECURITY DEFINER` + `search_path`,
  EXECUTE granted to authenticated (anon = 0). All 3 helpers contain `cancelled_at IS NULL`;
  `create_assignments_atomic` does NOT reference `cancelled_at` (unchanged). INSERT policy has both the
  profile and tenant checks.
- **Backfill cancelled exactly 7** stranded assignments: 4 archived-lesson, 1 missing-lesson,
  2 archived-course, 0 missing-course. **19 valid assignments remain uncancelled** (2 active-lesson +
  3 active-course + 14 quiz). NOTE: the preflight prose mis-summed these as "24"; the correct total is
  19 uncancelled (the per-category counts 2/3/14 were always correct) — 19 + 7 = 26 total, unchanged.
- **No rows deleted:** assignments 26, completions 5, quiz_attempts 28, lessons 8 (3 active / 5
  archived), courses 3 — all unchanged. Active course membership unchanged (1 member, 0 non-active).
- Learner archive/delete rejected ("only managers"); missing-content completion rejected ("lesson not
  found"); non-own-tenant completion rejected ("no active tenant"). True two-tenant cross-tenant
  rejection is proven by the 063 local harness.
- **056–062 intact**: `get_knowledge_heatmap`, `submit_quiz_attempt_atomic_v2`, `get_quiz_review`,
  `create_quiz_tag`, `merge_quiz_tags` all present. No quiz-grading/Ralli-Live/Heatmap/Readiness/Battle
  Card change; no migration history rewritten.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 27. This ledger update is intentionally left uncommitted.

## 2026-07-25 — Manager Unassign (064)

Branch `feature/learn-lifecycle-integrity` @ `41beef5` (approved artifact commit). Applied via ONE
controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob immediately
before application. Additive forward migration — does NOT edit applied migrations 017/034/036/037/063.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 28 | `20260725193232` | 064_manager_unassign | supabase/migrations/064_manager_unassign.sql | 41beef5 | 4b4e248432903a21fcabd54c9935430b738550207452591ec9bbf14a04fc5c84 | 2026-07-25 (version 20260725193232) | PASS |

Pre-apply gate: working-tree + committed(41beef5) SHA-256 both `4b4e2484…5c84` = approved hash;
byte-identical. Production had no `cancelled_by` column and no `unassign_assignment` function; 063
present exactly once; 064 absent.

Post-apply (read-only) evidence:
- Recorded version `20260725193232` / name `064_manager_unassign`; **exactly one** ledger row. 063 still
  exactly one row.
- `cancelled_by uuid` present; FK to `profiles(id)` with `ON DELETE SET NULL` (confdeltype `n`) — same
  retention model as `assigned_by`. 0 rows populated by the migration.
- `unassign_assignment(p_assignment_id uuid)` present; `SECURITY DEFINER`; `search_path = ""` (empty).
  EXECUTE granted to authenticated (+ owner/service_role); NOT anon/PUBLIC.
- **Hard-delete closed:** `tenant_assignments_delete` policy dropped; DELETE grantees now only
  `service_role, postgres` (authenticated + anon revoked). Tenant offboarding FK
  (`tenant_id → tenants ON DELETE CASCADE`) unchanged; service_role retains delete for maintenance.
- **No data mutated by the migration:** total cancelled = 13 (unchanged), manager_unassigned = 0,
  cancelled_by non-null = 0; active individual lesson = 2, quiz = 13 (unchanged).
- **063 objects intact:** `archive_lesson`, `mark_lesson_complete` present.

Functional verification (production, single self-aborting transaction — synthetic fixtures, final RAISE
forced full ROLLBACK, **zero residual data** confirmed afterward): all 12 checks PASS —
(1) not-completed lesson unassigned + server-set reason/actor; (2) failed quiz unassigned; (3) partial
course unassigned; (4) completed lesson refused; (5) full course refused; (6) passed quiz refused;
(7) idempotent retry → already_cancelled, ender preserved; (8) team-originated learner unassigned,
teammate row untouched; (9) source_* origin preserved; (10) learner refused ("only managers");
(11) cross-tenant refused ("not in your tenant"); (12) raw authenticated DELETE denied
("permission denied"), row intact. Residual synthetic tenants/profiles/assignments/auth.users = 0.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit
user production approval. Ledger row 28. Frontend NOT merged or deployed. This ledger update is
intentionally left uncommitted.

---

## 2026-07-26 — Quiz Archive / Restore + content-assignability guard (065) — **APPLIED TO PRODUCTION**

Branch `feature/learn-lifecycle-integrity`. Additive forward migration bringing quizzes to lifecycle
parity with lessons/courses (063): soft, reversible ARCHIVE replaces permanent delete; the raw
`tenant_quizzes` DELETE path is closed (RLS policy dropped + grant revoked); a restricted `delete_quiz`
RPC refuses any referenced quiz; `list_quizzes_for_learner` excludes archived; a one-time
history-preserving cleanup cancels active quiz assignments whose quiz is missing (`content_missing`).
**Rev 2** added the canonical content-assignability guard (`_assert_assignment_content_assignable` +
`BEFORE INSERT` trigger on `tenant_assignments`) covering lesson/course/quiz, after a preflight proved
an archive-vs-assign race. The guard LOCKS the content row `FOR SHARE` by (id, tenant) then checks
status='active', serializing with `archive_quiz`/`restore_quiz` (FOR UPDATE) and `archive_lesson`/
`archive_course` (UPDATE = FOR NO KEY UPDATE).
**Rev 3** closes two residual integrity gaps a further preflight found: (a) removed the `cancelled_at`
carve-out — EVERY insert is now validated (a client-supplied column could otherwise fabricate historical
rows against non-active content); (b) closed the raw client INSERT path — drop the `tenant_assignments_insert`
RLS policy + REVOKE INSERT from authenticated/anon, so the ONLY assignment-creation path is
`create_assignments_atomic` (SECURITY DEFINER, owner `postgres`/bypassrls), which alone enforces the
instance-aware duplicate-active/eligibility rules. Mirrors 064's DELETE closure. Does NOT edit any applied migration.

Applied via ONE controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed
blob (`7844968`) immediately before application. No `db push`, no repair, no manual ledger SQL — a single
production write call.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 29 | `20260726145532` | 065_quiz_archive_restore | supabase/migrations/065_quiz_archive_restore.sql | 7844968 | b65d918c6fc7e331b724ad90d9a0983b57c81f95a6f67195657b27b0d0e01bb2 | 2026-07-26 (version 20260726145532) | PASS — see below |

Pre-apply gate (read-only): working-tree + committed(`7844968`) SHA-256 both `b65d918c…1bb2` = approved
hash. 065 absent; 063 & 064 each present once. Active-assignment→non-active-content = lesson 0 / course 0
/ missing-quiz **2**; no active assignment to an existing non-active quiz.

**Structural / security verification (all read-only, post-apply):**
- Ledger version `20260726145532` / name `065_quiz_archive_restore`; **exactly one** row. 063 & 064 still
  one each.
- `tenant_quizzes_status_check` = `active|inactive|draft|archived` (additive; all existing rows still
  `active` — no status rewritten).
- `archive_quiz(p_quiz_id uuid)`, `restore_quiz(p_quiz_id uuid)`, `delete_quiz(p_quiz_id uuid)` — all
  `SECURITY DEFINER`, approved signatures.
- `_assert_assignment_content_assignable()` present **once**; trigger `trg_assert_assignment_content_assignable`
  = BEFORE INSERT, enabled. Guard body covers `tenant_lessons` + `tenant_courses` + `tenant_quizzes`, has
  **no** `cancelled_at` carve-out, uses `FOR SHARE` (lock-then-status-check).
- **tenant_assignments INSERT**: grantees now `postgres, service_role` only (authenticated/anon revoked);
  `tenant_assignments_insert` policy **gone**.
- **tenant_quizzes DELETE**: grantees now `postgres, service_role` only (authenticated/anon revoked);
  `tenant_quizzes_delete` policy **gone**.
- `create_assignments_atomic` still `SECURITY DEFINER`, owner `postgres` — inserts unaffected.
- `list_quizzes_for_learner` excludes archived (`status <> 'archived'`) and remains learner-safe (no answer
  keys). `get_quiz_for_attempt` / `get_quiz_review` unchanged (no `correct`/`acceptedAnswers`/`tolerance`/`pairs`).
- Data preserved: quizzes 4, quiz_attempts 29, attempt_solution_snapshots 7, quiz_tag_map 4,
  quiz_attempt_tag_snapshots 27, quiz_attempt_tags 32, tenant_quiz_tags 3 — none deleted.

**Cleanup evidence (exactly as predicted):** `content_missing` cancellations = **2** (rows preserved,
`assigned_to` intact, no title fabricated); remaining active missing-quiz orphans = **0**; valid-quiz
active assignments still **12**; non-quiz rows wrongly cancelled = **0**; no attempts/snapshots/tags/analytics
removed. Idempotent (predicate now matches 0 candidates).

**Functional verification (production, ONE self-aborting transaction — synthetic fixtures, final RAISE
forced full ROLLBACK, zero residual data confirmed):** all 21 checks PASS — active lesson/course/quiz
assign via `create_assignments_atomic`; archived/missing/cross-tenant content refused; same-learner
duplicate skipped; different learner separate row; archive cancels 2 active; restore does not reactivate;
reassign after restore succeeds; `delete_quiz` refuses referenced; learner cannot archive/restore/delete;
cross-tenant archive/restore/delete refused; raw authenticated INSERT and raw authenticated quiz DELETE
both `permission denied`. Residual synthetic users/tenants/quizzes/assignments = **0**.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit user
production approval. Ledger row 29. **Frontend NOT merged or deployed.** This ledger update is intentionally
left uncommitted.

---

## 2026-07-28 — Archive must not cancel COMPLETED assignments (066) — **APPLIED TO PRODUCTION**

Branch `feature/learn-lifecycle-integrity`. Forward, additive; does NOT edit applied 063/065.
DEFECT (live QA): `archive_lesson`/`archive_course`/`archive_quiz` cancelled EVERY `cancelled_at IS NULL`
row — including already-completed/passed ones — so the archive "cancelled" count was inflated (a quiz
reported 11 when only 2 were unresolved) and completed history became `content_archived`, hiding manager
scores. Production reconciliation of the archived quiz "Dre's Quiz" (`5a952aba…`): 12 instances, 11
cancelled `content_archived`, of which **9 were Completed** (passing attempt ≥ assigned_at, before the
archive) and only 2 were genuinely not-started.

066: (1) CREATE OR REPLACE the three archive RPCs so the cancellation UPDATE cancels ONLY unresolved
instances (instance-aware completion per row: quiz=passing attempt≥assigned_at, lesson=completion≥assigned_at,
course=all member lessons completed≥assigned_at) and returns the true unresolved count; (2) one-time,
idempotent repair clearing the wrongful `content_archived` cancellation on individual rows that were
completed BEFORE their own cancelled_at.

Applied via ONE controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
(`6603255`) immediately before application. No `db push`, no repair, no manual ledger SQL — a single
production write call.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 30 | `20260728024514` | 066_archive_completed_assignment_integrity | supabase/migrations/066_archive_completed_assignment_integrity.sql | 6603255 | fca97901e3c889994753105d8455d4adb998bb5ca3f7638b6cae92d52c8c9ac9 | 2026-07-28 (version 20260728024514) | PASS — see below |

Pre-apply gate (read-only): working-tree + committed(`6603255`) SHA-256 both `fca97901…9ac9` = approved.
066 absent; 063/064/065 each once; repair candidates lesson 1 / course 0 / quiz 9 (total 10).

**Structural / security verification (read-only, post-apply):**
- Ledger version `20260728024514`; **exactly one** row. 063/064/065 still one each.
- `archive_quiz`/`archive_lesson`/`archive_course` now completion-aware (quiz `passed IS TRUE ≥ assigned_at`;
  lesson completion `≥ assigned_at`; course `v_req>0 AND all member lessons ≥ assigned_at`). Auth, tenant
  scope, `archive_quiz` `FOR UPDATE` lock, `search_path=''`, return shape, and EXECUTE grants
  (authenticated + owner/service_role; anon/public revoked) all preserved.
- 065 protections unchanged: guard trigger `trg_assert_assignment_content_assignable` present;
  `tenant_assignments` INSERT = `postgres, service_role` only + policy gone; `tenant_quizzes` DELETE =
  `postgres, service_role` only.

**Repair evidence (read-only, post-apply):** exactly **lesson 1 / course 0 / quiz 9 = 10** rows repaired;
`remaining_repairable = 0` (no completed-before-cancel `content_archived` row left). The 9 "Dre's Quiz"
rows now resolve **Completed** (uncancelled + passing attempt); its 2 remaining `content_archived` rows are
the 1 genuinely not-started + 1 legacy aggregate (untouched). Untouched globally: `manager_unassigned` = 8,
`content_missing` = 2; attempts (30) and completions (6) preserved — 066 has no DELETE/DROP/ALTER, only 3
`CREATE OR REPLACE` + 3 repair UPDATEs.

**Functional verification (production, ONE self-aborting transaction — synthetic fixtures, final RAISE →
full ROLLBACK, zero residual data confirmed):** all 17 checks PASS — quiz cancels only 2 unresolved
(passed stays Completed with score 90); idempotent re-archive; restore does not reactivate; fresh
reassignment after restore; lesson cancels only unresolved (completed stays); full course count 0 (stays),
partial course 1, empty course 1 (never completed); learner cannot archive; cross-tenant archive refused.
Residual synthetic users/tenants/assignments/quizzes = **0**.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool, under explicit user
production approval. Ledger row 30. **Frontend NOT merged or deployed.** This ledger update is intentionally
left uncommitted.

---

## 2026-07-28 — Learner-safe completed-quiz history (067) — **APPLIED TO PRODUCTION**

Branch `feature/learn-lifecycle-integrity`. Additive forward; creates ONE function, changes no table/policy/RPC.
WHY REQUIRED (live QA): after a manager archives a quiz, 065 correctly drops it from the learner ACTIVE
catalog (`list_quizzes_for_learner` filters status<>'archived') and 057 forbids a learner from SELECTing
`tenant_quizzes`; 066 keeps a learner's COMPLETED assignment active. The learner's browser then had no safe
way to get the archived quiz's TITLE, so the completed row lost its content and vanished from Completed/All.
Existing safe sources are insufficient: `list_quizzes_for_learner` (excludes archived), `list_my_quiz_attempts_safe`
(no name/title), `get_quiz_review` (per-attempt, pass-gated, not a list). Lessons/courses DON'T need this —
`tenant_lessons`/`tenant_courses` SELECT RLS already lets an in-tenant learner read archived rows; only quizzes
are RLS-locked.

067: `list_my_completed_quiz_history()` SECURITY DEFINER — the caller's OWN passed quizzes (incl archived) with
**catalog metadata ONLY** (id, name, status, passing_score). **Rev 2 (misattribution audit):** removed the
per-quiz `best_score`/`last_passed_at`/`passed` aggregate fields — an assignment-instance's score/date is NOT a
lifetime-per-quiz value (a quiz can be reassigned and re-passed at a different score/date), so those are resolved
CLIENT-SIDE from instance-scoped attempts (best PASSING attempt with created_at ≥ that instance's assigned_at,
via `resolveLearnerAssignments`), never from this RPC. `name` is CURRENT catalog metadata (renameable), not an
immutable historical title; immutable questions/answers stay behind the pass-gated `get_quiz_review` snapshot.
No questions/answers, no other learner's rows, tenant+learner enforced server-side, HISTORY only (never makes
archived content startable/searchable, never weakens 065's active-catalog exclusion).

Applied via ONE controlled `apply_migration` (Strategy A); SHA-256 re-confirmed against the committed blob
(`b579209`) immediately before application. No `db push`, no repair, no manual ledger SQL — a single production
write call.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 31 | `20260728131451` | 067_learner_completed_quiz_history | supabase/migrations/067_learner_completed_quiz_history.sql | b579209 | 3ec2fdc58e1ccd238fcad15718b3698b1a11f61ab85494c23899620397d72e72 | 2026-07-28 (version 20260728131451) | PASS — see below |

Pre-apply gate (read-only): working-tree + committed(`b579209`) SHA-256 both `3ec2fdc5…d72e72` = approved. 067
absent (ledger + function); deps present (tenant_quizzes 5 cols / profiles 3 / quiz_attempts 3). Exact
predicted output = **3 distinct (user,quiz) rows** (1 distinct learner × 3 passed quizzes), 0 cross-tenant.

**Structural / security verification (read-only, post-apply):**
- Ledger version `20260728131451`; **exactly one** row. Function `list_my_completed_quiz_history()` present once,
  `SECURITY DEFINER`, `search_path=""`, owner `postgres`. EXECUTE = `authenticated, postgres, service_role`
  (anon/PUBLIC denied). No trigger/policy/table created (function-only); confidentiality/065/066 objects
  untouched (`get_quiz_review` clean, `list_quizzes_for_learner` still excludes archived, guard trigger present,
  `archive_quiz` completion-aware). 067 has **no DML** — no data rows/policies/triggers/unrelated schema changed.
- Functional (production, ONE self-aborting read-only transaction — rolled back): called as the real passing
  learner → returns **exactly 3 rows**, each with EXACTLY `{id,name,status,passing_score}`; every row is in the
  caller's tenant AND a quiz the caller PASSED; a failed-only quiz is absent; a different/unknown authenticated
  user gets `[]` (caller-only, tenant-only, passed-only; cross-user + cross-tenant excluded).
- `name` is CURRENT catalog metadata (renameable), not an immutable historical title; immutable questions/answers
  remain behind the pass-gated `get_quiz_review` snapshot. Per-attempt score/date are NOT returned (resolved
  client-side, instance-scoped) — no reassignment misattribution.

Regression: 067 SQL 2/2, 055/056/057/063/064/065/066 SQL suites, engine reassignment-trap tests, JS suites, and
production build all PASS (this session, against the byte-identical 067). Operator: applied by Claude Code via
the controlled `apply_migration` tool under explicit user approval. Ledger row 31. **Frontend NOT merged or
deployed.** This ledger update is intentionally left uncommitted.

## 2026-07-28 — Learn closeout: committing the applied-migration records (063–067)

The per-migration blocks above (rows 27–31) each end with the standard apply-time footer "This ledger
update is intentionally left uncommitted." That footer described the state at apply time. As part of the
Learn merge-readiness closeout, those factual applied-migration records are now committed to the branch,
which supersedes those per-block "left uncommitted" notes. Nothing in the records themselves changed —
production migrations 063–067 remain applied exactly once each (versions `20260725130139`,
`20260725193232`, `20260726145532`, `20260728024514`, `20260728131451`) and byte-identical to the
committed migration files (SHA-256 parity re-verified at closeout; migration history unchanged, nothing
rewritten/squashed/reordered). No new migration was applied during closeout; the only branch changes at
closeout are frontend (sign-out navigation-state clearing) plus this ledger commit.

## 2026-07-28 — Battle Card lifecycle + provenance + RLS/DELETE hardening (068) — **APPLIED TO PRODUCTION**

Branch `feature/battle-cards-audit` @ `0244cd2`. Applied via ONE controlled `apply_migration` (Strategy A)
after a passing immediate pre-apply gate; byte-identity re-confirmed against the committed blob. Additive —
does NOT edit applied migrations 023/030; touches only `tenant_battle_cards` + `tenant_bc_categories`.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 32 | `20260728175949` | 068_battle_card_lifecycle | supabase/migrations/068_battle_card_lifecycle.sql | 0244cd2 | a62c2c5c40d9b8c9b6da762a94c2707096d3600c344e20b152900ee785e1da81 | 2026-07-28 (version 20260728175949) | PASS — see below |

Approved SHA-256: `a62c2c5c40d9b8c9b6da762a94c2707096d3600c344e20b152900ee785e1da81`. Apply result: `{"success":true}`.

**What 068 adds:** `tenant_battle_cards.status` ('active'|'archived', default 'active', CHECK) + `archived_at`
+ `updated_by`; `tenant_bc_categories.updated_by`; index `idx_bc_cards_tenant_status`; server-authoritative
provenance triggers (`tenant_battle_cards_touch`/`tenant_bc_categories_touch`) making created_by/created_at
immutable on edit and updated_by/updated_at/archived_at server-owned; SELECT RLS learner-active-only; UPDATE
RLS `WITH CHECK` on both tables; DROP `bc_cards_admin_delete` + REVOKE DELETE on cards from authenticated/anon.

**Pre-apply gate (all PASS):** committed + working-tree SHA-256 both `a62c2c5c…da81`; 068 absent from ledger
(max `20260728131451`); new objects absent; production had exactly 0 cards / 1 valid category; DELETE policy
`bc_cards_admin_delete` + authenticated/anon DELETE grants present as preflighted; schema/deps intact.

**Post-apply verification (read-only):**
- Recorded version `20260728175949` / name `068_battle_card_lifecycle`; **exactly one** row; no migration
  applied beyond 068.
- New columns present as committed (status NOT NULL default 'active'; archived_at, updated_by nullable);
  constraint + index + both functions + both triggers exist.
- Card count still **0**. The single category unchanged except `updated_by = NULL` (label/tenant/created_by/
  created_at/updated_at all unchanged; ADD COLUMN did not fire the trigger).
- Final policy set: SELECT `bc_cards_tenant_read` (ralli_admin all; else own-tenant AND (active OR
  orgAdmin/manager)); UPDATE `bc_cards_admin_update`/`bc_categories_admin_update` now carry `WITH CHECK`;
  `bc_cards_admin_delete` **absent**; INSERT/category SELECT/category DELETE unchanged.
- Cards DELETE grants now only `postgres`, `service_role` (authenticated + anon revoked) → no client hard
  delete; emergency owner/service-role delete retained. `bc_categories_admin_delete` unchanged.
- Behavioral proof (068 SQL harness, transactional/rolled back, against a local DB built from the applied
  migration): 22/22 PASS incl. learner active-only + tenant-scoped SELECT, learner writes fail, cross-tenant
  read/write/move fail, WITH CHECK blocks tenant movement, created_by/created_at immutable on edit,
  server-controlled updated_by/updated_at/archived_at, and manager/orgAdmin/learner/anon/cross-tenant direct
  DELETE all fail with the row surviving.
- Regressions 057/063/065/066/067 SQL, JS suite (incl. 34 bc guards), esbuild parse, and Vite build all PASS.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool under explicit user
production approval. Ledger row 32. **Frontend NOT merged or deployed** — next step is live Battle Cards QA
on the preview. This ledger update is intentionally left uncommitted.

## 2026-07-28 — Battle Cards taxonomy → tags only: category→tag conversion (069) — **APPLIED TO PRODUCTION**

Branch `feature/battle-cards-audit` @ `9ac7202` (migration authored at `394a6e3`; the
`9ac7202` commit is a test-only idempotency assertion — migration bytes unchanged).
Applied via ONE controlled `apply_migration` (Strategy A) after a passing immediate
pre-apply gate; byte-identity re-confirmed. Data-only; does NOT edit migrations 023/030
or 068; touches only `tenant_battle_cards` rows (reads `tenant_bc_categories`).

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 33 | `20260728232125` | 069_battle_card_category_to_tag | supabase/migrations/069_battle_card_category_to_tag.sql | 394a6e3 | d88b7135fdc1a854e54c88ac24cb47eff1e0665ab17f593e2500ffe682acbdd3 | 2026-07-28 (version 20260728232125) | PASS — see below |
| 34 | `20260729151513` | 070_battle_card_required_content | supabase/migrations/070_battle_card_required_content.sql | 776a947 | eff95a4c1ffef85adff39ff41d02d631ccd3c10c722cf7fcb2645fec6e02d698 | 2026-07-29 (version 20260729151513) | PASS — see below |

Approved SHA-256: `d88b7135fdc1a854e54c88ac24cb47eff1e0665ab17f593e2500ffe682acbdd3`. Apply result: `{"success":true}`.

**What 069 does:** for every card with a VALID category association, fold the category
label into tags (normalized + case-insensitive de-dupe; existing tags never overwritten;
blank labels skipped), then clear `category_id`. Cards without a category are untouched
(no invented tag). The 068 provenance trigger is briefly DISABLEd (ACCESS EXCLUSIVE lock,
same-transaction ENABLE) so only tags + category_id change — created_by/created_at/
updated_by/updated_at preserved. Legacy `tenant_bc_categories` table kept intact.

**Pre-apply gate (all PASS):** committed + working-tree SHA-256 both `d88b7135…bdd3`; 069
absent from ledger (max `20260728175949`); 068 present once + trigger enabled; production
had exactly 2 cards (`528e1a06` cat=`33ef0261` tags=[personality]; `ff7b4997` cat=null
tags=[]) and 1 category (`33ef0261` "tag 1"); no partial conversion / schema drift.

**Post-apply verification (read-only):**
- Recorded version `20260728232125` / name `069_battle_card_category_to_tag`; exactly one
  row; **no migration beyond 069** (33 total).
- `528e1a06` tags = **`["personality","tag 1"]`**, `category_id` = null; id/title/content/
  status/tenant/created_by(45a62442)/updated_by(45a62442)/created_at(18:43:41.635689)/
  updated_at(**22:37:08.770177 unchanged**) all preserved.
- `ff7b4997` remains **tagless** (`[]`), `category_id` = null, all provenance/timestamps
  unchanged — no tag invented for the tagless card.
- **Every** Battle Card `category_id` is null. Category `33ef0261` "tag 1" **unchanged**
  (label/tenant/creator/updater/timestamps identical); category table + 4 RLS policies intact.
- 068 protections unchanged: provenance trigger finishes **enabled** (`tgenabled='O'`);
  status column present; `bc_cards_admin_delete` absent; cards DELETE grants = `postgres`,
  `service_role` only; learner active-only SELECT policy present. No unrelated policies/
  grants/functions/triggers/data changed.
- Re-running the conversion is a **no-op** (production match set = 0 rows; committed 069
  test T9 proves idempotency; second pass updates 0 rows, tags/category_id/provenance stable).
- Tests: committed 069 harness 9/9, 068 harness 22/22, 057/065/066/067 regressions, JS
  suite (46 bc guards), esbuild parse, Vite build — all PASS.

Operator: applied by Claude Code via the controlled Supabase `apply_migration` tool under
explicit user production approval. Ledger row 33. **Frontend NOT merged or deployed** —
next step is live tags-only Battle Cards QA on the preview. This ledger update is
intentionally left uncommitted.

---

## Migration 070 — Battle Card required-content enforcement (row 34)

Approved artifact: commit `776a947799a8fa6fccfc13a4c9443805deb8b366`, file
`supabase/migrations/070_battle_card_required_content.sql`, SHA-256
`eff95a4c1ffef85adff39ff41d02d631ccd3c10c722cf7fcb2645fec6e02d698`.
Apply result: `{"success":true}`. Production version **`20260729151513`**.

**What 070 does:** adds one IMMUTABLE helper `battle_card_has_meaningful_text(text)`
(mirrors the frontend `bcPlainText`; based on the real `htmlToMd` markdown-subset —
false for null/blank/whitespace/U+00A0/line-breaks/empty formatting `****`,`__ __`/empty
lists `- `,`1. `; true for real text) and one `BEFORE INSERT/UPDATE` trigger
`trg_battle_cards_require_content` on `tenant_battle_cards`. Enforcement runs ONLY for the
untrusted client roles (`authenticated`,`anon`); `postgres`/`service_role` are exempt.
INSERT requires all five (Title, ≥1 tag, Their Strengths, Their Weaknesses, Why We Win);
UPDATE is non-regression (a field valid on OLD must stay valid on NEW). Subtitle, Summary,
Talk Track, In-Depth remain optional. Purely additive — no column/policy/grant/data change.

**Pre-apply gate (all PASS):** committed + working-tree SHA-256 both `eff95a4c…e02d698`;
070 absent from ledger (max `20260728232125`); 068 + 069 present once; no conflicting
helper/trigger/CHECK; production had exactly 5 cards (3 valid: `528e1a06`,`ec5e7e27`,
`3c6cd1a1`; 2 legacy-incomplete: `302e519c`,`ff7b4997` — strength/weakness/our_win len 0);
068 provenance trigger enabled; no DELETE grant for authenticated/anon; single tenant
`0abdfcb1`; no SECURITY DEFINER writer, no edge functions (no service-role write proxy).

**Post-apply verification (read-only + one BEGIN…ROLLBACK behavioral pass):**
- Recorded version `20260729151513` / name `070_battle_card_required_content`; exactly one
  row; **no migration beyond 070**.
- Both functions exist as committed (SECURITY INVOKER; helper IMMUTABLE + PARALLEL SAFE;
  `search_path=""` on both). Trigger `trg_battle_cards_require_content` **enabled** (`O`),
  ROW BEFORE INSERT/UPDATE (tgtype 23), sorts before `trg_touch_tenant_battle_cards`.
- 068 provenance trigger remains **enabled** (`O`).
- All 5 existing cards **byte-for-byte unchanged** — id/title/status/tags/content_md5/
  created_by/updated_by/created_at/**updated_at** identical to the pre-apply snapshot (the
  DDL rewrote no rows; the touch trigger did not fire). 3 valid / 2 legacy-incomplete
  unchanged; both legacy bodies still len 0.
- Behavioral matrix against production (ephemeral fixtures, rolled back → nothing persisted;
  5 cards, 0 test rows, 2 legacy still empty afterwards): valid authenticated INSERT
  succeeds w/ server-set created_by; invalid INSERT (formatting-only body / blank·null tags
  / blank title) rejected; archived+invalid INSERT rejected; valid→invalid UPDATE (blank a
  good field / remove last tag) rejected; incomplete-legacy archive/restore/retag/metadata
  succeed; removing the legacy last tag rejected; legacy full correction succeeds and cannot
  then regress; service_role/owner exemption holds (owner blank-body insert succeeds);
  learner + anon INSERT rejected; cross-tenant UPDATE affects 0 rows; orgAdmin valid INSERT
  succeeds; manager hard-delete rejected.
- No unrelated change: exactly 2 triggers + 3 policies on the table; grants/functions/
  migrations otherwise unchanged.
- Tests: committed 070 harness 12/12, 068 harness 22/22, 069 harness 9/9 (local, 070
  applied); JS suite 155/155 incl. Leadership declaration guard; esbuild parse; Vite build —
  all PASS.

Operator: applied by Claude Code via exactly one controlled Supabase `apply_migration`
call under explicit user production approval (no db push / repair / manual ledger SQL /
fallback). Ledger row 34. **Frontend NOT merged or deployed** — next step is final Battle
Cards live QA and merge readiness. This ledger update is intentionally left uncommitted.

---

## 2026-07-30 — Ralli Live team-at-game-time snapshot / leaderboard trust foundation (071) — **APPLIED TO PRODUCTION**

Branch `feature/ralli-live-leaderboard` @ `ac6cd2c`. Applied via EXACTLY ONE controlled
`apply_migration` (Strategy A) after a passing immediate pre-apply gate; byte-identity
re-confirmed against the committed blob. Additive — does NOT edit any applied migration;
touches only Ralli Live `game_players` (two nullable columns + one BEFORE INSERT/UPDATE
trigger). **This slice ships the trust foundation ONLY** — the leaderboard read RPC and UI
remain BLOCKED on the server-authoritative grading decision (see
`docs/engineering/071_LEADERBOARD_DESIGN.md §1`).

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 35 | `20260730002403` | 071_game_team_snapshot | supabase/migrations/071_game_team_snapshot.sql | ac6cd2c | 07450d812fcf9fd822d5b0e0c56d3b14fbb7f75ce47256b2e33a6280fd75fcbb | 2026-07-30 (version 20260730002403) | PASS — see below |

Approved SHA-256: `07450d812fcf9fd822d5b0e0c56d3b14fbb7f75ce47256b2e33a6280fd75fcbb`. Apply result: `{"success":true}`.

**What 071 adds:** `game_players.team_id uuid` + `team_name text` (both nullable, additive,
**no FK** — so a later `tenant_teams` deletion can never erase a historical snapshot); one
SECURITY DEFINER (`search_path=''`) function `game_players_stamp_team()` + BEFORE INSERT/UPDATE
trigger `trg_game_players_stamp_team`. On INSERT the trigger stamps team_id/team_name from the
`player_id`'s SAME-TENANT profile (client-supplied values ignored/overwritten; NULL for
guests / name-based ids / no-team / cross-tenant / no-tenant). On UPDATE it freezes **ONLY**
team_id/team_name (never `NEW := OLD`) — every other column (final_score, final_rank, accuracy,
name, emoji, color, future fields) passes through unchanged. No historical backfill.

**Immediate pre-apply gate (all 7 PASS):** working-tree bytes = approved SHA `07450d81…fdb`;
071 absent from ledger (max `20260728232125`… i.e. beyond 070 `20260729151513`, nothing ≥071)
and both objects absent; no conflicting team_id/team_name columns, function, or trigger; **21**
historical `game_players` rows; migrations ≤070 unchanged; RLS enabled + 2 policies
(`anon_all_game_players`, `auth_all_game_players`) / grants exactly as preflighted; no active
schema drift / in-progress migration.

**Structural / security verification (read-only, post-apply):**
- Recorded version `20260730002403` / name `071_game_team_snapshot`; **exactly one** row; **no
  migration applied beyond 071**.
- `team_id` uuid nullable + `team_name` text nullable present. Function `game_players_stamp_team()`
  present, **SECURITY DEFINER=true**, empty `search_path`, VOLATILE. Trigger
  `trg_game_players_stamp_team` **enabled**, ROW BEFORE INSERT/UPDATE (tgtype 23).
- **All 21 historical rows have team_id = NULL AND team_name = NULL** (no backfill); every
  historical row's prior columns/timestamps **unchanged** — existing-columns fingerprint
  `960041aab30e2b3364acb59ea5305e0a`, byte-identical to the pre-apply snapshot (the DDL rewrote
  no rows; the trigger did not fire on ADD COLUMN).
- RLS remains enabled; the 2 pre-existing policies intact; grants unchanged. No unrelated
  schema / policy / grant / trigger / data change.

**Behavioral matrix against production (ONE `BEGIN…ROLLBACK` pass — ephemeral fixtures, rolled
back → nothing persisted; confirmed afterward: 21 rows, 0 non-null snapshots, 0 fixture
rows/tenants/teams/users):** `PROD_071_BEHAVIOR_ALL_PASSED` — valid authenticated INSERT captures
the same-tenant completion-time team (id + name); guest / no-team / cross-tenant → NULL;
client-supplied team_id/team_name ignored (overwritten from the profile); legacy TEXT tenant
(`org_momence`) does not throw and yields NULL; UPDATE cannot change team_id/team_name; UPDATE
CAN change final_score/final_rank/accuracy/name/emoji/color; a team transfer (profile.team_id
change) does not rewrite the existing snapshot; a later NEW game for the transferred player
captures the NEW team; a team rename does not rewrite the historical snapshot; a team DELETION
does not erase the snapshot (team_id/team_name survive — no FK).

- Tests (local, against the byte-identical `ac6cd2c` bytes): committed 071 harness **12/12**;
  SQL regressions 054–070 **17/17**; 065 concurrency suite PASS; JS suite **13/13**; esbuild
  parse; Vite build — all PASS.

Operator: applied by Claude Code via exactly one controlled Supabase `apply_migration` call
under explicit user production approval (no db push / repair / manual ledger SQL / fallback; no
other migration applied; frontend NOT merged or deployed). Ledger row 35. **Leaderboard read
RPC + UI remain BLOCKED** pending the server-authoritative grading/verification foundation (the
next approved phase). This ledger update is intentionally left uncommitted.

---

## 2026-07-30 — Ralli Live learner-safe read RPCs (073) — **APPLIED TO PRODUCTION**

Branch `feature/ralli-live-leaderboard` @ `4bb4c08`. Applied via EXACTLY ONE controlled
`apply_migration` (Strategy A) after a passing immediate pre-apply gate; byte-identity
re-confirmed against the committed blob. **Additive only** — creates three SECURITY DEFINER
learner-safe read RPCs; does NOT edit any prior migration, drop any policy, revoke any table
permission, or change any gameplay data. NOTE: migration **072 remains UNAPPLIED** (073 has no
dependency on 072 — it needs only existing tables + `get_my_tenant_id` + `auth.uid`, all present).

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 36 | `20260730154929` | 073_ralli_learner_safe_reads | supabase/migrations/073_ralli_learner_safe_reads.sql | 4bb4c08 | d2e3d331e48646c28bc982903ce8351d146056a9e37ec8e7a47aedd54051a757 | 2026-07-30 (version 20260730154929) | PASS — see below |

Approved SHA-256: `d2e3d331e48646c28bc982903ce8351d146056a9e37ec8e7a47aedd54051a757`. Apply result: `{"success":true}`.

**Pre-apply gate (all PASS):** working-tree == committed(`4bb4c08`) bytes IDENTICAL; SHA-256 both
`d2e3d331…4051a757` = approved; 073 absent from ledger (max was `20260730002403`); all three RPC
names absent; tables/columns/roles/`get_my_tenant_id`/`auth.uid` present; migration contains no
DML/backfill/DROP POLICY/table REVOKE/gameplay mutation (only new-function EXECUTE scoping).

**What 073 adds (3 functions; SECURITY DEFINER; `search_path=''`):**
- `rpc_player_session_restore(uuid)` — active-player reconnect: durable phase/state + the
  already-sanitized `live_question` + the caller's OWN per-question points/correctness; never
  `question_snapshot`, never another player's answer. Participant-only (participant row or own
  answer) AND same-tenant. EXECUTE = authenticated, service_role (anon explicitly revoked).
- `rpc_my_completed_session_review(uuid)` — participant-only review of a durably COMPLETED
  session: snapshot (post-completion) + OWN answers + player count. EXECUTE = authenticated,
  service_role (anon retains the Supabase schema-default EXECUTE but the body rejects anon via
  `auth.uid()` null → "authentication required").
- `rpc_list_my_game_history(int)` — the caller's OWN game_players rows + session display metadata;
  identity from `auth.uid()`; no player-id parameter. Same anon note as review.

**Structural verification (read-only, post-apply):**
- Recorded version `20260730154929` / name `073_ralli_learner_safe_reads`; **exactly one** row;
  nothing beyond it. All three functions present with approved signatures, `prosecdef=true`,
  `search_path=""`. `authenticated` holds EXECUTE on all three; **anon EXECUTE on
  rpc_player_session_restore = false** (revoked). game_sessions (6) + game_answers (2) RLS
  policies intact; `authenticated` SELECT on game_sessions still granted (NOT revoked). Gameplay
  counts unchanged: sessions 58 / answers 89 / players 21.

**Behavioral verification (production, ONE `BEGIN…ROLLBACK`, ephemeral identities, rolled back —
0 residual test users/sessions afterward):** `PROD_073_BEHAVIOR_ALL_PASSED` — participant restore
returns own answers only + no `question_snapshot`; same-tenant non-participant denied;
cross-tenant denied; completed review (participant + completed) returns snapshot + own answers;
review on a non-completed session denied; non-participant review denied; own history derived from
`auth.uid()` (own rows only); anon on review/history functionally denied ("authentication
required").

**Known follow-up (does NOT block 073; blocks calling the frontend production-ready):**
`rpc_my_completed_session_review` / `rpc_list_my_game_history` retain the Supabase schema-default
anon EXECUTE grant (my `REVOKE … FROM PUBLIC` did not remove the explicit anon default grant);
anon is functionally denied by the body but a future additive `REVOKE … FROM anon` should tighten
this to grant-level parity with `restore`.

Operator: applied by Claude Code via exactly one controlled Supabase `apply_migration` call under
explicit user production approval (no db push / repair / manual ledger SQL / fallback; no other
migration applied). Ledger row 36. **Frontend NOT pushed or deployed** (commit `4bb4c08` held).
Migration 072 verification foundation remains unapplied. This ledger update is intentionally left uncommitted.

## 2026-07-30 — Area (Ralli Live learner-safe reads) — 074 anon-grant hardening

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. Closes the 073 follow-up: brings
`rpc_my_completed_session_review` / `rpc_list_my_game_history` to grant-level parity with
`rpc_player_session_restore` by revoking the explicit Supabase schema-default anon EXECUTE grant.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 37 | `20260730180007` | 074_revoke_anon_ralli_read_rpcs | supabase/migrations/074_revoke_anon_ralli_read_rpcs.sql | `887698f` | fc6d44b3e8b7b36a8b83941cde005be3f16f6b716da401e0e3384101007a2574 | 2026-07-30 18:00:07 | PASS |

**Pre-apply gate (immediately before applying):** committed-bytes SHA-256 re-confirmed
`fc6d44b3…07007a2574` (working tree == HEAD, clean); anon EXECUTE = **true**, authenticated +
service_role = **true** on both target RPCs; 074 absent from `schema_migrations`.

**Structural verification (read-only, post-apply):**
- Recorded version `20260730180007` / name `074_revoke_anon_ralli_read_rpcs`; **exactly one** row.
- `rpc_my_completed_session_review(uuid)` and `rpc_list_my_game_history(integer)`: anon EXECUTE =
  **false**; authenticated + service_role EXECUTE = **true**. Both ACLs now
  `postgres=X/postgres | authenticated=X/postgres | service_role=X/postgres` — **identical** to
  `rpc_player_session_restore(uuid)` (parity achieved; no anon entry remains, no PUBLIC grant).
- No unrelated change: `game_sessions` (6) + `game_answers` (2) RLS policies intact; `authenticated`
  SELECT on `game_sessions` still granted; no function body/signature altered; no table grant,
  data, or unrelated function ACL changed (migration is two `REVOKE EXECUTE … FROM anon` statements
  only).

**Frontend compatibility:** both RPCs are invoked only from authenticated real-user paths
(`listMyGameHistory` behind a `currentUser._isReal` guard; `getMyCompletedSessionReview` inside
`PlayerSessionDetail`, reached from the signed-in history flow); anon never invokes them and the
bodies reject anon regardless. No frontend change required or made.

Operator: applied by Claude Code via exactly one controlled Supabase `apply_migration` call under
explicit user production approval (no db push / repair / manual ledger SQL / fallback; no other
migration applied). Ledger row 37. **No frontend push/deploy, no Edge Function deploy, no merge, no
leaderboard UI exposure; migration 072 remains unapplied.** This ledger update is intentionally left
uncommitted.

## 2026-07-30 — Area (Ralli Live host/manager safe reads) — 075 applied

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. Creates seven server-authorized read RPCs (host
recovery, Active Games, Past Sessions, exact-session analytics, session player counts, lobby
roster) + the `ralli_can_manage_session` authz helper. Corrected before apply to include the
`manager` product role alongside `orgAdmin` (both tenant management roles), and to harden the
new functions' grants up front.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 38 | `20260730185455` | 075_host_manager_safe_reads | supabase/migrations/075_host_manager_safe_reads.sql | `9b52786` | cd77d196cbd7e2dd34a77ef71a0ef590e8dd490883135277fd29dab5d1e39eb4 | 2026-07-30 18:54:55 | PASS (one finding — see below) |

**Pre-apply gate (immediately before applying):** committed==working-tree bytes, SHA-256
re-confirmed `cd77d196…39eb4`; 075 absent; all seven function signatures absent; dependency
tables (game_sessions/game_answers/game_players/game_session_participants/profiles) + roles
(anon/authenticated/service_role) present; migration contains 0 table INSERT/UPDATE/DELETE, 0
POLICY statements, 0 ALTER TABLE, 0 table-grant REVOKE (all 7 REVOKEs are ON FUNCTION).

**Structural verification (read-only, post-apply):** recorded version `20260730185455`, exactly
one row. All 7 functions present, `prosecdef=true`, `search_path=""`. PUBLIC + anon EXECUTE =
false on all 7. authenticated + service_role EXECUTE = true on the 6 client RPCs.

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual
rows):** APPLIED-075 BEHAVIORAL MATRIX PASSED — same-tenant manager + orgAdmin + ralli_admin +
exact host (host profile role='user') all allowed; ordinary same-tenant learner, cross-tenant
manager, and anon all denied.

**No collateral change:** RLS policies unchanged (game_sessions 6 / game_answers 2 /
game_players 2 / game_session_participants 2); `authenticated` SELECT on game_sessions still
granted (tables NOT revoked); migration has no DML so no gameplay data changed.

**FINDING (open, low severity):** the internal helper `ralli_can_manage_session(text,text)`
retains an EXPLICIT `authenticated` + `service_role` EXECUTE grant added by Supabase's
default-privilege trigger on creation; the migration's `REVOKE ALL … FROM PUBLIC, anon` did not
strip those explicit grants, so the helper is client-executable by `authenticated` — contrary to
the intended "internal only". Security impact is low (the helper returns only the CALLER's own
management rights for a given host/tenant, leaks no other data; the SECURITY DEFINER RPCs call it
as owner and are unaffected). Recommended corrective (next controlled apply, awaiting approval):
`REVOKE EXECUTE ON FUNCTION public.ralli_can_manage_session(text,text) FROM authenticated, service_role;`

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit
user production approval (no db push / repair / manual ledger SQL / fallback; no other migration
applied). Ledger row 38. **No frontend push/deploy this step; no Edge Function deploy; no merge;
no leaderboard UI; no table-read revocation; migration 072 remains unapplied.** This ledger update
is intentionally left uncommitted.

## 2026-07-30 — Area (Ralli Live host/manager safe reads) — 076 helper grant lock-down

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. Forward-only correction to the 075 finding: the
internal authz helper `ralli_can_manage_session(text,text)` retained an explicit
`authenticated` + `service_role` EXECUTE grant (Supabase default-privilege trigger) that 075's
`REVOKE … FROM PUBLIC, anon` did not strip. 076 is a single function-level REVOKE making the
helper owner-only. 075 was NOT edited or renamed.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 39 | `20260730190727` | 076_revoke_ralli_can_manage_session_helper | supabase/migrations/076_revoke_ralli_can_manage_session_helper.sql | `6391df6` | 403baee9b9ed43a318dd7cc09d971b0486371a489c9ec33f9df2ce401a6a7f21 | 2026-07-30 19:07:27 | PASS |

**Pre-apply gate:** committed==working-tree bytes, SHA-256 re-confirmed `403baee9…a6a7f21`; 076
absent; helper existed with `authenticated`+`service_role` EXECUTE present; migration = exactly
one function-level REVOKE (0 CREATE/DROP/ALTER/DML/POLICY/table-grant). NOTE: the first
apply_migration call returned a transient connector error; a read-only state check confirmed 076
was NOT recorded and the helper grant was unchanged, so the single apply was safely retried once.

**Structural verification (read-only, post-apply):** recorded version `20260730190727`, exactly
one row. Helper proacl is now `postgres=X/postgres` ONLY — `authenticated`/`service_role`/`anon`/
`PUBLIC` EXECUTE = false, owner (postgres) EXECUTE = true. The six RPC grants are UNCHANGED
(authenticated EXECUTE on all six; anon EXECUTE on none). RLS policies unchanged (game_sessions 6
/ game_answers 2 / game_players 2 / game_session_participants 2); `authenticated` SELECT on
game_sessions still granted (tables untouched).

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual
rows):** POST-076 RPCs STILL FUNCTION PASSED — with the helper owner-only, the six SECURITY
DEFINER RPCs still succeed for same-tenant manager (all six) and exact host (role='user'); an
ordinary learner and anon remain denied. Confirms the RPCs reach the helper as owner despite the
client REVOKE.

**No collateral change / no frontend impact:** migration has no DML; no table grant, RLS policy,
or unrelated ACL changed; the frontend never calls the helper directly (RPC-only), so no
compatibility impact.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call (after one
transient-error safe retry) under explicit user production approval (no db push / repair / manual
ledger SQL / fallback; no other migration applied). Ledger row 39. **No merge; no table-read
revocation; no Edge Function deploy; no leaderboard UI; migration 072 remains unapplied.** This
ledger update is intentionally left uncommitted.

## 2026-07-30 — Area (Ralli Live) — 077 learner-safe joinable-session list (post-075 regression fix)

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. Fixes the post-075 regression: 075 routed the whole
session list through rpc_manager_active_sessions (manager-only → [] for learners), which emptied
the learner joinable list AND (via the lobby deriving sessionDbId from that list) dropped learners
from the lobby. 077 adds a separate learner contract; rpc_manager_active_sessions is unchanged.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 40 | `20260730194350` | 077_learner_joinable_sessions | supabase/migrations/077_learner_joinable_sessions.sql | `173f62b` | 46bddac4859a66d2cd75371289741a4a455ad3e6f9f24e4a37757b1cde372e2d | 2026-07-30 19:43:50 | PASS |

**Pre-apply gate:** committed==working-tree bytes, SHA-256 re-confirmed `46bddac4…372e2d`; 077 absent;
rpc_learner_joinable_sessions absent; game_sessions+profiles + roles present; rpc_manager_active_sessions
present/unchanged; additive only (0 table DML / POLICY / ALTER TABLE / table-grant REVOKE); returned
payload = safe display fields only (id/pin/name/quiz_id/question_count/status/player_count/demo_mode) —
no question_snapshot/live_question/answers/correct/analytics (the three forbidden-keyword hits were all
in comments).

**Structural verification (read-only, post-apply):** recorded version `20260730194350`, exactly one row.
Function present, prosecdef=true, search_path="". ACL `postgres=X | authenticated=X | service_role=X`
(no PUBLIC, no anon). anon+public EXECUTE=false; authenticated+service_role EXECUTE=true.
rpc_manager_active_sessions ACL UNCHANGED (`postgres | authenticated | service_role`). RLS policies
unchanged (game_sessions 6 / game_answers 2 / game_players 2 / game_session_participants 2);
`authenticated` SELECT on game_sessions still granted (tables untouched).

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual rows):**
APPLIED-077 BEHAVIORAL PASSED — a same-tenant learner sees ONLY the tenant's WAITING real session;
started/completed/canceled/demo/cross-tenant sessions excluded; payload carries no
snapshot/live_question/answers/correct/points; anon is grant-level denied (raises, not []).

**No collateral change:** migration has no DML; no table grant, RLS policy, or unrelated function
changed. The manager active-session RPC is unchanged.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit user
production approval (no db push / repair / manual ledger SQL / fallback; no other migration applied).
Ledger row 40. **No merge; no table-read revocation; no Edge Function deploy; no leaderboard UI; migration
072 remains unapplied.** This ledger update is intentionally left uncommitted.

## 2026-07-30 — Area (Ralli Live) — 078 safe rejoin to started/paused session

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. Adds `rpc_rejoin_session(text)`: one atomic
server-authorized op letting a PRIOR same-tenant participant (auth.uid()) re-enter a
started/paused session by PIN — verifies eligibility and reactivates their existing
participant row. Started games remain closed to brand-new players.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 41 | `20260730202237` | 078_rejoin_started_session | supabase/migrations/078_rejoin_started_session.sql | `6614f26` | 200eda5d35d7b3fd869a78bfcb250f950f192dc3d8f3882bec703b367e5fcc67 | 2026-07-30 20:22:37 | PASS |

**Pre-apply gate:** committed==working-tree bytes, SHA-256 re-confirmed `200eda5d…fcc67`; 078 +
`rpc_rejoin_session` absent; game_sessions(pin/tenant_id/status/paused/phase)=5,
game_session_participants(session_id/player_id/status/last_seen_at/name/emoji)=6,
profiles.tenant_id present; roles present; `find_joinable_session(text,text)` (normal
waiting-join) intact; additive (0 top-level table DML / POLICY / ALTER TABLE / table-grant
REVOKE — the only write is the participant status/last_seen UPDATE inside the function body).
Contract confirmed from bytes: user+tenant derived server-side (auth.uid() + profiles.tenant_id);
reactivation writes ONLY status='active' + last_seen_at; never rewrites player_id/name/emoji/
color/points/answers/final_score; participant match by player_id = auth.uid().
NOTE: a transient Supabase connector outage delayed the DB-side gate; it was retried until it
succeeded, and the single apply ran only after all gates passed.

**Structural verification (read-only, post-apply):** recorded version `20260730202237`, exactly
one row. Function present, prosecdef=true, search_path="". ACL `postgres=X | authenticated=X |
service_role=X` (no PUBLIC/anon). anon+public EXECUTE=false; authenticated+service_role
EXECUTE=true. RLS policies unchanged (game_sessions 6 / game_answers 2 / game_players 2 /
game_session_participants 2). `find_joinable_session` (normal join) unchanged.

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual
rows):** APPLIED-078 BEHAVIORAL PASSED — a prior participant (status='left') rejoins a started+
paused session: exactly ONE row, reactivated to status='active'; name/emoji/color and
game_answers/points unchanged; session.paused unchanged (no auto-resume). Brand-new (never-
participated) user, waiting session, completed session, and anon are all denied.

**No collateral change:** migration adds one function; the only data write is the intended
participant status/last_seen reactivation (verified in the rolled-back probe). No table grant,
RLS policy, or unrelated function changed.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit
user production approval (no db push / repair / manual ledger SQL / fallback; no other migration
applied). Ledger row 41. **No merge; no table-read revocation; no Edge Function deploy; no
leaderboard UI; migration 072 remains unapplied.** This ledger update is intentionally left
uncommitted.

## 2026-07-30 — Area (Ralli Live) — 079 residual host-read cutover RPCs (prerequisite for table-SELECT revocation)

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. ADDITIVE ONLY — two new server-authorized
SECURITY DEFINER RPCs so a later `REVOKE SELECT … FROM authenticated` on the four Ralli Live
tables won't break gameplay: `rpc_host_publish_reveal(uuid,integer,jsonb)` (moves the reveal
durable-state conditional first-publication write + 0-row classification read server-side; 0-row
outcome still classified by the unchanged shared JS `classifyRevealPublish`) and
`rpc_host_award_context(text)` (moves the points-award session-by-pin + participant lookup
server-side; scoring math stays in scoringService). Both authorize via the existing owner-only
`ralli_can_manage_session` helper (exact host / same-tenant orgAdmin|manager / ralli_admin) —
no duplicated authorization or scoring logic. Frontend at commit `e53c9a2` already calls these.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 42 | `20260730222110` | 079_ralli_residual_read_rpcs | supabase/migrations/079_ralli_residual_read_rpcs.sql | `2e2a567` | 5e84a9d521374b0d5f3ae0680d0b1bc7f9f29ee6f51b003c9cb7c3e00c7378b6 | 2026-07-30 22:21:10 | PASS |

**Pre-apply gate:** committed==working-tree bytes, SHA-256 re-confirmed `5e84a9d5…78b6`; 079 +
both RPCs absent; `ralli_can_manage_session(text,text)` present and owner-only (no
authenticated/anon/service_role EXECUTE); game_sessions + game_session_participants exist;
game_sessions.tenant_id=text, profiles.tenant_id=uuid; required columns present
(game_sessions: phase/live_question/current_question_index/status/paused/pin/host_id/created_at;
participants: session_id/player_id/name/joined_at); migration contains ONLY the two approved RPC
definitions + their REVOKE/GRANT (no table grant, RLS policy, data, scoring formula, or unrelated
function change).

**Structural verification (read-only, post-apply):** recorded version `20260730222110`, exactly
one row. Both functions prosecdef=true, proconfig=`search_path=""`. EXECUTE: authenticated=true,
service_role=true, anon=false, PUBLIC=false (both). Helper `ralli_can_manage_session` STILL
owner-only (no authenticated/anon/service_role EXECUTE). authenticated SELECT on all four tables
UNCHANGED (still granted — revocation is a separate later stage). Migration is pure DDL (2
CREATE FUNCTION + 4 grants) → 0 DML → no production data rows modified.

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual
rows):** APPLIED-079 BEHAVIORAL PASSED — T0 stale question index → zero, session phase NOT
corrupted (stays 'question'); T1 exact host publishes reveal → applied; T2 duplicate publish →
zero + honest current{phase=reveal,cqi=0}, session state uncorrupted; T3 same-tenant manager
(non-host) publishes → applied; T4 learner, T5 cross-tenant manager, T6 anon → publish denied;
T7 host award_context → resolves only the authorized session + its one participant; T8 same-tenant
manager award → authorized; T9 cross-tenant → another tenant's session NOT resolvable (null);
T10 learner award → session not exposed. Zero fixtures remain after rollback (verified).

**Regression / build:** JS suites zeroPlayerHalt 12/12, playerSafeQuestion 9/9, revealPublish 7/7
(0 fail); gameService + scoringService parse clean; `npm run build` ✓ (2.08s).

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit
user production approval (no db push / repair / manual ledger SQL / fallback; no other migration
applied). Ledger row 42. **No merge; no table-read revocation; realtime participant subscription
NOT removed; no migration 080 created; no Edge Function deploy; no leaderboard UI; migration 072
remains unapplied.** This ledger update is intentionally left uncommitted.

## 2026-07-31 — Ralli Live server-authorized lifecycle write RPCs (080, Stage C) — **APPLIED TO PRODUCTION**

Branch `feature/ralli-live-leaderboard`. Applied via exactly one controlled `apply_migration`
call under explicit user production approval. ADDITIVE ONLY — eight SECURITY DEFINER RPCs that
move the 9 filtered Ralli Live lifecycle writes off direct table access (Stage B proved a bare
REVOKE SELECT breaks them), so the later revocation (now migration **082** — see roadmap note
below) is safe. Corrected build:
exact-session identity (start/end by exact game_sessions.id, no PIN lookup / no PIN fallback),
smallest truthful state-transition guards, canonical joinability (real+waiting; started/paused →
rpc_rejoin_session 078), self-only participant writes (player_id=auth.uid()). The two pure INSERTs
(game_players, game_answers) are unchanged (migration 072 scope).

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 43 | `20260731010835` | 080_ralli_server_authorized_writes | supabase/migrations/080_ralli_server_authorized_writes.sql | `2868de7` | db0a518bcca38cca9086501286b12312d4fe5b13ffee4aeaa0e8394b58f96d5f | 2026-07-31 01:08:35 | PASS |

**Pre-apply gate:** committed==working-tree bytes, SHA-256 re-confirmed `db0a518b…f96d5f`; 080 +
all eight corrected RPCs absent; obsolete overloads `rpc_start_session(text)` /
`rpc_end_session(uuid,text)` absent; `ralli_can_manage_session` owner-only; 078 `rpc_rejoin_session`
+ 079 `rpc_host_publish_reveal` + canonical `find_joinable_session` present; tables/columns/unique
(session_id,player_id)/roles present; demo_mode default false + participant status default 'active';
authenticated table SELECT unchanged; migration is only the 8 RPC defs + REVOKE/GRANT (no table
grant, RLS policy, scoring formula, answer, or data change).

**Structural verification (read-only, post-apply):** recorded version `20260731010835`, exactly
one row. All 8 RPCs exist with corrected signatures; all prosecdef=true + proconfig `search_path=""`;
EXECUTE authenticated+service_role=true, anon+PUBLIC=false; obsolete overloads absent; helper still
owner-only; authenticated table SELECT UNCHANGED on all four tables; RLS policy count unchanged (12);
migration is pure DDL → 0 DML → no production data modified.

**Behavioral verification (production, ONE BEGIN…ROLLBACK, ephemeral identities, 0 residual rows):**
APPLIED-080 BEHAVIORAL ALL PASS — waiting-real-with-snapshot starts by exact id; sibling session
untouched (reused-PIN independence); null/random/no-snapshot/demo/re-start rejected; learner joins a
waiting session; a 'left' participant re-joining a waiting session returns to 'active' with no
duplicate; started session rejects normal join (rejoin path is 078); phase mutates live but not a
completed/canceled session; cancel only from waiting + idempotent; end is exact-id, atomic
(session+participants) and idempotent, null id = matched:false no-op; leave/heartbeat affect only the
caller with honest matched/not-matched; null avatar preserved; learner/cross-tenant/anon mutations
denied. JS regressions 12/9/7 green; build clean.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit
user production approval (no db push / repair / manual ledger SQL / fallback; no other migration
applied). Ledger row 43. **No merge; migrations 081 (scoreboard recovery) and 082 (table-SELECT
revocation) NOT created; direct authenticated table SELECT remains OPEN (not revoked); migration
072 remains unapplied; no Edge Function deploy; no leaderboard UI.** This ledger update is
intentionally left uncommitted.

---

## Ralli Live migration roadmap (corrected numbering — as of the 2026-07-31 checkpoint)

Applied to production and verified: **071** (team-at-game-time snapshot / trust foundation),
**073** (learner-safe reads), **074** (anon read-RPC grant hardening), **075** (host/manager safe
reads, incl. the `manager` role), **076** (`ralli_can_manage_session` locked to owner-only),
**077** (learner joinable-session list), **078** (safe rejoin to started/paused), **079**
(residual host-read cutover RPCs), **080** (server-authorized lifecycle write RPCs).

Honest current confidentiality/lifecycle state:
- Application READS have moved to authorized SECURITY DEFINER RPCs (073/075/077/078/079); the
  frontend performs zero direct `.select()` on the four Ralli Live tables.
- Application lifecycle WRITES have moved to authorized RPCs (080); the only remaining direct
  operations are the two pure INSERTs (`game_players` final scores, `game_answers`).
- `ralli_can_manage_session` is owner-only (076).
- **Direct authenticated table SELECT on the four Ralli Live tables REMAINS OPEN** — no
  confidentiality revocation has been applied. The app no longer reads directly, but the GRANT
  is still present until the revocation stage below.

NOT YET CREATED / NOT APPLIED (corrected numbering):
- **072** — server-authoritative verification foundation: remains **unapplied** (leaderboard-trust
  prerequisite).
- **081** — durable Ralli Live scoreboard recovery: **pending** (design only; not created/applied).
- **082** — final direct-table SELECT revocation (`REVOKE SELECT … FROM authenticated, anon` on the
  four tables): **pending** the later stage (not created/applied). *(Supersedes earlier notes that
  called the revocation "migration 081"; the revocation is now 082 and 081 is reserved for the
  scoreboard recovery. The separate `RALLI_TABLE_SELECT_REVOCATION_PLAN.md` still uses the older
  "081" label and will be corrected when that revocation work begins.)*

---

## 2026-08-01 — Ralli Live active-quiz eligibility + durable waiting-session integrity (083) — **APPLIED TO PRODUCTION**

Branch `feature/ralli-live-leaderboard` @ commit `f9925d0`. Applied via exactly one controlled
`apply_migration` call (Strategy A) under explicit user production approval — no `db push`, no
migration repair, no manual `schema_migrations` write, no SQL-editor copy/paste, no fallback file,
no second migration number. ADDITIVE / forward-only. Does NOT edit any applied migration; does NOT
create/apply 072/081/082; no merge, no frontend production deploy.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 44 | `20260801214829` | 083_ralli_active_quiz_eligibility | supabase/migrations/083_ralli_active_quiz_eligibility.sql | `f9925d0` | d7d1d65ea4a68297431dac8b1ff8af90f97cc42bf1ec2d0aeaf3102c80ad88f6 | 2026-08-01 (version `20260801214829`) | PASS — see below |

Approved SHA-256: `d7d1d65ea4a68297431dac8b1ff8af90f97cc42bf1ec2d0aeaf3102c80ad88f6`. Apply result: `{"success":true}`.

**What 083 does:** only ACTIVE quizzes may create / join / start a Ralli Live game, and a real
waiting session cannot remain joinable once its quiz stops being active or is deleted.
- Four faithful-superset RPCs (CREATE OR REPLACE — signatures/returns/owner/SECURITY DEFINER/
  search_path/ACLs preserved): `create_game_session_atomic` (create guard), `rpc_start_session`
  (start guard + concurrency-safe conditional transition), `rpc_participant_join` (join guard),
  `rpc_learner_joinable_sessions` (list filter). Create/start/join `SELECT … FOR SHARE` the
  canonical `tenant_quizzes` row and re-check `status='active'` (safe text id compare); start's
  final `UPDATE … WHERE status='waiting'` + `IF NOT FOUND` returns `not_startable` instead of
  reviving a canceled session. Quiz-row-before-session-row lock order everywhere (no deadlock).
- Two source-of-truth triggers on `tenant_quizzes`: `AFTER UPDATE OF status WHEN OLD='active' AND
  NEW<>'active'` and `BEFORE DELETE`, each cancelling every same-tenant, non-demo `waiting` session
  for that quiz (`status='canceled', ended_at=now(), live_question=NULL`) in the same transaction.
- One-time bounded, idempotent correction of pre-existing orphans.

**Pre-apply gate (read-only, all PASS):** working-tree == committed(`f9925d0`) SHA-256 both
`d7d1d65e…88f6`; 083 absent from ledger (latest `080`); 072/081/082 absent; no `tenant_quizzes`
083 triggers/functions; all four RPCs at pre-083 defs (no `FOR SHARE`); public-schema CREATE denied
to anon/authenticated; correction predicate matched **exactly 2** real waiting sessions; 0 active-
quiz-waiting / started / completed / demo rows matched. The two affected session IDs were captured
privately before applying for exact post-apply reconciliation.

**Structural verification (read-only, post-apply):**
- Recorded version `20260801214829` / name `083_ralli_active_quiz_eligibility`; **exactly one** row.
- Four RPCs: `create_game_session_atomic` (ret game_sessions, secdef, owner postgres, search_path
  `public`, ACL `{PUBLIC,anon,authenticated,service_role}`, now `FOR SHARE`); `rpc_start_session`,
  `rpc_participant_join` (secdef, search_path `''`, ACL `{authenticated,service_role}`, `FOR SHARE`);
  `rpc_learner_joinable_sessions` (STABLE secdef, search_path `''`, `{authenticated,service_role}`,
  EXISTS-filter). Signatures/returns/owners/security/search_path/ACLs unchanged from pre-083.
- Both trigger functions present once, owner postgres, SECURITY DEFINER, `search_path=''`, fully
  qualified; `pg_get_triggerdef` confirms `AFTER UPDATE OF status … WHEN (old.status='active' AND
  new.status IS DISTINCT FROM 'active')` and `BEFORE DELETE`; no duplicate/conflicting trigger.
  `REVOKE EXECUTE … FROM PUBLIC` applied (`has_function_privilege('public',…)=false`).
  NOTE: Supabase default privileges independently grant EXECUTE to `anon`/`authenticated` on new
  public functions, which `REVOKE … FROM PUBLIC` does not remove, so `has_function_privilege` shows
  true for those roles — but this is INERT: a `RETURNS trigger` function raises `0A000 trigger
  functions can only be called as triggers` when invoked directly (verified), so no client can
  execute them to any effect; they run only as triggers. A future grant-hygiene follow-up
  (`REVOKE EXECUTE … FROM anon, authenticated`) is optional and was NOT applied here.
- `delete_quiz` unchanged (still blocks on assignments/attempts); `archive_quiz` unchanged;
  `tenant_quizzes` client DELETE grant still 0 (anon/authenticated); no RLS policy change (15 on the
  five game/quiz tables); no new client delete permission.

**Existing-row impact (read-only, post-apply):** correction predicate now **0**. The exact two
captured session IDs are both `status='canceled'`, `ended_at IS NOT NULL`, `live_question IS NULL`.
Inventory moved exactly `false|waiting|quiz_unavailable` 2 → 0 and `false|canceled|quiz_unavailable`
0 → 2; unchanged: `false|canceled|quiz_active`=3, `false|started|quiz_active`=1,
`false|completed|quiz_active`=40, `false|completed|quiz_unavailable`=16, `true|waiting|quiz_unavailable`
=15 (demo untouched). game_players=35, game_answers=156 unchanged; 0 players/0 answers on the two
affected rows. Re-running the correction would affect 0 rows. No score/answer/snapshot row touched.

**Historical integrity:** completed sessions (56) and their immutable snapshots unchanged; started
game (1) unaffected; Past Sessions / My Scores / analytics untouched; canceled pre-start sessions do
not become completed history.

**Behavioral verification (production, ONE BEGIN…ROLLBACK against the LIVE applied objects, ephemeral
fixtures, zero residual rows):** LIVE PASS — create(active) succeeds; create(archived) + create(malformed)
rejected honestly (no raw uuid-cast); the live AFTER-UPDATE trigger cancels a waiting session on archive;
a stale `rpc_start_session` cannot revive the canceled session; the live BEFORE-DELETE trigger cancels a
waiting session on hard delete. Plus: exact-artifact two-connection concurrency suite (Docker, prelude +
the verbatim committed 083 file, `lock_timeout`/`statement_timeout` armed) **17/17 PASS** across
create-wins / archive-wins / start-wins / archive-vs-start (no revive) / delete-vs-start (no revive) /
create-vs-delete / burst (no deadlock, no orphans); focused eligibility JS + full JS suite + Vite build
all PASS; trace-marker scan clean.

**Scope guardrails honored:** migrations 072 (verification foundation), 081 (scoreboard recovery), and
082 (table-SELECT revocation) remain **unapplied**; no merge or push to main; no frontend production
deployment; no scoreboard/leaderboard work.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit user
production approval. Ledger row 44. **083 documentation closeout (2026-08-01):** all live QA passed
(archived quizzes excluded from New Game; waiting lobby canceled on archive; host and learner both
exit; old PIN rejected; active-quiz games work; already-started games continue from their immutable
snapshot; completed historical results intact; refresh does not reopen canceled lobbies), so this
applied-migration record is now committed to the branch. Production migration 083 remains applied
exactly once (version `20260801214829`) and byte-identical to the committed file (SHA
`d7d1d65e…88f6`); nothing rewritten. Migrations 072/081/082 remain unapplied; no merge to main.

## 2026-08-02 — Ralli Live durable scoreboard recovery (081)

Branch `feature/ralli-live-leaderboard` @ HEAD `6961baf` (081 migration + shared client recovery
module committed in `6961baf`). Applied via exactly one controlled `apply_migration` call under
Strategy A. SHA-256 re-confirmed against the committed HEAD blob immediately before application; the
production-state pre-apply gate confirmed 081 absent, the three columns + publish RPC absent, latest
migration `083`, 072/082 absent, and all five superseded RPCs at their approved
`SECURITY DEFINER`/`search_path=''`/`{postgres,authenticated,service_role}` state.

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 45 | `20260802010902` | 081_ralli_live_scoreboard_recovery | supabase/migrations/081_ralli_live_scoreboard_recovery.sql | 6961baf | 0278c1c706d455355b0b0025c4d101294c546020f534d57b0f494318f5bbb489 | 2026-08-02 01:09:02 | PASS — see below |

**Structural verification (read-only, post-apply):** ledger has exactly **one** 081 row (version
`20260802010902`). `game_sessions` gained the three additive columns: `live_scoreboard jsonb` (NULL),
`scoreboard_version bigint NOT NULL DEFAULT 0`, `scoreboard_published_at timestamptz` (NULL). New
`rpc_publish_scoreboard(uuid,integer,jsonb,text)` present. All six RPCs (`rpc_publish_scoreboard`,
`rpc_set_session_phase`, `rpc_end_session`, `rpc_cancel_session`, `rpc_player_session_restore`,
`rpc_host_session_restore`) are `SECURITY DEFINER`, `search_path=''`, owner `postgres`, ACL
`{postgres,authenticated,service_role}`. Publish-RPC ACL: `has_function_privilege` anon = **false**,
authenticated = true, service_role = true (no `anon=X` grant; PUBLIC absent) — the explicit
`REVOKE … FROM anon` held against Supabase default privileges.

**Existing-row / collateral verification (read-only, post-apply):** `game_sessions` row count **84**,
unchanged; all rows `live_scoreboard IS NULL`, `scoreboard_version = 0`, `scoreboard_published_at IS
NULL` (no DML, no backfill). RLS unchanged (enabled; 6 policies on `game_sessions`); anon table grants
on `game_sessions` unchanged (7, pre-existing). Latest three prod migrations:
`20260802010902` (081), `20260801214829` (083), `20260731010835`. Migrations **072 and 082 remain
unapplied**.

**Behavioral verification (production, single atomic transaction against the LIVE applied RPCs,
ephemeral fixtures, aborted → zero residual rows):** LIVE PASS — host publish returns version 1 with
two server-resolved entries; tie ranks preserved (both rank 1); null avatar preserved; no
answer/solution/snapshot leak in the payload; same-key retry is idempotent (version stays 1, durable
version 1); a different key after publication is rejected; learner restore returns the exact board
(version 1); non-participant restore rejected; learner publish rejected (`insufficient_privilege`);
short-key / negative / duplicate-id / unknown-participant / wrong-qidx / demo-session publishes all
rejected (`check_violation`); moving to the next question (`countdown`) clears the durable board.
Post-run residue check: 0 residual sessions/users/tenants, 84 rows, 0 mutated. Plus exact-artifact
two-connection concurrency suite (Docker, prelude + the verbatim committed 081 file,
`lock_timeout`/`statement_timeout` armed, server-side `pg_sleep` barriers) **16/16 PASS** across
same-key idempotency / different-key loser-rejected / lost-response retry / wrong-phase-then-retry /
publish-vs-countdown (board cleared) / publish-vs-end (board cleared, terminal) — no deadlock/timeout.

**Application verification:** shared helper suite `scoreboardRecovery.test.mjs` **30/30**; full JS
suite **18/18** (`src/lib/*.test.mjs`, incl. Ralli recovery, player-safe question, quiz-learner
confidentiality, reveal-publish, zero-player-halt, eligibility, app declarations/hook-order); Vite
build PASS (95 modules); trace/instrumentation scan clean (no `RALLI_HOST_LOBBY_CANCEL_TRACE` or
debug markers in `rankd-app.jsx` / `scoreboardRecovery.js` / `gameService.js`).

**Scope guardrails honored:** exactly one controlled `apply_migration` (no `db push` / `migration
repair` / manual `schema_migrations` insert / edited text / second migration / fallback); no merge or
push to main; migrations 072 and 082 remain unapplied; no Edge Function deployed; leaderboard UI
remains hidden/unbuilt.

Operator: applied by Claude Code via exactly one controlled `apply_migration` call under explicit user
production approval. Ledger row 45. Production migration 081 is applied exactly once (version
`20260802010902`), byte-identical to the committed file (SHA `0278c1c7…5bbb489`); nothing rewritten.

**Live QA closure (2026-08-02):** two-device live QA on the branch preview passed — normal host and
learner scoreboards; learner refresh; host refresh now automatically reopens the exact active session
and restores the exact durable scoreboard with **no Resume click** and no gameplay advance;
disconnect/rejoin, background/visibility, and missed-broadcast recovery; stale-response protection;
previous-scoreboard invalidation; ended-session protection; all five question types; final leaderboard
and analytics intact. One QA-side migration correction was **frontend-only** (client boot routing, no
migration change): the host active-game refresh reconnect was previously learner-only, so a host
refresh landed on the Ralli Live hub / Active Sessions list; corrected in commit `a94e763`
(`rpc_host_session_restore`-based host reconnect on boot). Migration 081 itself is unchanged and
remains applied exactly once. This applied-migration record is now committed to the branch (docs only;
no merge). Migrations 072 and 082 remain unapplied.

## 2026-08-02 — Verification foundation applied + Edge Function deployed (072 + verify-game-session)

Branch `feature/ralli-live-leaderboard-view` @ HEAD `844b2289ad6ab991bc5e0f59a732b66a390cf5d7`.
Two-stage controlled execution under explicit product approval; nothing merged; no leaderboard UI.

**Stage 1 — migration 072 (one controlled `apply_migration`, exact committed bytes).**

| Order | Prod version (ledger) | Prod name | Git file | Commit | SQL SHA-256 | Applied (UTC) | Verification |
|---|---|---|---|---|---|---|---|
| 46 | `20260802180613` | 072_game_verification_foundation | supabase/migrations/072_game_verification_foundation.sql | 844b228 (authored d208a89) | b27a557cf6280f6e49ecf1a39a3f3a744f4455202a648fd69f03360204795147 | 2026-08-02 18:06:13 | PASS |

- **Approved backfill executed exactly as scoped:** **36** existing sessions with a non-null
  `question_snapshot` received `question_snapshot_hash` + `question_snapshot_frozen_at`; all 36 hashes
  equal `md5(question_snapshot::text)` (0 wrong); 0 demo rows. **No** answers/scores/points/XP/
  analytics/participants/session-lifecycle changed (sessions=86, answers=162, players=38 unchanged).
- **Zero automatic verification rows:** `game_session_verifications`=0, `game_answer_verifications`=0
  immediately after apply.
- Structural: 2 additive columns; 2 append-only tables + 4 indexes; 3 functions
  (`record_game_verification` secdef/`search_path=''`/EXECUTE=service_role only — anon+authenticated
  denied; `game_sessions_freeze_snapshot`; `game_verifications_block_update`); 3 triggers; RLS on both
  tables; 2 same-tenant read policies. Migrations 073–081/083 intact; 084/085 do not exist. Isolated
  harness 19/19; re-apply idempotent.

**Stage 2 — Edge Function `verify-game-session` deployed (exact committed bundle).**
- Deployment: id `a2b745d8-306c-4fc4-8b52-0e4d6dfa552a`, **version 1, status ACTIVE**, bundle
  `ezbr_sha256 7c680150b7180703683eef9ccf3ead4ba74daa122aec920d53492cb1fd3bf163`.
- Bundle file SHA-256 (working tree == committed at 844b228):
  `verify-game-session/index.ts` = `96650b424b62c2f259a562425b207aaeb07362ea1a6b60d4f4333c3b0eb03e56`;
  `_shared/cors.js` = `26cbb30d1a20514f14ae5b1f7f6f7a343e5b2a3f12ab97c3c0a5187791f29d32`;
  `_shared/gameGrading.js` = `c88dcbb2b2f47e2d304cc801d0ccee3e7180e838588ab662a8144b6a7a22a6f3`;
  `verify-game-session/import_map.json` = `74556822affb033f13dd86b8830fba80eed8024eccaf66b7bc95b66bc4194081`.
- **JWT verification: `verify_jwt = true`** (explicit; the function also self-verifies via
  `auth.getUser()`). Platform secrets `SUPABASE_URL` / `SUPABASE_ANON_KEY` /
  `SUPABASE_SERVICE_ROLE_KEY` are platform-injected defaults (not printed).
- **CORS runtime (live):** OPTIONS from `https://runralli.com` → **204** with
  `Access-Control-Allow-Origin: https://runralli.com`, `Access-Control-Allow-Methods: POST, OPTIONS`,
  `Access-Control-Allow-Headers: authorization, apikey, content-type, x-client-info`; approved preview
  branch alias + `http://localhost:5173` echoed; unapproved `https://evil.com` → 204 with **no** ACAO;
  anonymous POST → **401** (gateway); GET → **401**. The `verify_jwt`+OPTIONS preflight concern did not
  materialize (OPTIONS reaches the function).
- **No historical verification performed:** verification-row counts remained 0 before and after
  deployment; no verification was invoked against any historical session. Frontend game-end
  invocation remains non-blocking / safe-by-default.

**Post-deploy tests:** canonical grader 15/15; CORS policy 32/32; CORS wiring 22/22; full JS suite
22/22; 072 SQL harness 19/19 (isolated); esbuild TS parse + Vite build OK; trace scan clean.

**Reliability (documented, NOT implemented):** migration **084** reserved for the durable verification
queue/retry/reconciliation; migration **085** for the leaderboard read RPC; the leaderboard UI stays
blocked until durable retry exists; missing verification must read as "pending/unverified," never
failed or zero-scoring.

Operator: applied + deployed by Claude Code under explicit user approval. Ledger row 46. Nothing
merged to main; migration 082 remains unwritten/unapplied; leaderboard UI remains unbuilt.
