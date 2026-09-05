# Known Bugs

## Open

`user_point_events` self-award (XP integrity). The live XP ledger `user_point_events` is directly
client-insertable: RLS policy `users_insert_own_point_events` checks only `user_id = auth.uid()` and tenant
membership — NOT the `points` amount, `source_type`, `source_id`, `reason`, or whether the underlying
completion happened (only guard is `CHECK (points > 0)`). Lesson/course/game awards go through
`scoringService.awardPoints()` → a direct client `insert` with a client-computed amount, so a learner can
grant themselves arbitrary XP with the anon key. The quiz path (`submit_quiz_attempt_atomic`) is
amount-safe (hardcoded point constants) but still trusts a client-decided `score`/`passed`
(`contentService.js` — RPC only bounds score 0–100). `profiles.xp`/`profiles.streak` are stale/unused
(dead `awardXp`, no `streak` writer), so migration 091's grant hardening is XP-safe and does NOT touch this.
FIX (separate migration + product decision on scoring authority — the IMMEDIATE next high-priority task
after 091): server-authoritative award RPCs for lesson/course/game that derive `points` from verified
activity, an idempotent `user_point_events` write (unique on `quiz_attempt_id`/`source`), `profiles.xp` as a
verified sum, `REVOKE` client INSERT on `user_point_events`, and server-side verification of the quiz
`score`/`passed` inputs. Do NOT attempt inside 091.

Priority: High (security)

---

Past Sessions shows zero.

Priority: High

---

Slider tolerance ignores quiz variance.

Priority: High

---

## Fixed

Emoji persistence.

Tenant game codes.

Analytics drilldown.

Knowledge Heatmap read legacy free-text tags. Cut over to the normalized taxonomy + immutable attempt-time snapshots via migration 062 (canonical `get_knowledge_heatmap` RPC); trusted `server_v2`-only scoring, all active learners/topics visible, merged/multi-tag handled, explicit threshold source.
