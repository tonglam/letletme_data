# LetLetMe system contracts

## Repository ownership

| Repository | Responsibility | May write |
| --- | --- | --- |
| `letletme_data` | Provider ingestion, canonical facts, jobs, reporting refreshes, Data publications | `fpl`, `competition`, `understat`, `bridge`, `reporting`, `ops`; `llm:data:*`; DB1 queue state |
| `letletme-graphql` | Authorized public read API and query shaping | `llm:gql:*` query/security cache only |
| `letletme-web` | Browser UI, Better Auth, FPL binding, Mini Program session issuer | `bauth` only; trusted Data commands |
| `letletme-wechat-miniprogram` | Native client | No database or shared-cache writes |

## Sources of truth

| Concern | Canonical source | Rebuildable state |
| --- | --- | --- |
| Current season | Exactly one `fpl.seasons.is_current=true` row | none |
| FPL facts | `fpl.*` | Data core/live publications and GraphQL caches |
| Entry and tournament facts | `competition.*` | reporting models and GraphQL caches |
| Understat facts | `understat.*` | TTL-bound GraphQL query results only |
| Cross-provider links | verified `bridge.*` rows | query results |
| Sync/publication state | `ops.sync_runs`, `ops.sync_items`, `ops.dataset_publications` | logs and metrics |
| Identity | `bauth.*` | signed ingress and sessions |

PostgreSQL always wins when it disagrees with Redis. A provider or validation failure cannot
replace the last accepted database state or active publication.

## End-to-end data flow

1. Data validates provider payloads at the HTTP boundary.
2. Data writes complete season-keyed PostgreSQL units through schema-qualified repositories.
3. Data refreshes reporting views/materialized views only after completeness checks pass.
4. Data publishes complete core/live revisions under `llm:data:*`.
5. GraphQL validates one publication as a unit or reads one coherent PostgreSQL read model.
6. GraphQL caches query results by dataset revision, query name, arguments, and TTL.
7. Web owns identity and forwards authorized mutations to Data with a server credential.

## Database boundary

- Data schemas are private and excluded from Supabase Data API roles.
- `anon`, `authenticated`, and `service_role` have no Data-schema privileges.
- Data uses `letletme_data_writer`; GraphQL uses schema-qualified read-only access through
  `letletme_graphql_reader`.
- GraphQL performs no Data-owned DDL. Web is the only writer to `bauth`.
- FPL and Understat remain independent providers and combine only through verified `bridge` rows.
- `public` contains no application object.

## Redis boundary

- `CACHE_REDIS_*` contains `llm:data:*` publications and `llm:gql:*` cache entries.
- `QUEUE_REDIS_*` contains eight BullMQ queues and `llm:queue:coordination:*` state.
- Startup rejects an identical cache/queue host, port, and database tuple.
- Understat facts, player market history, summaries, and tournament reporting are not Data cache
  entities.
- Broad key enumeration or database flushes are prohibited.

The binding field, key, TTL, and ownership rules are in
[redis-contract.md](redis-contract.md).

## Authentication boundary

- End users authenticate only with Web.
- GraphQL accepts a signed Web ingress envelope, the Web public RSC service token, or a Mini Program
  bearer carried by signed ingress and verified against `bauth.mini_program_session`.
- Data mutation routes require `x-api-key` when `ENABLE_AUTH=true`; Data stores only SHA-256 digests.
- Web derives tournament administrator identity from the verified session and overwrites any
  browser-supplied identity before forwarding.

## Operational invariants

- The migration login, checksums, pending set, schema ownership, and database contract fail closed.
- `/health` is process liveness. `/ready` additionally requires PostgreSQL, both Redis endpoints,
  and one current season row.
- Core discovery commits events, teams, players, phases, and fixtures as one season-scoped unit.
- A different provider season fails before mutation; the wall clock never selects a season.
- Live publication validates the full player and fixture identity baseline before pointer swap.
- Tournament selection reporting refreshes only after every eligible entry has 15 valid picks and
  the event transfer checkpoint.
- League/tournament finalization remains eligible during the bounded 24-hour post-match window,
  including after GW38.
- There is one writer and one reader contract: no dual-write, shadow read, or alternate contract.
