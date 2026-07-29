# Ralli Live Leaderboard — Design + Grading-Trust Blocker (071 slice)

Status: **Trust-foundation slice only.** This branch ships migration 071 (team-at-game-time
snapshot) + tests. The leaderboard **read RPC and UI are intentionally NOT built** —
they are blocked on a server-authoritative grading decision (below). Nothing is applied
to production; nothing merged.

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

- Canonical owner: **`game_players`** (per-player, one-row-per-completed-session, written once
  at game end). `game_session_participants` is mutable lobby presence and is NOT the owner.
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
