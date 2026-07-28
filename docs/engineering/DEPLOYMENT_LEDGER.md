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
