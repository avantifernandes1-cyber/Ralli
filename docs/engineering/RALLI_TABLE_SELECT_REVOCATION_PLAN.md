# Ralli Live — `authenticated`/`anon` table-SELECT revocation plan (design, NOT a migration)

> **Status: PROPOSAL / design doc only.** This is deliberately **not** a numbered migration.
> A numbered migration file must never hold a proposal or commented-out no-op, because
> migration tooling could record that version as *applied* without ever enforcing the
> intended security change. The real revocation migration will be authored, gated, tested,
> and applied under separate approval once the prerequisite below is complete. When that
> happens it may take the **next available** migration number (080 is **not** reserved).

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

## Intended later sequence (do NOT implement steps 2–4 yet)

1. Apply and validate migration 079.
2. Remove the participant-table `postgres_changes` dependency **only after proving** Presence
   plus the existing durable `rpc_lobby_participants` polling provides correct lobby behavior.
3. Run full two-device lobby, leave, reconnect, refresh, and zero-player-halt QA.
4. Only then create the **real** revocation migration that revokes `authenticated`/`anon`
   `SELECT` from the four Ralli Live tables (next available migration number).
5. Validate all host, learner, analytics, recovery, and tenant-isolation paths before merging.
