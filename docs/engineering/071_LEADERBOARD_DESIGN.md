# Ralli Live Leaderboard — Design + Grading-Trust Blocker (071 + 072 slices)

Status: **Trust-foundation slices.** Migration 071 (team-at-game-time snapshot, APPLIED
to production) + migration 072 (server-authoritative VERIFICATION foundation: canonical
grader + immutable verification storage + snapshot freeze + writer RPC + Edge Function,
LOCALLY VALIDATED, **not applied / not deployed**). The leaderboard **read RPC and UI
remain intentionally NOT built and NOT exposed.** The standalone Leaderboard navigation is
retained. See **§11–§17** for the 072 verification foundation.

> **Update (072 slice):** the server-authoritative grading path described as a "blocker" in
> §1 below is now **implemented** as the verification foundation (§11–§17), pending a
> separate migration + Edge-Function preflight/deploy approval. Until 072 is applied AND the
> `verify-game-session` Edge Function is deployed AND a leaderboard read RPC + UI are built,
> the leaderboard stays blocked. No leaderboard ranks are computed or exposed anywhere.

Approved product decisions are recorded verbatim in the task; this doc records the
engineering design and the honest blocker.

---

## 1. Why this slice stops before the read RPC and UI (grading-trust BLOCKER)

**Finding (audited):** every trust-bearing game fact — `game_answers.is_correct`,
`game_answers.points`, `game_players.final_score`, `game_players.final_rank` — is
**computed in the host's browser** (`rankd-app.jsx` `doReveal()`) and written directly via
PostgREST. There is **no server-authoritative game grader** (the only game RPCs are
`create_game_session_atomic` and `find_joinable_session`; neither grades). `game_players.accuracy`
is never written (NULL for all 21 production rows).

The approved rules require the leaderboard to "read only verified/trustworthy results" and
"do not quietly rank client-authored results as trusted." Making game results trustworthy
requires server-authoritative grading, which is a **major redesign**, not a small slice:

- The canonical grader lives inside a React component (`doReveal`), not a reusable pure
  module. Re-implementing it in SQL/PLpgSQL would **duplicate grading logic** (explicitly
  forbidden) and must cover MC, TF, Type (accepted-answers normalization), Slider (tolerance),
  Matching (all-pairs), and manual/Open-ended.
- Verification needs the immutable `question_snapshot`, which is **present on only 8 of 41**
  real ended production sessions — the other 33 cannot be verified at all.
- No edge-function runtime exists today to run the canonical JS grader server-side.

**Decision (per approved instruction §7.3):** implement the identity/team snapshot now and
return grading as a blocker **before exposing any ranking**. The read RPC + UI are deferred
until one of the grading paths below is approved.

### Proposed server-authoritative grading path (for approval — not built here)
Smallest honest option, in preference order:

1. **Extract-and-reuse (preferred).** Refactor the correctness functions out of `doReveal`
   into a shared pure module (`src/lib/gameGrading.js`), used unchanged by the live client,
   then run that same module in a Supabase **edge function** `verify_game_session(session_id)`
   that: loads the immutable `question_snapshot` + raw `game_answers`, recomputes `is_correct`
   for MC/TF/Type/Slider/Matching, writes a verified result set (e.g. `game_answers.verified_correct`
   + a `game_sessions.verified_at`), and marks Open-ended as manually-graded-or-excluded.
   Reuses one grader; no duplication.
2. **Grade-on-write RPC.** A `submit_game_answer` RPC that grades server-side at answer time
   against the snapshot (larger gameplay-path change; higher risk to live recovery).

Both require: immutable snapshot present (else the session is **ineligible**, never fabricated);
legacy client-authored sessions **excluded/labeled ineligible**; leaderboard reads only
`verified_*` fields. Estimated scope: new module + edge function + `verified_*` columns +
snapshot-backfill policy + tests. **This is the gate before any ranking ships.**

---

## 2. Identity architecture (audited — no migration needed)

