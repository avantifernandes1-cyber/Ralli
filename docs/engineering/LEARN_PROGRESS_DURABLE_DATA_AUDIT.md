# Learn progress — durable-data audit (Manager History)

Purpose: establish which "detailed progress" fields are **durably persisted and
authoritative** (safe to display in the Manager Assignment History) vs which are
**not persisted** (must never be shown as if they were). No new tracking system
is built; this documents the honest boundary and proposes a post-beta model.

## Durable & authoritative — SAFE to display

| Field | Source | Update frequency |
|---|---|---|
| Lesson complete / incomplete (for an instance) | `lesson_completions.completed_at` vs the row's `assigned_at` (engine `isQualifyingEvent`) | On each Mark Complete (`mark_lesson_complete`, ON CONFLICT → now()) |
| Lesson completed date | `lesson_completions.completed_at` | Same |
| Course % complete | qualifying `lesson_completions` ÷ `tenant_courses.lesson_ids` (engine `resolveCourseAssignment`) | Derived on read from completions |
| Course completed / total lessons | Same denominator; archived/missing member lessons excluded so the denominator is honest | Derived on read |
| **Next lesson** | First course member lesson with **no** qualifying completion (engine order) | Derived on read |
| Remaining lessons | Course members minus qualifying completions | Derived on read |
| Quiz status / latest & best score / attempt count | `quiz_attempts` scoped to the current instance (engine `resolveLatestQuizAssignment`) | On each attempt |
| Assigned / due date | `tenant_assignments.assigned_at` / `due_at` | On assignment |
| Ended (cancelled/unassigned) date + coarse reason | `cancelled_at` / `cancelled_reason` (063); actor via `cancelled_by` (064, pending) | On archive / unassign |
| Overdue | due date vs now, only when unresolved (engine) | Derived on read |

## NOT persisted — must NOT be displayed

| Requested field | Why it can't be shown honestly |
|---|---|
| Current lesson section / step within a lesson | No per-block position is written anywhere; the viewer holds it in React state only |
| Current quiz question | Live UI state only; not persisted mid-attempt |
| Live "questions remaining" | Same — only the finished attempt's score is stored |
| Time spent / time remaining | No timing is recorded on lesson_completions or quiz_attempts |
| XP-derived progress | XP is a reward signal, not a position; inferring % from XP would be fabricated |

Rule applied in the UI: the Manager History shows **"Next lesson"** (the durable
first-incomplete), never "current lesson"; shows completed/remaining counts and
%, never a mid-lesson position or any time value. Missing/archived content
degrades to an italic *"(removed)"* label — never a fabricated title.

## Post-beta proposal (do NOT build without approval)

A minimal, append-only event model would make the "not persisted" fields honest
later, without changing any current resolution rule:

```
learn_progress_events(
  id, tenant_id, profile_id, assignment_id,
  content_type, content_id,
  event_type,        -- lesson_opened | block_viewed | quiz_question_answered | attempt_started …
  position jsonb,    -- {blockIndex} / {questionIndex} — honest, event-sourced
  occurred_at timestamptz )
```

Flow: the viewer emits an event on open / block advance / question answer; the
manager view reads the latest event per (profile, assignment) for a truthful
"currently on step N / question N" and coarse last-activity. This is additive
(a new table + writes), never replaces the completion/attempt authority above,
and is explicitly **out of scope** until approved.
