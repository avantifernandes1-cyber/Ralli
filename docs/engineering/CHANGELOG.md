# Changelog

## September 2026

Ralli Live Leaderboard — Denominator Foundation (implemented locally, NOT applied/deployed/merged)

On `feature/ralli-live-leaderboard-085` (branched from `origin/main`). Migration 085 is written and
fully validated locally but is **NOT applied to production, no Edge Function deployed, no historical
backfill, and the branch is not merged.** Until 085 is applied, the in-app leaderboard honestly shows
its backend-unavailable / error+retry states.

Foundation (migration 085, local only):

- **Exposure denominator** (`game_question_exposures`): a durable, immutable, append-only row per
  `(session_id, player_id, question_idx)` proving a canonical player was durably active when a
  question began. Inserted idempotently inside the authoritative question-start transition of
  `rpc_set_session_phase` (a faithful superset of the 084 version) for roster-active + participant-
  active + fresh-heartbeat (≤40s) members only. Explicit-leave and stale members are never exposed;
  disconnect-after-start keeps the exposure; demo/canceled/completed never expose. Blocked from
  UPDATE/DELETE by trigger; tenant-scoped RLS; no client writes.
- **Individual formula** (`rpc_ralli_leaderboard_individuals`): `adjusted_accuracy =
  (verified_correct + 20·tenant_mean) / (eligible_questions_faced + 20)`, verified_correct from
  authoritative 072 verifications only, denominator from exposure rows only, open-ended-pending
  (no verdict) excluded from BOTH numerator and denominator, neutral prior 0.5 when no tenant
  baseline. Eligibility ≥20 faced AND ≥3 games; otherwise unranked with progress. Dense ranking;
  speed is a tie-break only (server-derived median normalized correct-response time). No XP / lifetime
  / volume / client correctness anywhere.
- **Team formula** (`rpc_ralli_leaderboard_teams`, `rpc_ralli_team_members`): median of eligible
  members' adjusted accuracy from the 084 roster-snapshot team; ranked only with ≥2 eligible AND ≥50%
  of active learners eligible. Learners may drill into their own team only; managers any same-tenant.
- **Org timezone** (`tenants.timezone`, `rpc_get_org_timezone` / `rpc_set_org_timezone`): IANA,
  default UTC, validated against `pg_timezone_names`, manager/orgAdmin write-only, learner read-only.
  Half-open `[from, to)` timeframe boundaries computed client-side in the org tz.
- **Durable verification queue/outbox** (`game_verification_queue` + completion trigger +
  service-role-only `rpc_claim_verification_job` / `rpc_complete_verification_job`): a real session
  reaching `completed` enqueues exactly once; demo/canceled excluded; exponential-backoff retries to a
  terminal `failed`; stores no answer/verdict/snapshot material. No outbound HTTP from a trigger.
- All privileged functions SECURITY DEFINER with `SET search_path=''`, tenant/caller server-derived,
  anon/Public denied, aggregate-only returns (no answer text / correct-answer keys / snapshots).

Frontend (feature branch only):

- Leaderboard moved **into Ralli Live**: managers get Active / Past Sessions / Leaderboard; learners
  get Join a Game / My Scores / Leaderboard. Leaderboard = Individuals (default) / Teams / team
  drill-down, with a timeframe filter (Current month default, Last 2/3/4 months, Current calendar
  year) and the active org timezone shown beside it. New `ralliLeaderboardService` + pure, unit-tested
  `ralliLeaderboardTimeframe` (tz/DST-correct half-open ranges) and `ralliLeaderboardView`
  (recognitions + formatting) helpers. All states implemented: loading / error+retry / no-verified-
  games / not-enough-individual / not-enough-team / valid — service errors are never converted to
  empty results.
- Removed the global **Leaderboard** nav item and the old Home "Team Leaderboard" widget, which ranked
  blended lifetime XP from `user_point_events` (not a valid readiness ranking). Scoring services kept
  for their remaining consumers.

Historical Ralli Live sessions predating 085 remain visible in Past Sessions/analytics but are
excluded from ranking (no backfill/inference) — "Pre-leaderboard tracking."

Pre-production corrections (still local only; 085 unapplied, worker not deployed/scheduled):

- **Exposure freshness reuses the canonical durable-active definition.** Audit found the established
  Ralli Live lifecycle uses a 15s participant heartbeat and a single 40s freshness window
  (`HEARTBEAT_FRESH_MS`) shared by lobby visibility, in-game active count, and the zero-player halt;
  the "~25s stale" figure survives only as a stale code comment, not in code. 085 already used that 40s
  window via one helper; the only divergence was an inclusive `<=` vs the frontend's strict `<`. Fixed to
  strict `<` so a heartbeat exactly at the edge is stale in the DB and client identically — no new,
  more-permissive rule. Boundary tests added (39.5s in; exactly 40s + 41s out; Leave-over-fresh,
  active-without-heartbeat, fresh-without-active-roster all excluded; rejoin re-qualifies at a later
  question).