- Authenticated players are already durably linked: `gamePlayerId = currentUser.id`
  (`rankd-app.jsx:24050`) is written as `player_id` in `game_session_participants` (join) and
  `game_players` (game end). The leaderboard identifies players by **`game_players.player_id ↔
  profiles.id` (same-tenant uuid join)** — which includes authenticated linked players and
  excludes guests / name-based ids.
- `endGameSession` has a latent fallback `player_id := p.id ?? p.playerId ?? p.name`
  (`gameService.js`) that can store a NAME for players lacking an id — those rows never match a
  profile and are correctly excluded. The leaderboard **must not** reuse the name-matching XP
  path (`awardGamePointsForSession`). No identity migration; no guest backfill.

## 3. Team-at-game-time snapshot (SHIPPED in 071)

**Snapshot timing (exact, honest definition):** `game_players` is inserted **at game
COMPLETION** (`endGameSession`), so 071 captures the player's team **at completion time — NOT
at join/start**. This is the intended beta definition. If a player's team changes *during* a
game, the **completion-time** team is what is captured. It is deliberately not join-time
identity, and no second table is given duplicate snapshot ownership. On UPDATE the trigger
freezes **only** `team_id`/`team_name` (it is not a whole-row freeze — `final_score`,
`final_rank`, `accuracy`, `name`, `emoji`, `color`, and any future column pass through), so
later score/display edits are preserved while the completion-time team snapshot stays immutable.

- Canonical owner: **`game_players`** (per-player, one-row-per-completed-session, written once
  at game completion). `game_session_participants` is mutable lobby presence and is NOT the owner.
- Additive `team_id uuid` + `team_name text`; stamped by a **SECURITY DEFINER BEFORE
  INSERT/UPDATE trigger** from the player_id's **same-tenant** profile; client value ignored;
  **immutable** on UPDATE; **NULL** for guests/no-team/cross-tenant/no-tenant; **no backfill**
  (existing rows stay NULL). Team transfers and renames never rewrite history. Verified by
  `supabase/tests/071_game_team_snapshot.test.sql` (8 assertions).

## 4. Timeframe boundaries (design; computed server-side, UTC)

**No tenant timezone exists** (`tenants` has none; `tenant_settings` has only jsonb blobs).
Per the approved rule, boundaries are computed **server-side in UTC** and the UI is labeled
"(UTC)". Never the browser timezone. (A future tenant timezone could live in
`tenant_settings.game_settings`; not added now.)

Trailing calendar-month windows including the current partial month, end = `now()`:

| Key | Start (UTC) | End |
|---|---|---|
| `this_month` (default) | `date_trunc('month', now())` | `now()` |
| `last_2_months` | `date_trunc('month', now()) - interval '1 month'` | `now()` |
| `last_3_months` | `date_trunc('month', now()) - interval '2 months'` | `now()` |
| `last_4_months` | `date_trunc('month', now()) - interval '3 months'` | `now()` |
| `last_12_months` | `date_trunc('month', now()) - interval '11 months'` | `now()` |

No week / quarter / all-time / tenure weighting. Sessions are bucketed by `game_sessions.ended_at`.

## 5. Individual ranking formula (design; applies to VERIFIED data once grading ships)

Per authenticated, same-tenant, eligible player over the selected window:
- `scored_questions` = verified answer rows on qualifying sessions (MC/TF/Type/Slider/Matching;
  Open-ended excluded from accuracy speed).
- `correct` = verified `is_correct = true`.
- `accuracy` = `correct / scored_questions` (recomputed from verified rows; the stored
  `accuracy`/`final_score` are never trusted).
- `qualifying_games` = distinct qualifying sessions.

**Order:** (1) accuracy DESC → (2) scored_questions DESC → (3) normalized correct-answer speed
ASC *only where trustworthy* → (4) deterministic final tie-break (`player_id`).
**Never lifetime points. Never speed on incorrect/skipped/unanswered/open-ended.**

