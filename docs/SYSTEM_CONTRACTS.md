# LetLetMe system contracts

This repository participates in one four-repository system:

| Repository | Runtime responsibility | May write |
| --- | --- | --- |
| `letletme_data` | FPL ingestion, validation, jobs, canonical facts, reporting refreshes, Data publications | `fpl`, `competition`, `understat`, `bridge`, `reporting`, `ops`; `llm:v3:data:*`; queue state |
| `letletme-graphql` | Public read API, authorization, query shaping | Its revision-keyed `llm:v3:gql:*` query cache only |
| `letletme-web` | Browser UI, Better Auth, verified FPL binding, Mini Program session issuer | `bauth` only; invokes Data mutations with a server credential |
| `letletme-wechat-miniprogram` | Native client | No database or shared-cache writes |

## End-to-end flow

1. Data validates official FPL payloads at the HTTP boundary.
2. Data writes canonical, season-keyed PostgreSQL rows through schema-qualified repositories.
3. Data refreshes reporting views/materialized views only after their completeness gates pass.
4. Data publishes complete core/live Redis revisions under `llm:v3:data:*`.
5. GraphQL reads through a read-only PostgreSQL role and the typed Data publication contract. A
   rejected cache revision falls back to one coherent PostgreSQL dataset, never per-item mixing.
6. GraphQL query caches include both GraphQL schema version and Data dataset revision.
7. Web owns identity in `bauth` and forwards authorized mutations to Data.

## Sources of truth

| Concern | Canonical source | Rebuildable/derived state |
| --- | --- | --- |
| Current FPL season | Exactly one `fpl.seasons.is_current=true` row | None; Redis and time are not authorities |
| FPL facts | `fpl.*`, written by Data | Data core/live publications, GraphQL caches |
| Entry/tournament facts | `competition.*`, written by Data | `reporting.*`, GraphQL caches |
| Understat facts | `understat.*`, written by its independent Data pipeline | Limited GraphQL cache only |
| Cross-provider links | Verified `bridge.*` rows | Query results |
| Sync/publication state | `ops.sync_runs`, `ops.sync_items`, `ops.dataset_publications` | Logs/metrics |
| Website identity | `bauth.*`, written by Web/Better Auth | Signed envelopes and sessions |
| Data migration history | Drizzle journal plus `ops.schema_migrations` | Deployment logs |

PostgreSQL always wins when it disagrees with Redis. A source validation error cannot replace the
last accepted canonical state or active publication.

## Database ownership and security

- Data schemas are private and excluded from Supabase Data API roles.
- `anon`, `authenticated`, and `service_role` have no Data-schema privileges.
- Data runs as its writer role; GraphQL uses `letletme_graphql_reader` with schema-qualified
  `SELECT` only.
- GraphQL performs no business DDL and has no migration runner for Data-owned schemas.
- Web remains the only writer to `bauth`; Data and GraphQL do not mutate auth rows.
- Provider writes stay isolated. FPL and Understat combine only through verified `bridge` rows.

## Redis ownership

- `CACHE_REDIS_*` contains rebuildable Data publications only.
- `QUEUE_REDIS_*` contains BullMQ and `llm:v3:queue:coordination:*` state only.
- Startup rejects an identical cache/queue host, port, and database tuple.
- Data publication manifests are atomic and immutable. Staging TTL is 15 minutes; retired revision
  TTL is 24 hours; active manifests/items have no TTL.
- Understat, player value history, player season summaries, and tournament reporting are not Data
  Redis entities.
- Scoped legacy cleanup uses allowlisted `SCAN` plus `UNLINK`; broad `KEYS`, `FLUSHDB`, and
  `FLUSHALL` are prohibited.

The binding key and manifest shapes are in [redis-contract.md](redis-contract.md).

## Authentication boundary

- End users authenticate only with Web. Data never accepts browser identity headers as authority.
- Data mutation routes require `x-api-key` when `ENABLE_AUTH=true`; only SHA-256 digests are
  configured and overlap is supported during rotation.
- Web derives tournament administrator identity from the verified session and overwrites any
  browser-supplied identity before forwarding a command.
- Network policy still restricts Data to trusted callers.

## Operational invariants

- Run both migrators and require `bun run db:migrate:status` to pass. A checksum mismatch,
  missing ledgered file, or backdated migration fails closed.
- `/health` is process liveness. `/ready` requires PostgreSQL, cache Redis, queue Redis, and one
  current `fpl.seasons` row.
- Core discovery reads one bootstrap payload and one season-wide fixture payload, then commits
  events, teams, players, phases, and fixtures as one season-scoped unit.
- A different upstream season fails before mutation. Changing `is_current` follows the explicit
  season-readiness/cutover procedure.
- Live publication validates the full player and fixture identity baseline before pointer swap.
- Tournament selection reporting refreshes only after every eligible entry has 15 valid picks and
  the transfer checkpoint for that event.
- League/tournament finalization remains eligible in the bounded 24-hour post-match window,
  including after GW38.
- Production v3 activation and later v2 deletion are separate, exact approval gates. There is no
  dual-write, shadow read, or v2 schema fallback after activation.