- **Durable verification worker.** Added the server-owned worker the outbox needed (no worker existed;
  the frontend fire-and-forget was not one): `verify-queue-worker` (Deno, service-role-only, bounded
  batch + runtime budget) reusing the canonical verify path (`_shared/verifySession.js` → shared grader
  + `record_game_verification`) via a pure, unit-tested orchestrator (`_shared/verifyQueueWorker.js`).
  Added a **processing lease** to migration 085 (`lease_expires_at` + reclaim-expired-on-claim +
  release-on-complete) so a crashed worker's job is never permanently stuck. Implemented + tested; NOT
  deployed or scheduled (see docs/engineering/085_VERIFICATION_WORKER.md).
- **Server-authoritative timeframes.** The leaderboard RPCs no longer accept client `from`/`to` dates;
  they take an approved enum (`current_month`, `last_2_months`, `last_3_months`, `last_4_months`,
  `current_year`) and a single server resolver (`ralli_resolve_timeframe`) derives the tenant, reads the
  tenant IANA timezone (fallback UTC), computes the exact half-open `[from, to)` window, rejects
  unsupported enums, and returns the resolved `{ timeframe, from, to, timezone, rows }`. Individuals,
  Teams, and Team Members share the one resolver so their windows cannot disagree, and a client can no
  longer widen the period. The frontend pure timeframe util is retained for labels/tests only. Server
  timeframe tests added (UTC + America/New_York + year/last_N boundaries, invalid enum rejected,
  all-three-RPCs-agree, arbitrary-date signature uncallable, invalid stored tz → UTC, tenant isolation).

Validation (all local, green): 085 SQL harness (exposure lifecycle, individual/team formula, timezone,
security, confidentiality, verification queue) + 085 two-connection concurrency (exposure idempotency,
enqueue-once); 084 unchanged (byte-identical) and its concurrency still passes; full JS suite incl. new
timeframe/view tests; esbuild parse; Vite build; trace/secret/payload-leak scans; migration-integrity
scan (no prior migration edited).

## July 2026

Ralli Live — Lifecycle & Confidentiality Foundation (in progress, not beta-complete)

On `feature/ralli-live-leaderboard` (not merged). Migrations 071 and 073–080 applied and verified
in production; 072 intentionally unapplied. Completed in this slice:

- Learner-safe and host/manager-safe session reads: all Ralli Live reads (host recovery, active/
  past sessions, analytics, counts, lobby roster, learner joinable list, reveal/award context)
  moved behind server-authorized SECURITY DEFINER RPCs (073/075/077/078/079); the frontend does
  zero direct table `.select()`. `ralli_can_manage_session` is owner-only (076).
- Server-authorized lifecycle writes (080): start / end (session + participant completion, atomic)
  / cancel / phase-and-live-state / question-snapshot (write-once) and participant join / leave /
  heartbeat now run through authorized RPCs with exact-session identity and truthful state-
  transition guards. Only two direct pure INSERTs remain (final scores, answers).
- Waiting-lobby Leave/Rejoin reliability: explicit Leave durably marks the participant `left` and
  untracks Presence; rejoin reactivates the same row (no duplicate); host roster and player count
  clear promptly on Leave and show exactly one on rejoin.
- Realtime channel reconnection: an unexpectedly closed game channel (the reused-topic drop after
  rejoin) is detected and recreated with a generation-guarded lifecycle — one channel per topic.
- Participant roster/count consistency: a single canonical Presence-plus-durable-heartbeat roster;
  a durable `left` row overrides a lingering ghost Presence entry; Start is gated on live Presence.
- Pause/Resume and refresh recovery foundations: durable phase/question/pause state with a periodic
  idempotent reconcile so a missed broadcast recovers without user interaction; timers derive from
  persisted timestamps and never restart.
- Tenant/role authorization hardening: every RPC derives caller identity/tenant server-side,
  authorizes the exact session/tenant, and denies cross-tenant, anon, and learner-to-host mutation.
- Active-quiz eligibility + durable waiting-session integrity (migration 083, applied & verified in
  production, version `20260801214829`): only ACTIVE quizzes can create / join / start a new Ralli
  Live session (enforced server-side in the create/start/join RPCs, mirrored in New Game); archiving
  OR deleting a quiz durably cancels every waiting lobby on it via source-of-truth triggers
  (`AFTER UPDATE OF status` + `BEFORE DELETE`), so the host and learners are removed even with no
  broadcast; already-started games are untouched and continue from their immutable question
  snapshot; completed historical sessions, snapshots, scores, and analytics remain intact.
  Concurrency-safe (quiz-row `FOR SHARE` locking, one consistent lock order) and idempotently
  corrected two pre-existing orphaned waiting sessions on apply.
