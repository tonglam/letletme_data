# Deployment guide

Production uses Docker Compose on the VPS and deploys automatically after the `main` CI workflow
succeeds. The deployment builds one image, records its immutable digest, and runs that exact image
through migration, publication, and service startup.

## Required repository configuration

| Type | Name | Purpose |
| --- | --- | --- |
| Variable | `VPS_HOST` | VPS hostname or IP |
| Variable | `VPS_USER` | SSH user with Docker access |
| Variable | `VPS_WORKDIR` | Directory containing `docker-compose.yml` |
| Secret | `VPS_SSH_KEY` | SSH private key for the deploy user |
| Secret | `VPS_SSH_KNOWN_HOSTS` | Out-of-band verified host key entries |
| Secret | `VPS_SSH_FINGERPRINT` | SHA-256 fingerprint matched against `VPS_SSH_KNOWN_HOSTS` |

GitHub's `GITHUB_TOKEN` authenticates the workflow to GHCR. VPS workflows use the repository's
pinned OpenSSH composite action with `StrictHostKeyChecking=yes` and `IdentitiesOnly=yes`; they
never discover host keys at deploy time. The VPS keeps two untracked environment
files:

- `.env.deploy` for the seven long-lived runtime services;
- `.env.migrate` for the direct Supabase `postgres` migration login, or the
  Supavisor session-mode equivalent on port 5432 when the host has no IPv6 route.

Never commit either file. Runtime and migration passwords must remain separate. Explicitly configure
`CACHE_REDIS_*` and `QUEUE_REDIS_*`; startup rejects identical cache and queue endpoints.

## Automated deployment sequence

The `Deploy` workflow:

1. resolves the current protected `main` SHA and checks out that exact commit;
2. builds and pushes one `linux/amd64` image, then resolves its digest;
3. records the currently running image as the one retained rollback digest;
4. pulls the new digest and validates runtime environment plus migration-login capabilities;
5. stops all seven long-lived services (`api`, `worker`, `scheduler`,
   `live-picks-worker`, `official-h2h-worker`, `content-worker`, and
   `media-worker`) with the 45-second Compose grace period, then requires
   database and queue work to be quiescent;
6. creates and validates an external custom-format PostgreSQL backup before migration;
7. applies the migration chain and verifies its checksums/status;
8. verifies the database ownership and login contract;
9. rebuilds the active FPL core publication from PostgreSQL;
10. starts all seven services and verifies `/health/live`, `/health/ready`, and the six
    worker/scheduler runtime heartbeats.

Failure before migration starts restores the prior image. Once a destructive migration commits,
production moves forward with a correcting migration; an older application image must not be started
against the newer database contract.

## Host bootstrap

1. Install Docker Engine and the Compose plugin, then grant the deploy user Docker access.
2. Clone the repository into `VPS_WORKDIR`.
3. Create `.env.deploy` from `.env.deploy.example` and `.env.migrate` from
   `.env.migrate.example`. Prefer the direct endpoint; on an IPv4-only host use
   the Supavisor session endpoint (`*.pooler.supabase.com:5432`) with the
   `postgres.<project-ref>` user. Do not use transaction mode (`:6543`) or
   `pgbouncer=true`.
4. Apply migrations with the migration environment: `docker compose run --rm -T migration bun run db:migrate`.
5. Bootstrap each missing LOGIN exactly once, using a complete initial runtime URL each time:

   ```bash
   RUNTIME_DATABASE_URL='<complete Data runtime URL>' \
     docker compose run --rm -T -e RUNTIME_DATABASE_URL migration \
     bun run db:bootstrap-runtime-login -- --target=data
   RUNTIME_DATABASE_URL='<complete GraphQL runtime URL>' \
     docker compose run --rm -T -e RUNTIME_DATABASE_URL migration \
     bun run db:bootstrap-runtime-login -- --target=graphql
   ```

6. Run `docker compose run --rm -T migration bun run db:verify-runtime-logins`, then run
   `bash scripts/deploy.sh deploy`. Ordinary deployments only run this read-only verifier and must
   never run either bootstrap command.
7. Configure the GitHub variables and secrets above. Verify `VPS_SSH_KNOWN_HOSTS` and
   `VPS_SSH_FINGERPRINT` through a separate trusted channel before saving them.
8. Terminate TLS at the reverse proxy and expose only the required service ports.

## Service-key rotation

Data mutation routes require `x-api-key` when `ENABLE_AUTH=true`. Data stores only lowercase SHA-256
digests in `DATA_API_KEY_HASHES`; the trusted Web server stores the plaintext caller credential.
Rotate by temporarily adding both digests, switching Web to the new credential, verifying mutations,
and then removing the old digest.

## Runtime database credentials

Routine deployment has no password input and no credential-mutation path. It checks the Data and
GraphQL LOGIN attributes, locked capability roles, and exact memberships using the migration
connection, and reports `credentialMutated: false`. The bootstrap command creates only a missing
LOGIN; when the selected LOGIN already exists it validates the existing identity without DDL and
without changing its password.

This repository intentionally provides no password-rotation command. A future rotation must be
designed as a separately reviewed control-plane operation that coordinates every client and proves
fresh connections before traffic resumes.

## Operator commands

```bash
bash scripts/deploy.sh deploy
bash scripts/deploy.sh status
bash scripts/deploy.sh logs api
docker compose logs --since 1h api worker scheduler live-picks-worker official-h2h-worker content-worker media-worker
docker compose run --rm -T migration bun run db:migrate:status
docker compose run --rm -T migration bun run db:migrate -- --storage-migration
docker compose run --rm -T migration bun run db:migrate -- --storage-migration --apply
docker compose run --rm -T migration bun run db:migration-contract
docker compose run --rm -T migration bun run db:verify-runtime-logins
```

`/health/live` proves process liveness. `/health/ready` also requires PostgreSQL, cache Redis, queue Redis, and
exactly one current `fpl.seasons` row. Publication integrity is verified independently by the deploy
workflow and the season-readiness procedure in
[docs/fpl-season-readiness.md](docs/fpl-season-readiness.md).

Before the first production schema change, restore the newest retained dump into a disposable
PostgreSQL 15 instance and run `scripts/verify-backup-restore.sh`; repeat this round-trip at least
quarterly. The restore target must be disposable and must never be the production database.

Production logs are structured JSON on container stdout. Docker retains bounded rotated files; use
`docker compose logs` rather than creating workspace log files.

## Synchronization diagnostics

Tournament setup emits `tournament_creation`, `tournament_creation_proxy`, and
`tournament_setup_attempt` events. Other top-level non-live jobs emit `data_sync_attempt`. Correlate
them by `tournamentId` or `runId`; do not log raw provider payloads, manager names, league URLs, or
credentials.

```bash
docker compose logs --no-color --no-log-prefix --since 24h api worker scheduler live-picks-worker official-h2h-worker content-worker media-worker \
  | jq -Rc --arg runId 'entry-picks-2627-7' '
      fromjson?
      | select(.event == "data_sync_attempt" and .runId == $runId)
    '
```

Do not infer success from worker completion alone. A `partial` outcome or a non-zero failed-unit
count remains actionable. Final retry failures continue through the configured notification path.

A retained `llm:queue:coordination:launch-notification:*:lock` may mean notification delivery
succeeded before the durable marker was written. Verify the destination first. Write the marker if
delivery succeeded; delete only the exact transition lock if delivery definitely failed.