**Ranked vs Provisional:** fully ranked only with **≥3 qualifying games AND ≥10 scored
questions**; otherwise shown separately as **Provisional**.

**Normalized correct speed:** utilization = `time_ms / question_time_limit_ms` for **correct,
non-open** answers, where the immutable snapshot supplies a valid limit; player metric =
median utilization; require a **defensible minimum valid-speed sample** (proposed ≥5 correct
timed answers with a limit). If inputs are insufficient → **no speed component / no Fast &
Accurate badge**; never fall back to raw ms across different limits.

Columns shown: rank, player, team snapshot (where available), accuracy, qualifying games,
scored questions, correct answers, correct-speed indicator (when supported), timeframe.

## 6. Insights (design)

- **Most Accurate:** eligible/non-Provisional only; highest accuracy; tie-break scored_questions
  then normalized correct speed; show nothing if no one qualifies.
- **Fast & Accurate:** eligible; accuracy ≥ 80%; correct answers only; utilization vs snapshot
  time limit; require the minimum valid-speed sample; no badge if inputs insufficient; never raw ms.
- **Most Improved:** DEFERRED until ≥2 comparable monthly periods have sufficient authenticated
  verified data. No placeholder.
- **No "Fastest Player."**

## 7. Qualifying sessions & population (design)

Include only: real `demo_mode=false`; durably completed sessions; **verified** answers (post-
grading); authenticated players linked to an **active same-tenant** profile; players with ≥1
scored question. Exclude: demo; cancelled/waiting/incomplete; guests/unlinked; inactive/removed
users; sessions with no answers; duplicate/orphan rows; speed for incorrect/skipped/unanswered/
open-ended. **Managers/admins excluded** from the competitive population — use the canonical
eligible-learner set (`role='user'`, active).

**Solo-session rule (explicit decision):** require **≥2 eligible authenticated participants in
the session** for it to count toward the leaderboard. Rationale + anti-gaming: a single-player
lobby is self-refereed (host = sole player, client-authored) and trivially farmable; requiring
≥2 eligible participants makes results peer-observed. **Production impact:** every current real
scored session had exactly 1 player → **zero sessions qualify today**, so the initial real
tenant will honestly show **insufficient data**. That is the correct, honest outcome and is not
a defect.

## 8. Team views (design; needs 071 snapshot + verified data)

Views: Organization→Individuals, Organization→Teams, Selected Team→Members. Team rank uses the
**071 immutable team snapshot** (never current membership). Method (to test): **average of
eligible-member accuracy** (or median) with a **minimum eligible participating members**
threshold to avoid size bias; never raw point sums. Show games/questions context; deterministic
ties. Insufficient team data → honest empty state.

## 9. Navigation (design; standalone Leaderboard retained until parity)

Ralli Live gains tabs, reusing the existing screen/services (no duplication):
- Manager: **Host · Leaderboard · Past Sessions** (default Host).
- Learner: **Play · Leaderboard · My Scores** (default Leaderboard/This Month).
Active tab persisted for refresh/direct restoration. The standalone `leaderboard` nav item and
`user_point_events`-based `LeaderboardScreen` are **kept until the Ralli Live replacement
reaches parity + live QA**, then removed in the final parity commit.

## 10. What ships in THIS branch

- `supabase/migrations/071_game_team_snapshot.sql` (additive team snapshot).
- `supabase/tests/071_game_team_snapshot.test.sql` (8 assertions).
- This design doc.
No frontend/nav/service change; no read RPC; standalone Leaderboard untouched. Migration applied
to a clean **local** DB only. **Stop for grading approval before building the read RPC + UI.**

---

# 072 slice — Server-authoritative VERIFICATION foundation

The §1 grading-trust blocker is now implemented as an honest, independent verification layer.
Nothing is applied to production and the Edge Function is not deployed; the frontend keeps
verification behind a safe "unavailable / unverified" state. **No ranking is built or exposed.**

