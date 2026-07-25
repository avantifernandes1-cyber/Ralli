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

---

## Quiz Taxonomy

A tag is a tenant-scoped record with a stable identity that never changes for its lifetime. Rename, archive, merge, and analytics all key off that identity, never off the display text.

Labels are unique per tenant, case-insensitively, across every status (active, archived, merged). No two tags in a tenant may normalize to the same name.

Every new or edited quiz must carry at least one active tag. There is no "uncategorized" state — the server rejects a save with no active tag.

Tags are never auto-invented. Only an explicit human action creates a tag; the system never derives one from quiz content.

Governance is separate from assignment. orgAdmin and ralli admins govern the taxonomy (create, rename, archive, restore, merge); managers assign existing tags to quizzes.

First classification is retroactive once. The first time a quiz is tagged, its earlier awaiting attempts inherit that classification a single time; it is never re-applied on later edits.

New attempts preserve immutable attempt-time attribution. Each attempt captures the tags in force at submission as a durable snapshot, independent of later taxonomy changes.

Renaming preserves identity. A rename changes only the display label; the tag's ID, mappings, and historical attribution are unaffected.

Removal is never a hard delete. Tags leave circulation only via archive or merge; the underlying record and its history persist.

Archive cannot strand a quiz. A tag may not be archived while it is the only active tag on any quiz; a replacement must be assigned or the tag merged first.

Merge is permanent. A merged source's name is reserved and cannot be restored or recreated; the source resolves to its target. There is no unmerge.

Historical snapshots are never rewritten. Archive, merge, and rename never alter attempt-time tag snapshots; past analytics remain fixed.

Learners cannot author or govern tags. Tag management is unavailable to the learner role in every surface.
