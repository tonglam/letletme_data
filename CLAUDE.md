# CLAUDE.md

This file is the contributor contract for `letletme_data`. Keep it aligned with
the executable inventory; the documentation contract test checks the queues,
runtime entrypoints, and migration policy described here.

## Non-negotiable boundaries

1. PostgreSQL is the authority for business facts, current-season selection,
   scheduler obligations, and publication state. Redis is rebuildable state.
2. `CACHE_REDIS_*` and `QUEUE_REDIS_*` are separate endpoints. Never add an
   alternate namespace or silently fall back from one endpoint to the other.
3. `bun run db:migrate` is the only migration engine. A migration's complete
   filename is its identity; never rename or rewrite an applied migration.
4. Keep a PR independently releasable. Do not rely on a later PR to restore
   correctness, and preserve unrelated dirty worktrees.

## Commands

```bash
# Development
bun run dev
bun run worker:dev

# Production bundles (seven entrypoints are built together)
bun run build
bun run start
bun run worker:start
bun run scheduler:start
bun run live-picks-worker:start
bun run official-h2h-worker:start
bun run media-worker:start

# Tests: the default command is hermetic unit-only
bun run test
bun run test:integration       # requires explicit RUN_INTEGRATION=1 and safe targets
bun run test:all               # unit followed by guarded integration
bun run coverage               # unit LCOV/summary
bun run coverage:critical     # unit LCOV plus critical-path gates
bun run coverage:integration   # explicit integration coverage

# Quality and database
bun run typecheck
bun run lint
bun run format:check
bun run db:migrate
bun run db:migrate:status
bun run docs:contract
```

Unit tests must pass with no PostgreSQL, Redis, provider, or outbound network.
Integration tests fail closed unless `RUN_INTEGRATION=1` and the environment
guard proves a disposable loopback/test database plus distinct non-zero Redis
databases. Never copy production credentials into a test command.

## Runtime topology

Production runs seven long-lived services from the same immutable image:

| Service | Bundle | Responsibility |
| --- | --- | --- |
| `api` | `src/index.ts` | HTTP routes, readiness, compatibility/manual API surface |
| `worker` | `src/worker.ts` | Core, entry, league, tournament, Understat, and maintenance workers |
| `scheduler` | `src/scheduler.ts` | Durable obligation registry, claim, lease, and dispatch |
| `live-picks-worker` | `src/live-picks-worker.ts` | Live entry-picks refresh lane |
| `official-h2h-worker` | `src/official-h2h-worker.ts` | Official H2H live lane |
| `content-worker` | `src/content-worker.ts` | Content acquisition and publication delivery |
| `media-worker` | `src/media-worker.ts` | Source-media gates and archival delivery |

`docker-compose.yml` is the deployment inventory. Every long-lived service
uses the shared shutdown controller: stop intake, stop scheduler heartbeat and
new claims, drain in-flight work, close workers/queues, then close databases and
Redis. Compose gives each service a 45-second stop grace period; the application
shutdown budget is 30 seconds and fatal/timeout paths exit non-zero.

The standalone scheduler owns cadence and durable `ops.scheduler_obligations`.
API-side cron registrations are compatibility triggers only and must not become
a second schedule authority. Scheduler definitions, catch-up policy, and
success evidence live in `src/scheduler/job-registry.ts` and are exposed by
`GET /jobs`; `GET /jobs/status` is a protected operational endpoint.

## Queues and data flow

There are 24 queue names: 21 core queues plus three content queues. The
canonical list is `src/queues/names.ts`; do not hand-maintain another list.
BullMQ delivers work; it does not define business truth or scheduler success.

```text
official provider -> boundary schema/transformer -> service/domain
                  -> PostgreSQL canonical rows
                  -> immutable Redis publication (when the contract requires it)
                  -> GraphQL read model/cache -> product clients

scheduler obligation -> BullMQ queue -> worker -> durable checkpoint/publication
```

PostgreSQL commits before a Redis publication pointer moves. Publication
manifests are validated as a complete unit; readers never mix arbitrary Redis
items with PostgreSQL rows. My FPL deletion invalidation uses the durable
PostgreSQL outbox and a revision-aware Redis CAS worker.

## Layer responsibilities