- Durable intermediate scoreboard recovery + host-refresh restore (migration 081, applied & verified
  in production, version `20260802010902`; live two-device QA passed 2026-08-02). Scope: the Ralli
  Live *intermediate* scoreboard only — NOT the integrated leaderboard, which remains unbuilt.
  - The scoreboard the host publishes between questions is now **durably persisted server-side before
    the realtime broadcast** (`rpc_publish_scoreboard`): broadcast stays the fast path, the database
    is the recovery source. Identity (name/avatar/rank) is resolved server-side; the client can never
    inject them. Publication is idempotent per episode (stable `publish_key`), session-row-locked, and
    input-hardened; demo sessions are never server-persisted.
  - A **missed scoreboard broadcast recovers from database state** — a learner who refreshes,
    reconnects, backgrounds/returns, or refocuses reconstructs the *exact* published scoreboard
    (same totals, rank, order, null-avatar name-only) instead of "No scores yet" / a "Hang tight"
    dead-end. All recovery triggers (mount, SUBSCRIBED, visibility, focus) reconcile.
  - **Stale responses cannot roll gameplay backward**: monotonic `scoreboard_version` + question-index
    + terminal-phase guards drop an older/late payload; advancing to countdown/question clears the
    previous durable scoreboard; ending or cancelling a game clears it and never restores an
    intermediate scoreboard afterward.
  - **Host refresh now reopens the exact active session automatically** (no Resume click, no gameplay
    advance), then restores the exact durable scoreboard. Root cause of the earlier host-refresh
    defect: the active-game reconnect context was **learner-only** (persisted for `gameRole === "user"`
    and reconnected only in the standard-user boot branch), so a host fell through to the Ralli Live
    hub / Active Sessions list. Fixed **frontend-only** (client boot routing) in commit `a94e763` —
    the host now persists a role-tagged reconnect pointer and re-enters via the host-safe
    `rpc_host_session_restore`; learner recovery, scoring, leaderboard, analytics, and migration 081
    are unchanged.
  - Verification: behavioral harness against the live applied RPCs, two-connection concurrency 16/16,
    scoreboard helper unit tests 30/30, host-restore regression test, full JS suite, Vite build, and a
    clean trace/debug-marker scan — all green.

Still pending (Ralli Live NOT beta-complete):
- Server-authoritative verification foundation (migration 072, unapplied).
- Integrated Ralli Live leaderboard.
- Final direct-table SELECT revocation (future migration 082) — direct authenticated table SELECT
  currently remains open.
- Final Ralli Live beta QA.

---

Battle Cards — Beta Complete

- Migrations 068 (lifecycle + provenance + RLS hardening + hard-delete closure), 069 (category→tag data conversion), 070 (server-authoritative required-content enforcement) applied and verified in production (versions `20260728175949`, `20260728232125`, `20260729151513`). Frontend on `feature/battle-cards-audit`, ready to merge.
- Tags-only organization: categories retired from the UI/service; `tenant_battle_cards.tags[]` is the source of truth
- Create/edit, search + exact tag filters, Quiz-consistent tag picker (shared TagChip) and card visuals (white surfaces, yellow tag pills)
- Rich-text authoring for body fields reusing the Lesson editor/renderer (shared safe markdown subset — one implementation, no duplication)
- Durable unsaved drafts scoped by tenant + user + card, with Resume/Discard, in-editor Discard, and Back-with-unsaved-changes warning; cleared on save/discard and sign-out
- Archive/restore instead of delete; authenticated clients cannot hard-delete (service_role/owner retain emergency access)
- Learner active-only reads; tenant isolation via RLS + WITH CHECK; server-authoritative provenance (created_by/created_at immutable; updated_by/updated_at/archived_at trigger-set)
- Required content enforced server-side (Title, ≥1 tag, Their Strengths, Their Weaknesses, Why We Win) for direct authenticated API writes; INSERT full-validity, UPDATE non-regression; incomplete legacy rows can be archived/corrected but valid content cannot regress. No content fabricated: the two legacy-incomplete production cards were archived by the manager.
- No Battle Card readiness contribution for real tenants (no trustworthy event source exists)

---

Learn Lifecycle (Lessons / Courses / Quizzes) — Beta Complete

- Merged to production: commit `6e1c7474fc7145f71fa3b22915ba7016c242dd29`; deployment `BCvnfz6hharkZHESKNpu8f8Fc7er`; migrations 063–067 applied and verified
- Unified learner Learn + manager Learn tabs; standalone Quizzes nav retired
- Lifecycle integrity: archive cancels only unresolved assignments, blocks hard delete of referenced content, server-authoritative completion (063)
- Manager Unassign + canonical assignment history (064)
- Quiz archive/restore + assignment-assignability guard closing the archive-vs-assign race (065)
- Archive never cancels completed history; completed-history repair (066)
- Learner-safe completed-quiz history incl. archived (067)
- Instance-scoped score/attempt identity; Review opens the exact historical attempt; sign-out clears pending Learn navigation state
- "Last Updated" on lesson and course cards

---

Leadership Dashboard

- Drilldowns

- KPI cards

- Company Risk

---

Ralli Live

- Analytics

- Tenant Isolation

- Emoji persistence

- Matching

- Slider

- Type Answer
