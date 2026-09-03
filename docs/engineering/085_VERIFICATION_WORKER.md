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

Set as **protected Edge Function secrets** (never in committed files, client env, or Vercel public vars):

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

The worker reads both from `Deno.env` at runtime (protected runtime configuration). The service-role key
is never returned, never logged, and never placed in SQL, migrations, docs, source, or browser requests.

## Deploy (requires separate approval — do NOT run as part of the leaderboard slice)

```
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=<paste-in-a-secure-shell-not-committed>
supabase functions deploy verify-queue-worker
```

Use placeholders only in docs. `<...>` above is a placeholder; never commit a real token-like value.

## Secure scheduling & secret handling (requires separate approval)

Invoke roughly once per minute; each invocation drains a bounded batch and a missed tick is harmless
(the next tick catches up). The scheduled caller must present `Authorization: Bearer <service-role-key>`,
and **that credential must come from protected secret storage — never hardcoded in the schedule SQL.**

Approved approach — Supabase Vault (encrypted project secret) + `pg_cron` + `pg_net`:

1. Store the key once in Vault (encrypted at rest), e.g. as a secret named `verify_worker_bearer`. Do
   this via the dashboard or a secure shell — **not** in a committed migration.
2. Schedule with `pg_cron`, reading the secret from Vault at call time so the raw token never appears in
   the job definition or `cron.job` catalog:

```sql
-- Placeholders only. The Authorization value is pulled from Vault at runtime; no token in this SQL.
select cron.schedule(
  'ralli-verify-queue',            -- job name
  '* * * * *',                     -- every minute
  $cron$
    select net.http_post(
      url    := '<project-functions-url>/verify-queue-worker',
      headers:= jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret
                                        from vault.decrypted_secrets
                                        where name = 'verify_worker_bearer')
      ),
      body   := '{}'::jsonb
    );
  $cron$
);
```

Alternatively, use the platform's protected **Scheduled Functions** mechanism, which stores the invocation
secret in the same protected secret store and never exposes it to the repo or the client.

### Rotation

1. Set the new service-role key as the Edge Function secret (`supabase secrets set ...`) and update the
   Vault secret `verify_worker_bearer` to match.
2. Redeploy the function (picks up the new env secret).
3. Revoke the old key in the Supabase dashboard.
   The worker's `safeEqual` gate compares the presented bearer to the current env key, so a stale token
   stops working the moment the env secret is rotated — no code change required.

### Log redaction & local development

- Never log `Authorization` headers, bearer tokens, or the service-role key. The worker emits **no**
  `console.*` output; any future logging must redact these. `last_error` in the queue stores only short
  whitelisted codes (no secrets/answers/snapshots).
- Local development uses an **uncommitted** `supabase/functions/.env` (git-ignored) or the local
  `supabase start` secret store — never a committed `.env` and never the client `.env.local`.

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
