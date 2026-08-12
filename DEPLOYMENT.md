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

GitHub's `GITHUB_TOKEN` authenticates the workflow to GHCR. The VPS keeps two untracked environment
files:

- `.env.deploy` for API/worker runtime configuration;
- `.env.migrate` for the direct Supabase `postgres` migration login.

Never commit either file. Runtime and migration passwords must remain separate. Explicitly configure
`CACHE_REDIS_*` and `QUEUE_REDIS_*`; startup rejects identical cache and queue endpoints.

## Automated deployment sequence

The `Deploy` workflow:

1. resolves the current protected `main` SHA and checks out that exact commit;
2. builds and pushes one `linux/amd64` image, then resolves its digest;
3. records the currently running image as the one retained rollback digest;
4. pulls the new digest and validates runtime environment plus migration-login capabilities;
5. stops API and worker, then requires database and queue work to be quiescent;
6. applies the migration chain and verifies its checksums/status;
7. verifies the database ownership and login contract;
8. rebuilds the active FPL core publication from PostgreSQL;
9. starts API and worker and verifies `/health`, `/ready`, and worker health.

Failure before migration starts restores the prior image. Once a destructive migration commits,
production moves forward with a correcting migration; an older application image must not be started
against the newer database contract.

## Host bootstrap

1. Install Docker Engine and the Compose plugin, then grant the deploy user Docker access.
2. Clone the repository into `VPS_WORKDIR`.
3. Create `.env.deploy` from `.env.deploy.example` and `.env.migrate` from
   `.env.migrate.example`.
4. Run `bash scripts/deploy.sh deploy` once.
5. Configure the GitHub variables and secret above.
6. Terminate TLS at the reverse proxy and expose only the required service ports.

## Service-key rotation

Data mutation routes require `x-api-key` when `ENABLE_AUTH=true`. Data stores only lowercase SHA-256
digests in `DATA_API_KEY_HASHES`; the trusted Web server stores the plaintext caller credential.
Rotate by temporarily adding both digests, switching Web to the new credential, verifying mutations,
and then removing the old digest.

## Runtime database password rotation

Routine deployments reconcile runtime LOGIN attributes and memberships but preserve passwords for
existing Data and GraphQL roles. Password changes are a coordinated control-plane operation: stop
every Data and GraphQL client on the VPS, wait at least two minutes for Supavisor's authentication
circuit breaker to clear, update the role and every corresponding runtime secret together, and only
then restart clients.

The provisioning command rejects existing-password rotation unless both
`--rotate-existing-passwords` and
`RUNTIME_LOGIN_ROTATION_ACK=all-clients-stopped` are supplied. Never add either to the ordinary
deployment workflow. After rotation, prove a fresh connection with each runtime role and watch the
first scheduled Data jobs; process liveness alone is not credential evidence.

## Operator commands

```bash
bash scripts/deploy.sh deploy
bash scripts/deploy.sh status
bash scripts/deploy.sh logs api
docker compose logs --since 1h api worker
docker compose run --rm -T migration bun run db:migrate:status
docker compose run --rm -T migration bun run db:migration-contract
```

`/health` proves process liveness. `/ready` also requires PostgreSQL, cache Redis, queue Redis, and
exactly one current `fpl.seasons` row. Publication integrity is verified independently by the deploy
workflow and the season-readiness procedure in
[docs/fpl-season-readiness.md](docs/fpl-season-readiness.md).

Production logs are structured JSON on container stdout. Docker retains bounded rotated files; use
`docker compose logs` rather than creating workspace log files.

## Synchronization diagnostics

Tournament setup emits `tournament_creation`, `tournament_creation_proxy`, and
`tournament_setup_attempt` events. Other top-level non-live jobs emit `data_sync_attempt`. Correlate
them by `tournamentId` or `runId`; do not log raw provider payloads, manager names, league URLs, or
credentials.

```bash
docker compose logs --no-color --no-log-prefix --since 24h api worker \
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
