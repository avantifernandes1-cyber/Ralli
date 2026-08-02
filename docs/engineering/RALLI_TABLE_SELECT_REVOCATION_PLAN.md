# Ralli Live — `authenticated`/`anon` table-SELECT revocation plan (design, NOT a migration)

> **Status: PROPOSAL / design doc only.** This is deliberately **not** a numbered migration.
> A numbered migration file must never hold a proposal or commented-out no-op, because
> migration tooling could record that version as *applied* without ever enforcing the
> intended security change. The real revocation migration will be authored, gated, tested,
> and applied under separate approval once the prerequisites below are complete.
>
> **Migration numbering (corrected at the 2026-07-31 checkpoint):** the final SELECT revocation
> will be migration **`082`**. Migration **`080_ralli_server_authorized_writes.sql`** is the
> Stage-C write cutover (applied); **`081`** is reserved for durable Ralli Live scoreboard
> recovery; so the revocation is **`082`**. (This supersedes the earlier note that called the
> revocation "081" — that was a numbering error only; the security design is unchanged.) Neither
> 081 nor 082 exists or is applied; neither is approved or complete.

## Stage B finding (why a bare revoke is unsafe) — resolved by 080

Rolled-back real-`authenticated` tests proved a bare `REVOKE SELECT` breaks **9 of 11**
client writes: every filtered `UPDATE`'s `WHERE` clause and the join `UPSERT`'s `ON CONFLICT`
path require `SELECT` on the referenced columns (`42501 permission denied`). Only the two pure
`INSERT`s (`game_players` final scores, `game_answers`) survive. Column-level `SELECT` grants
were rejected (they re-expose PIN / participant identity and still can't fix the join upsert).

## Stage C (migration 080, applied separately) — server-authorized writes

`080_ralli_server_authorized_writes.sql` moves the 9 filtered writes behind SECURITY DEFINER
RPCs so they run as the function owner (which keeps SELECT), making the later revocation safe:
- Host (authorized via owner-only `ralli_can_manage_session`): `rpc_start_session`,
  `rpc_end_session` (session + participant completion, atomic), `rpc_cancel_session`,
  `rpc_set_session_phase`, `rpc_save_question_snapshot` (write-once).
- Learner self (`player_id = auth.uid()`): `rpc_participant_join` (idempotent upsert),
  `rpc_participant_leave`, `rpc_participant_heartbeat`.
- Reused, not duplicated: `rpc_rejoin_session` (078), `rpc_host_publish_reveal` (079).
- The two pure INSERTs (`game_players`, `game_answers`) are intentionally left as direct
  writes here; their write-trust hardening is the separate **migration 072** workstream.

After 080 the only direct operations on the four tables are those two INSERTs.

## Goal

Revoke direct `authenticated`/`anon` `SELECT` on the four Ralli Live tables so that **all**
reads go through the safe `SECURITY DEFINER` RPCs (073 learner + 075 host/manager + 077
learner-joinable + 078 rejoin + 079 reveal/award). This closes the proven gap where a
same-tenant **learner** can directly read `question_snapshot`, `live_question` (live
canonical answers), and another player's answers.

## Prerequisites (must all be true before the revocation migration is authored/applied)

- **079 applied and validated** (reveal/award reads cut over) and 073/075/077/078 applied.
- Frontend has **no** direct `.select()` on the four tables — verified: 0 remain.
- The **one** realtime `postgres_changes` subscription
  (`gameService.subscribeToLobbyParticipants` on `game_session_participants`) is **removed**
  and replaced by Presence + the `rpc_lobby_participants` poll.
  - **Proof it needs SELECT:** Supabase Realtime authorizes `postgres_changes` delivery via
    the subscriber's role `SELECT` + RLS on the changed table; with `SELECT` revoked from
    `authenticated`, it delivers nothing.
  - **Smallest safe alternative:** drop that subscription — the host lobby already has
    realtime **Presence** (connected roster) **and** a 4s `rpc_lobby_participants` poll
    (durable roster). If instant DB-insert notification were ever required, a dedicated
    column-limited SELECT for realtime only is possible, but Presence + poll suffice
    (not adopted).

## What is revoked (grant level)

`SELECT` on the four tables from `authenticated`, `anon`:

```sql
REVOKE SELECT ON public.game_sessions             FROM authenticated, anon;
REVOKE SELECT ON public.game_answers              FROM authenticated, anon;
REVOKE SELECT ON public.game_players              FROM authenticated, anon;
REVOKE SELECT ON public.game_session_participants FROM authenticated, anon;
```

## What remains

- `authenticated`/`anon` keep `INSERT`/`UPDATE` where they already have them — writes need
  no `SELECT` after the 079-turn return-path redesigns (`saveGameAnswers` INSERT; participant
  upsert / left / heartbeat / completed UPDATE; session start / end / phase / snapshot /
  cancel UPDATE).
- `service_role` keeps **all** privileges (background jobs / edge).
- The `SECURITY DEFINER` RPCs run as their owner and read the tables regardless of the
  `authenticated` grant — every safe read keeps working.
- **RLS:** existing `SELECT` policies are left in place (defense-in-depth; moot once the grant
  is gone). No policy is dropped. No column, table, or data change.

## End state

An ordinary learner can no longer directly read: `question_snapshot`, `live_question`,
another player's answers, correctness/points pre-reveal, manager analytics, or cross-player
history. Completed learner review still works via `rpc_my_completed_session_review` (073).

## Rollback / operational recovery (forward-only)

- If a safe RPC is found missing a field a surface needs, **add the field to that RPC** (a new
  forward migration) rather than re-granting table `SELECT`.
- Emergency re-grant (only if a Sev-1 read outage is traced to this revocation): a one-line
  forward migration `GRANT SELECT ON public.<table> TO authenticated;` — temporary, then
  re-close.
- Realtime recovery: re-enable the removed subscription only alongside a re-grant.

## Sequence (status as of Stage C)

1. ✅ Migration 079 (reveal/award read cutover) — applied & validated.
2. ✅ Participant-table `postgres_changes` dependency removed; Presence + durable
   `rpc_lobby_participants` proven in two-device QA (Stage A).
3. ✅ Stage B — proved a bare revoke breaks 9/11 writes.
4. ✅ Stage C — migration **080** (server-authorized write RPCs) authored + tested + frontend
   cut over, and **applied to production** (version `20260731010835`).
5. ⏳ **Migration 082** = `REVOKE SELECT ON the four tables FROM authenticated, anon` — the final
   direct-table SELECT revocation (081 is reserved for durable scoreboard recovery). Authored only
   **after** the full host/learner/recovery/reveal/scoring/analytics/tenant-isolation QA passes,
   then gated + applied under separate approval. Does not exist / not applied / not approved.
6. Validate all paths post-082; re-prove the confidentiality matrix before merging.
