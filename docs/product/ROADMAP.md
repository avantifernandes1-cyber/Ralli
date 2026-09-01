# Ralli Roadmap

## Current Sprint

### Leadership Dashboard

Status: 95%

Remaining:

- Last Updated timestamps
- Content metadata
- Final QA

---

### Knowledge Heatmap

Status: Beta Complete

Completed:

- Analytics cutover off legacy free-text tags onto the normalized taxonomy + immutable attempt-time snapshots (migration 062, canonical `get_knowledge_heatmap` RPC)
- Trusted `server_v2`-only scoring with legacy/awaiting disclosed in coverage
- All active learners + all active topics visible; missing evidence shown honestly (`—` / null)
- Merged-tag resolution, multi-tag dedupe, explicit threshold source
- One canonical aggregation source shared by manager Heatmap, learner Knowledge by Topic and rep drill-down

(No longer a Leadership Dashboard dependency.)

---

### Quiz Taxonomy

Status: Beta Complete

Completed:

- Tenant-scoped tags with stable identity
- Create / rename / archive / restore / merge governance
- Quiz tagging + library filtering
- Required active tag on save
- Attempt-time tag snapshots

---

### Learn Lifecycle (Lessons / Courses / Quizzes)

Status: Beta Complete

Merged to production: commit `6e1c7474fc7145f71fa3b22915ba7016c242dd29`; Vercel deployment `BCvnfz6hharkZHESKNpu8f8Fc7er`. Migrations 063–067 applied and verified.

Completed:

- Unified learner Learn (To Do / Completed / All) + manager Learn tabs (Assignments / Courses / Lessons / Quizzes); standalone Quizzes nav retired
- Lifecycle integrity: archive cancels only unresolved assignments, blocks hard delete of referenced content, server-authoritative completion (063)
- Manager Unassign + one canonical assignment history preserving cancelled/unassigned instances (064)
- Quiz archive/restore with a canonical assignment-assignability guard closing the archive-vs-assign race (065)
- Archive never cancels completed history; completed-history repair (066)
- Learner-safe completed-quiz history incl. archived, catalog-only metadata (067)
- Instance-scoped assignment score/attempt identity (no reassignment misattribution); Review opens the exact historical attempt (never starts a new one); sign-out clears pending quiz/start/review navigation state
- "Last Updated" on lesson and course cards from authoritative `updated_at` (empty when missing — no invented dates)

---

### Battle Cards

Status: Beta Complete (ready to merge — awaiting merge approval)

Migrations 068, 069, 070 applied and verified in production (versions `20260728175949`, `20260728232125`, `20260729151513`). Live QA passed; frontend on `feature/battle-cards-audit`, not yet merged.

Completed (full beta scope):

- Create / edit cards (Title, Subtitle, Summary, Their Strengths, Their Weaknesses, Why We Win, Talk Track, In-Depth sections)
- Tags-only organization: categories retired from the UI/service; `tenant_battle_cards.tags[]` is the source of truth (data-only category→tag conversion, migration 069, provenance preserved)
- Search + exact tag filters (free-text scope title/subtitle/summary/tags; tag chips are exact normalized matches; archived-only tags excluded from suggestions)
- Rich-text authoring reusing the Lesson editor/renderer (bold/italic/underline/lists) for the body fields; injection-safe markdown-subset rendering shared with Lessons; plain text for Title/Subtitle/Tags/section headings
- Durable unsaved drafts scoped by tenant + user + create-vs-edit + card id, with Resume/Discard, in-editor Discard, and Back-with-unsaved-changes warning; cleared on save/discard and on sign-out
- Archive / restore (status active|archived, archived_at) instead of hard delete; permanent delete not exposed
- Learners read active cards only (RLS-enforced); managers/orgAdmins see active + archived; archived excluded from learner search and counts
- Tenant isolation (SELECT/INSERT/UPDATE RLS + `WITH CHECK` block cross-tenant moves)
- Server-authoritative provenance: created_by / created_at immutable on edit; updated_by / updated_at / archived_at set by DB trigger (068)
- Hard-delete prevention: no client-role DELETE (policy dropped + grant revoked; service_role/owner retain emergency access) (068)
- Required-content enforcement server-side (070): Title, ≥1 meaningful tag, Their Strengths, Their Weaknesses, Why We Win — validated for direct authenticated API writes; INSERT full-validity, UPDATE non-regression (legacy incomplete rows can still be archived/corrected but valid content cannot regress)
- Responsive list + detail experience; Quiz-consistent white card surfaces and yellow tag pills

Readiness / analytics boundary (for the later Leadership Dashboard overhaul — do NOT treat as production evidence):

- No learner Battle Card activity (viewed/opened/completed) is tracked. There is no event source.
- Real tenants receive NO Battle Card readiness contribution today; the `battlecards` weight is fed only by demo seed (`LEADERSHIP_SEED`) in demo mode.
- No Battle Card readiness contribution may be added until a trustworthy event source exists. The demo-only seeded values are deferred to the Leadership overhaul and must never be shown as real data.

---

### Ralli Live

Status: Gameplay / recovery / scoring / historical-analytics foundation — Beta Complete (live-QA passed)

Completed:

- Multi-player durability foundation (migration 084): canonical immutable roster + durable, auth.uid-derived,
  idempotent per-learner answer submissions; the database is the source of truth for both membership and answers
- Durable reveal + deterministic scoring from the canonical reconciliation (single grader; no independent re-grade)
- Repeated Leave / Rejoin (same canonical identity, no duplicates); active-response denominator + immediate reveal
- Countdown recovery, zero-player halt (pause, not auto-end) + manual resume, refresh/reconnect recovery, completion + exit
- Type grading correctness (snapshot-driven; host/learner/persisted/points agree)
- Slider tolerance consistency
- Player reveal parity
- Past Sessions
- Historical analytics remain snapshot-based and immutable

The organization / team / individual **leaderboard** foundation is now implemented locally on
`feature/ralli-live-leaderboard-085` (migration 085) but is **NOT applied to production, not deployed,
not backfilled, and not merged.** It is prospective and server-authoritative: a durable per-question
**exposure** denominator, verified-accuracy-only individual scoring with a tenant-mean shrinkage prior,
median-based team scoring with eligibility/participation gates, an org IANA timezone with half-open
timeframe windows, and a durable verification queue/outbox. The leaderboard lives inside Ralli Live
(Individuals / Teams / team drill-down); the global Leaderboard nav item and the lifetime-XP Home
"Team Leaderboard" widget were removed. Sessions predating 085 stay in Past Sessions/analytics but are
excluded from ranking ("Pre-leaderboard tracking"). Until 085 is applied, the in-app leaderboard shows
its backend-unavailable / retry states. Fully validated locally (SQL harness + concurrency + JS suite +
build + scans); awaiting separate approval to apply/deploy.

---

### Assignments

Status: Beta Ready

---

### Readiness

Status: Beta Ready

---

## Future

Guided Onboarding Builder

Help leaders create effective onboarding — not merely arrange content — using this sequence:

1. Teach the why and underlying methodology.
2. Teach the workflow and how to reason through the task.
3. Teach the tools used to execute it, such as HubSpot, Orum, Gong, and related systems.
4. Reinforce it with real examples from the organization's existing content.

Continuous Learning Programs

AI Coaching

Certifications

Content Versioning

Career Progression

Video Practice

Call Coaching

Slack Integration

CRM Integrations
