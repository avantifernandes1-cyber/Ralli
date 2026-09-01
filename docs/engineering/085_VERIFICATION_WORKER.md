# Ralli Live — Verification Queue Worker (migration 085)

Server-owned process that drains the durable verification outbox (`game_verification_queue`) so a
completed real Ralli Live session is **always** verified, independent of the host browser. It replaces
the fragile fire-and-forget host-browser invocation as the durability guarantee.

**Status: implemented locally, NOT deployed and NOT scheduled.** Deploying/scheduling requires separate
approval (it is a production mutation).

## Pieces

- `supabase/functions/_shared/verifySession.js` — canonical per-session verification: loads the frozen
  snapshot + raw answers, grades with the ONE shared grader (`_shared/gameGrading.js`), and records
  append-only verdicts via the service-role-only `record_game_verification` RPC (migration 072).
  Idempotent. Reused by the worker (and available to the on-demand `verify-game-session` function).
- `supabase/functions/_shared/verifyQueueWorker.js` — pure, dependency-injected batch orchestrator +
  the service-role auth gate (`isAuthorizedWorkerRequest`, `safeEqual`) + `sanitizeError`. Unit-tested.
- `supabase/functions/verify-queue-worker/index.ts` — thin Deno HTTP entrypoint wiring the real
  claim/verify/complete calls into the orchestrator.

## Authorization

- The worker is **service-role only**. The caller MUST send `Authorization: Bearer <SERVICE_ROLE_KEY>`;
  anonymous and ordinary authenticated callers get `401`.
- All DB work uses a service-role client. The migration-085 `rpc_claim_verification_job` /
  `rpc_complete_verification_job` RPCs additionally enforce the `service_role` JWT role and are revoked
  from `anon`/`authenticated`, so the queue cannot be claimed by any user path.
- The service-role key is read from the function env; it is never returned or logged.

## Environment (function secrets)

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

## Deploy (requires separate approval — do NOT run as part of the leaderboard slice)

```
supabase functions deploy verify-queue-worker
```

## Schedule (requires separate approval)

Invoke roughly once per minute via an approved Supabase mechanism (pg_cron + pg_net, or the dashboard
Scheduled Functions), as `POST` with header `Authorization: Bearer <SERVICE_ROLE_KEY>`. Each invocation
processes a bounded batch and returns quickly; a missed tick is harmless (the next tick drains the backlog).

## Batch / concurrency / lease

- Bounded per invocation: `MAX_BATCH = 10`, wall-clock budget `MAX_RUNTIME_MS = 25000`.
- Claims use `FOR UPDATE SKIP LOCKED`, so parallel invocations never claim the same job.
- Each claim takes a **processing lease** (`lease_expires_at = now() + ralli_verification_lease_window()`,
  currently 5 minutes). The worker's runtime budget (25s) is far below the lease, so a live worker's
  in-flight job is never stolen.
- **Crash recovery:** if a worker dies mid-job the row stays `processing`; once its lease expires the job
  becomes reclaimable by the next invocation (attempts is bumped on reclaim). No job is ever permanently
  stuck. `rpc_complete_verification_job` releases the lease on success and on retry/terminal.

## Retry / terminal rules

- Success (`p_ok = true`) → `completed`, `last_error` cleared, lease released.
- Transient failure (`p_ok = false`) → `pending` with exponential backoff
  (`next_attempt_at = now() + min(3600s, 2^attempts · 30s)`), lease released, until `attempts >= 6`,
  after which the job is marked terminal `failed`.
- `last_error` stores only a short, whitelisted/generic code — never answers, snapshots, tokens, or secrets.

## Operational failure signal

Inspect the outbox (service-role / SQL console):

```
SELECT state, count(*) FROM public.game_verification_queue GROUP BY state;
SELECT session_id, attempts, next_attempt_at, last_error
FROM public.game_verification_queue WHERE state = 'failed' ORDER BY updated_at DESC;
```

A rising `failed` count is the alert condition. `last_error` is safe to surface operationally (no
answer/snapshot/secret material). The leaderboard treats a session with no verification as "not yet
verified" — never as a failed or zero-scoring game.
