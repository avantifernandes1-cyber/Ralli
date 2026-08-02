# Changelog

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
