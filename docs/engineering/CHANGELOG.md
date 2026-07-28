# Changelog

## July 2026

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