## 11. Canonical grader architecture (one source of truth)

`src/lib/gameGrading.js` — a pure, runtime-neutral ES module (no imports; no browser/React/
Supabase/DOM/clock/random/tenant deps; deterministic; versioned `GRADER_VERSION =
"ralli-game-grader@1"`). It is imported **verbatim** by:
- the live host reveal path (`rankd-app.jsx` `doReveal()` — the 5 auto-gradable types now call
  `gradeAnswer()` for the correctness boolean; point/speed economy unchanged);
- the server verification path (`supabase/functions/verify-game-session/index.ts`, via a
  relative import — the eszip bundler follows it; `import_map.json` pins supabase-js);
- Node parity/unit tests (`src/lib/gameGrading.test.mjs`).

There is **no second grading implementation** (no SQL grader; the Edge Function does not
re-implement correctness). `gradeAnswer(question, submitted)` returns
`{ correct: boolean|null, eligibility, reason, detail? }`; `gradePersistedAnswer(question, row)`
and `buildSessionVerdicts(snapshot, answerRows)` adapt persisted `game_answers` rows to the
grader and are exactly what the Edge Function runs. Parity with the pre-072 shipped rules
(self-paced `isAnswerCorrect` + live `doReveal`) is locked by tests (13/13).

**Runtime-blocker decision:** RESOLVED — one dependency-free ESM module loads in Vite, Deno/
Edge, and Node. No duplicate grader is needed.

## 12. Supported vs ineligible question rules (exact)

| Type | Rule (canonical) | Eligibility |
|---|---|---|
| mc / tf | `submitted === question.correct` (option index) | `scored` (or `unanswered` if no submission) |
| type | trim+lowercase both sides; `acceptedAnswers.some(==)`; empty set ⇒ never correct | `scored` / `unanswered` |
| slider | `abs(value − target) ≤ tolerance`; `target/tolerance` via `??` so **0 is preserved** | `scored` / `unanswered` |
| match | every left slot paired to its own pair's right TEXT **and** count == pairs (order-independent) | `scored` / `unanswered` |
| open | never machine-verifiable → `correct = null` | `open_manual` (excluded until a trusted manual record exists) |
| skipped (host) | not a real (non-)answer | `skipped` (`correct = null`, not scored) |
| unknown/removed type | never guessed correct | `unsupported` (`correct = null`) |
| malformed question/answer | never throws; never accidentally correct | `malformed` |

Only `scored` answers count toward verified accuracy. `open_manual` requires a defensible
manual verification record (storage is future; excluded today).

## 13. Immutable verification storage contract (migration 072)

Two append-only, service-role-only tables (never overwrite client gameplay fields):
- `game_session_verifications` — one durable row per verified session: `status`
  (`complete`|`ineligible`), `reason`, `grader_version`, `snapshot_hash`, `question_count`,
  `verified_scored_answers`, `eligible_participant_count`, `verification_source`, `verified_at`,
  server-derived `tenant_id`. `UNIQUE(session_id)`. **No leaderboard rank is ever stored.**
- `game_answer_verifications` — immutable per-answer verdict: `verified_correct` (bool|null),
  `eligibility`, `reason`, `grader_version`, `snapshot_hash`, `question_idx`,
  `question_stable_id`, `answer_id`, `player_id`, `verification_method` (`auto`|`manual`),
  `manual_grader_id`, `tenant_id`. `UNIQUE(session_id, question_idx, player_id)`.

Guarantees (all test-proven, 19/19): RLS on; authenticated same-tenant **read only**; anon/
authenticated cannot INSERT/UPDATE/DELETE and cannot EXECUTE the writer; a BEFORE-UPDATE
trigger makes records immutable; `record_game_verification(session, grader_version, source,
verdicts)` is `SECURITY DEFINER`, `search_path=''`, EXECUTE = **service_role only**, atomic
(session+answers in one tx → partial failure verifies nothing), idempotent (repeat = no-op),
tenant-derived server-side, cross-session-safe (rejects verdicts referencing other sessions),
and honest: missing snapshot → durable `ineligible`/`no_snapshot`; frozen-hash mismatch →
integrity error; never backfills/guesses legacy sessions. Client `is_correct`/`points` are
never read (proven: a lying `is_correct=true` on a wrong option still verifies `false`).

