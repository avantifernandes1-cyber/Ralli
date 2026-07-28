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

### Ralli Live

Status: Beta Complete

Completed:

- Slider tolerance consistency
- Player reveal parity
- Past Sessions

---

### Assignments

Status: Beta Ready

---

### Readiness

Status: Beta Ready

---

## Future

Continuous Learning Programs

AI Coaching

Certifications

Content Versioning

Career Progression

Video Practice

Call Coaching

Slack Integration

CRM Integrations
