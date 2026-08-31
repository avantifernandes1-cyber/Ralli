# Beta Checklist

## Authentication

- [x] Invites

- [x] Roles

- [x] RLS

---

## Quizzes

- [x] Builder

- [x] Results

- [x] Retakes

- [x] Tagging (authoring + governance)

- [x] Tag library filtering

- [ ] Last Updated

---

## Knowledge Heatmap

- [x] Analytics cutover to normalized taxonomy + attempt snapshots

---

## Lessons

- [x] Last Updated

- [ ] Metadata

---

## Courses

- [x] Last Updated

---

## Learn Lifecycle

Beta Complete — merged `6e1c7474fc7145f71fa3b22915ba7016c242dd29`, deployment `BCvnfz6hharkZHESKNpu8f8Fc7er`, migrations 063–067.

- [x] Unified learner Learn (To Do / Completed / All) + manager Learn tabs; standalone Quizzes nav retired

- [x] Archive / restore (lessons, courses, quizzes) with assignability guard (063 / 065)

- [x] Archive cancels only unresolved assignments; completed history preserved + repaired (066)

- [x] Manager Unassign + canonical assignment history (cancelled/unassigned retained) (064)

- [x] Learner-safe archived completed history (067)

- [x] Instance-scoped score/attempt identity; Review opens exact historical attempt (never starts a new one)

- [x] Sign-out clears pending quiz/start/review navigation state

---

## Battle Cards

Beta Complete — migrations 068–070 applied and verified in production; live QA passed. Frontend on `feature/battle-cards-audit`, ready to merge (awaiting approval).

- [x] Create / edit cards
- [x] Tags-only organization (categories retired from the UI; `tenant_battle_cards.tags[]` source of truth; 069 conversion)
- [x] Search + exact tag filters
- [x] Rich-text authoring (shared Lesson editor/renderer; safe markdown subset)
- [x] Durable drafts with Resume / Discard (+ in-editor Discard, Back warning; sign-out clears)
- [x] Archive / restore
- [x] Learner active-only access (RLS)
- [x] Tenant isolation (RLS + WITH CHECK)
- [x] Server-authoritative provenance (created_by/created_at immutable; updated_by/updated_at/archived_at trigger-set) (068)
- [x] Hard-delete prevention for client roles; service_role/owner emergency access retained (068)
- [x] Required-content enforcement on direct authenticated API writes (Title, ≥1 tag, Their Strengths, Their Weaknesses, Why We Win) (070)
- [x] Responsive list / detail experience
- [x] Production data clean: no active card ships with blank required content (two legacy-incomplete cards archived by manager)

---

## Leadership Dashboard

- [x] Drilldown

- [x] KPIs

- [ ] Content timestamps

---

## Ralli Live

Multi-player gameplay, recovery, scoring, and historical analytics — **live-QA passed** on preview
`340f303` (migration 084 durable roster/submission foundation; frontend on
`feature/ralli-live-leaderboard-view`, not merged).

- [x] Multi-player durability — canonical immutable roster + durable per-learner submissions (084); the
      learner UI locks only after the exact current answer is durably accepted; missing session/player/
      question identity fails closed (no optimistic lock, retryable error)
- [x] Repeated Leave / Rejoin — verified across ≥5 cycles; rejoin restores the same canonical player (no
      duplicate roster/answer rows); active-response denominator drops on Leave and immediate auto-reveal
      once all active learners answer; no stale progress state
- [x] Type grading — snapshot-driven; host response display, learner reveal, persisted correctness, and
      points all come from the one durable reconciliation (no independent re-grade); accepted answers
      grade correct, clearly-wrong answers fail
- [x] Scoring / leaderboard / recap / Player Breakdown include both learners
- [x] Zero-player halt (pauses, does not auto-end) + manual host resume; rejoin does not auto-resume
- [x] Countdown synchronization, pause/resume, refresh/reconnect recovery, completion + clean exit
- [x] Analytics — historical analytics remain snapshot-based and immutable

- [x] Tenant isolation

- [x] Past Sessions
