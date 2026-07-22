# Product Decisions

## Readiness

Default threshold:

80%

Tenant configurable.

---

Quiz default passing score:

100%

Existing quizzes retain saved values.

---

Lessons

Single source of truth.

Courses reference lessons.

Never duplicate lessons.

---

Assignments

Resolved assignments may be reassigned.

Duplicate active assignments blocked.

---

Leadership Dashboard

Everything clickable.

Every metric leads to action.

---

Training

Training should continue after onboarding.

Managers build continuous learning programs.

---

## Ralli Live

Historical analytics use the immutable question snapshot stored for the session.

Current mutable quiz contents are never used as historical truth.

Legacy sessions without a snapshot degrade honestly instead of guessing question details.

Toughest Question:

- Exclude skipped questions.
- Exclude questions with no submissions.
- Exclude questions with zero incorrect submissions.
- Select the question with the highest number of incorrect submissions.
- Tie-break by longest valid average response time.
- Final tie-break by earliest question order.
- Show no Toughest Question when no question qualifies.

Realtime broadcasts remain the fast path.

Durable session state is the recovery source for refresh, reconnect, pause, and resume.
