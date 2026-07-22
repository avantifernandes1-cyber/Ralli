# Ralli

Ralli is a production SaaS platform for Sales Readiness.

Mission:

Measure readiness, not completion.

The platform combines:

- Learning
- Quizzes
- Courses
- Battle Cards
- Ralli Live
- Readiness Scoring
- Leadership Analytics
- Assignments
- Coaching

This is a production application.

Never build throwaway implementations.

---

## Engineering Principles

Single source of truth.

Reuse existing services before creating new ones.

Avoid duplicate business logic.

Prefer additive migrations.

Avoid breaking schema changes.

Maintain tenant isolation.

Never fabricate analytics.

Never invent placeholder calculations.

Hide unfinished beta functionality instead of exposing incomplete features.

---

## Workflow

Audit

↓

Implement

↓

Validate

↓

Return Pass/Fail table

↓

Stop

Never continue into another feature without explicit instruction.

---

## Git Rules

Never push automatically.

Never commit automatically.

Wait for approval.

Never rename migrations.

Never rewrite migration history.

---

## Product Priorities

1. Correctness

2. Consistency

3. UX

4. Performance

5. New Features

---

## Product Philosophy

Managers should accomplish tasks in as few clicks as possible.

Everything should have one source of truth.

Automation is preferred over manual work.

Training should never end.

Readiness should continuously improve.

Completion is not comprehension.

---

## Read Before Work

Source-of-truth documentation (see `docs/README.md` for the full index):

- docs/product/RALLI_PHILOSOPHY.md
- docs/product/PRODUCT_DECISIONS.md
- docs/product/ROADMAP.md
- docs/engineering/BETA_CHECKLIST.md
- docs/engineering/KNOWN_BUGS.md
- docs/engineering/CHANGELOG.md
- docs/product/FUTURE_ROADMAP.md