## 14. Snapshot integrity (migration 072)

`game_sessions.question_snapshot` is now **write-once**: settable only while `status='waiting'`
(the existing create-time write), immutable thereafter — later rewrites/clears are rejected by
`trg_game_sessions_freeze_snapshot`. On first set the trigger stamps server-owned
`question_snapshot_hash` (md5 fingerprint) + `question_snapshot_frozen_at` (client values for
these ignored). Existing snapshot-bearing sessions were hash-backfilled (hash/frozen_at only;
snapshot bytes untouched). `live_question`, `phase`, `paused`, `status`, `ended_at`, analytics,
and phase recovery are unaffected. Legacy null-snapshot sessions stay honestly unverifiable
(cannot be retro-attached a snapshot once past `waiting`). Verification binds to the frozen hash.

## 15. Response-time trust finding (Fast & Accurate BLOCKER)

`game_answers.time_ms` is computed **entirely in the player's browser** (`Date.now() − qStartMs`
in `RankdGameScreen`, broadcast over realtime) and stored verbatim. `game_answers.answered_at`
is server-set but only at the **batch INSERT at reveal**, not at answer receipt — so there is
**no trustworthy server-receipt timestamp**. Therefore: response speed is **unverified**; no
verified-speed field is stored; **Fast & Accurate stays disabled** and normalized-speed ranking
is unavailable. Smallest honest future architecture (out of scope; needs approval, is a
gameplay-submission change): a server answer-submission path (RPC or Edge Function) that stamps
receipt time server-side per answer against the frozen snapshot's time limit — replacing the
realtime-broadcast answer with a server write. Not attempted here.

## 16. Leaderboard eligibility contract (server-authoritative; enforced by the future read RPC)

A session is leaderboard-eligible only when ALL hold: real (non-demo); durably `completed`;
immutable snapshot present and hash-bound; `game_session_verifications.status='complete'` with
no unresolved integrity error; **≥2 eligible authenticated same-tenant learner participants**
(`eligible_participant_count ≥ 2`, computed by 072 as active `role='user'` profiles with ≥1
`scored` verified answer); and ≥1 verified `scored` answer exists. A player counts only when:
active learner/rep profile, authenticated same-tenant identity, not a guest, not a manager/admin,
with ≥1 verified `scored` answer. **Accuracy uses only verified `scored` answers** (client
`is_correct`/`final_score`/`final_rank` are never leaderboard truth). Speed and Fast & Accurate
remain unavailable until server-receipt timing exists (§15). Production reality today: every
completed real session has exactly 1 participant → **zero sessions are eligible** (honest
insufficient-data state), and 33/41 completed sessions have no snapshot → unverifiable.

## 17. What ships in the 072 slice (and what does NOT)

Ships (locally validated only): `supabase/migrations/072_game_verification_foundation.sql`;
`supabase/tests/072_game_verification_foundation.test.sql` (19 checks); `src/lib/gameGrading.js`
+ `src/lib/gameGrading.test.mjs` (13 checks); `supabase/functions/verify-game-session/`
(index.ts + import_map.json, **not deployed**); host `doReveal` rewired onto the shared grader
(behavior-preserving); `gameService.requestSessionVerification` + a safe post-completion hook
(behind an unavailable/unverified state). **Does NOT:** apply 072, deploy the Edge Function,
build/expose any leaderboard read RPC or UI, remove the standalone Leaderboard nav, compute or
store ranks, or enable speed. **Remaining blocker before leaderboard UI:** apply 072 (preflight)
+ deploy `verify-game-session` + build the read RPC + UI under separate approval.
