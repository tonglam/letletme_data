# LetLetMe system contracts

This is the cross-repository runtime contract. It describes ownership and
authority, not a deployment claim. The executable inventory is checked by
`tests/unit/documentation-contract.test.ts`.

## Repository ownership

| Repository | Responsibility | May write |
| --- | --- | --- |
| `letletme_data` | Provider ingestion, canonical facts, jobs, reporting refreshes, Data publications | `fpl`, `competition`, `understat`, `bridge`, `reporting`, `ops`; `llm:data:*`; BullMQ/coordination state |
| `letletme-graphql` | Authorized public read API and query shaping | `llm:gql:*` query/security cache only |
| `letletme-web` | Browser identity, FPL binding, Mini Program session issuer | `bauth` and authorized Data commands |
| `letletme-wechat-miniprogram` | Native client | No database or shared-cache writes |

## Authority and read models

| Concern | Durable authority | Rebuildable or derived state |
| --- | --- | --- |
| Current season | exactly one `fpl.seasons.is_current = true` row | none |
| FPL facts | `fpl.*` | immutable core/live publications and GraphQL caches |
| Entry/tournament facts | `competition.*` | reporting models and GraphQL caches |
| Understat facts | `understat.*` | PostgreSQL staging and optional GraphQL query cache |
| Cross-provider links | verified `bridge.*` rows | query results |
| Sync/publication state | `ops.sync_runs`, `ops.sync_items`, `ops.dataset_publications`, outboxes | logs and metrics |
| Scheduler state | `ops.scheduler_obligations` and scheduler lanes | BullMQ delivery records |
| Identity | `bauth.*` | signed ingress and sessions |

PostgreSQL wins when it disagrees with Redis. A provider, validation, or Redis
failure cannot replace the last accepted canonical state or active publication.

## End-to-end flow

1. A provider payload is validated at the HTTP/provider boundary and transformed
   into domain values.
2. A service/repository commits complete, season- or event-scoped PostgreSQL
   units and their durable checkpoints.
3. When the contract requires a read model, a complete immutable Redis revision
   is staged and its active pointer is swapped only after verification.
4. GraphQL reads one publication as a unit or one coherent PostgreSQL fallback,
   then may cache the result by dataset revision and query arguments.
5. Product clients read through GraphQL; Web remains the identity/mutation
   boundary.

The scheduler reserves a durable obligation before dispatching a BullMQ job.
BullMQ is a delivery mechanism and retained history, not the source of
schedule truth or business completion. `GET /jobs` is generated from the
registry and compatibility aliases; `GET /jobs/status` is protected.

Manager Live keeps its public compatibility facade at
`src/services/manager-live.service.ts`, while contracts, publication storage,
coverage/result assembly, provider coordination, Classic refresh, final-result
projection, and orchestration are separate modules. The orchestration module
reaches PostgreSQL, Redis, queues, providers, and the clock only through ports
bound by the production composition adapter.

## Runtime topology

The production image is used by seven long-lived services:

`api`, `worker`, `scheduler`, `live-picks-worker`, `official-h2h-worker`,
`content-worker`, and `media-worker`.

Each service uses the shared idempotent shutdown controller. On SIGTERM/SIGINT
it stops intake and scheduler claims, drains in-flight work, closes workers and
queues, then closes database and Redis clients. The application budget is 30
seconds; Compose provides a 45-second stop grace period. A fatal or timed-out
shutdown exits non-zero.

## Database boundary

- Data schemas are private and excluded from Supabase Data API roles.
- `anon`, `authenticated`, and `service_role` have no Data-schema privileges.
- Runtime writes use `letletme_data_writer`; GraphQL uses the
  schema-qualified read-only contract.
- GraphQL performs no Data-owned DDL. Web is the only writer to `bauth`.
- FPL and Understat remain independent providers and combine only through
  verified `bridge` rows.
- `public` contains no application object.

`bun run db:migrate` is the sole migration entry point. The ledger identity is
the complete migration filename and checksums are verified before every apply.
The historical duplicate numeric prefixes are explicitly grandfathered; a new
duplicate prefix is rejected by the migration contract test.

The typed Drizzle platform schema follows the same ownership boundaries:
namespaces/enums, FPL, competition/My FPL, ops, Understat/bridge, market, and
reporting are separate declaration modules. `platform.schema.ts` and
`index.schema.ts` remain compatibility barrels; runtime export names and the
resulting disposable PostgreSQL catalog are parity-gated.

## Redis boundary

- `CACHE_REDIS_*` contains Data's `llm:data:*` publications. GraphQL owns its
  separate `llm:gql:*` query/security cache on the same cache endpoint.
- `QUEUE_REDIS_*` contains all 24 BullMQ queue namespaces and bounded
  `llm:queue:coordination:*` state.
- Startup rejects an identical cache/queue host, port, and database tuple.
- Understat facts, player market history, summaries, and tournament reporting
  are not Data-owned business caches.
- Redis cleanup is exact and bounded (`SCAN` + validated `UNLINK`); never use
  `KEYS`, `FLUSHDB`, or `FLUSHALL`.

See [redis-contract.md](redis-contract.md) and
[cache-ttl-summary.md](cache-ttl-summary.md) for key shapes and retention.

## Authentication and operational invariants

- End users authenticate through Web. Data mutation routes require `x-api-key`
  when `ENABLE_AUTH=true`; only SHA-256 digests are stored.
- `/health` is process liveness. `/ready` requires PostgreSQL, both Redis
  endpoints, the current-season row, runtime heartbeats, and publication
  consistency checks.
- Core discovery commits events, teams, players, phases, and fixtures as one
  season-scoped unit; a different provider season fails before mutation.
- Live and manager-live publications validate their complete identity baseline
  before pointer swap. My FPL deletion writes the invalidation outbox in the
  same PostgreSQL transaction as deletion and uses revision-aware Redis CAS.
- Tournament and league finalization remain eligible in the bounded post-match
  window, including after GW38.
- There is one reader/writer contract: no dual-write, shadow read, or alternate
  namespace introduced for compatibility.
