# Changelog

## July 2026

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