| Layer | Directory | Responsibility |
| --- | --- | --- |
| API | `src/api/` | Thin Elysia handlers, auth, validation, and enqueueing |
| Domain | `src/domain/` | Types, Zod contracts, predicates, and pure policy |
| Services | `src/services/` | Business orchestration and transaction boundaries |
| Repositories | `src/repositories/` | Schema-qualified Drizzle/PostgreSQL access |
| Cache | `src/cache/` | Publication manifests and rebuildable Redis operations |
| Transformers | `src/transformers/` | Provider payload validation and domain mapping |
| Jobs | `src/jobs/` | Schedule compatibility adapters and enqueue contracts |
| Scheduler | `src/scheduler/` | Durable obligation registry and recovery |
| Queues | `src/queues/` | BullMQ instances, names, and Redis connection boundary |
| Workers | `src/workers/` | Queue handlers and worker runtime composition |

Domain code must not runtime-import infrastructure. Repositories must not
import API, service, worker, or job modules. Services must not import API
handlers. New exceptions require an explicit architecture-test allowlist entry.

## Redis contract

`CACHE_REDIS_*` holds `llm:data:*` immutable publications and is also the
separate owner of GraphQL's `llm:gql:*` cache. `QUEUE_REDIS_*` holds all
`bull:<queue>:*` state and bounded `llm:queue:coordination:*` leases/markers.
Understat business facts, player-market history, summaries, and tournament
reporting remain PostgreSQL reads. See [docs/redis-contract.md](docs/redis-contract.md)
and [docs/cache-ttl-summary.md](docs/cache-ttl-summary.md) for exact keys and
retention.

Never use `KEYS`, `FLUSHDB`, `FLUSHALL`, or unbounded deletion. Operational
cleanup must resolve an exact namespace, use bounded cursor `SCAN`, and delete
only validated keys with bounded `UNLINK` batches.

## Configuration and safety

Runtime configuration is parsed by the strict schemas in `src/utils/config.ts`
and `src/content/config.ts`. Malformed booleans, non-finite/non-integer
numbers, and out-of-range values fail startup; valid defaults are unchanged.
Do not use `Number(...) || default` for runtime configuration. Keep the total
database-pool budget within the documented application/Supavisor limits.

Containers run with a read-only root filesystem, a 256 MiB `noexec,nosuid,nodev`
`/tmp`, `cap_drop: ALL`, and `no-new-privileges`. The backup image is pinned to
the approved PostgreSQL 15 digest and may write only the backup volume.

## Migrations

Add one hand-written SQL file using the next available identity, update the
typed Drizzle mapping, and run migration status checks. Existing duplicate
numeric prefixes (`0016`, `0017`, `0018`, `0019`, `0020`, `0025`, `0026`,
`0032`) are grandfathered historical files; a new duplicate prefix is rejected.
The full filename, not the numeric prefix, is the ledger key. See
[migrations/README.md](migrations/README.md).

## Pull-request verification

Run format, lint, typecheck, unit, guarded integration (when a safe disposable
environment exists), seven-entrypoint build, compose validation, migration
contract, secret/dependency scans, and the documentation contract test. Keep a
PR Draft until the final head is stable. Exact-head review, required CI, and
unresolved actionable-thread checks remain merge gates; an explicitly recorded
Tong-authorized Codex quota waiver is a waiver, never a claim that review was
clean.

## Governance and review

- Global routes in `.codex/global-skills.json` are provisioned from immutable `tonglam/codex-workspace-config@7e92336ec04d38f7bb95620e304ce6ec6567c896:registry/workspace-assets.json` into the host Codex mount; use `python3 .codex/provision_global_skills.py --manifest .codex/global-skills.json --registry-source "$CODEX_WORKSPACE_CONFIG_CHECKOUT" --apply` with an authenticated local checkout, or explicitly add `--allow-network` only when approved. Do not vendor or copy unrelated global/plugin skills into this repository.
- Use `$gh-codex-review-loop` for PR work. A review may be skipped only after two consecutive explicit quota-limit responses for the unchanged head; record both responses and the exact SHA. This never waives CI, findings, or cleanup.
- Every P0-P3 finding must be dispositioned and its thread resolved. Only a finding confined to tests/scripts gets the time exception: implement P0/P1, and explain plus resolve P2/P3 without implementation time. P2/P3 anywhere else must be actually fixed and verified.
- Keep a complete finding ledger for the exact head; merge is prohibited while any finding is undispositioned or any review thread is unresolved. A quota override can skip only a new review request and never finding resolution.
- After merge, clean only the exact corresponding worktree, local branch, and remote branch after verifying identity; leave unrelated WIP untouched.
