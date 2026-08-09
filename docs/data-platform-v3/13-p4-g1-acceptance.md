# P4 G1 GraphQL PostgreSQL reader acceptance

Plan version: 3.2.3

Date: 2026-08-09

GraphQL branch: `codex/data-platform-v3-pg-readers`

Accepted GraphQL commit: `886351b1c26d86f5e8010cb57e8d5f33469423c8`

GraphQL baseline: `3cc9951450ac5c631ea8930b0eb8c7a71a572fb6`

Accepted Data contract: `cb49317ad04ac9a1a727f079acacfb12493a0004`

## Outcome

G1 moves FPL, competition, and reporting business reads from the Supabase Data API to a typed,
schema-qualified PostgreSQL 15 reader. The repository no longer contains a Supabase client,
dependency, environment contract, business migration directory, migration runner, or deploy-time
business DDL.

Exactly one `fpl.seasons.is_current = true` row is the request season authority. Startup performs
only `SELECT` statements and refuses to open a port unless all registered read-model columns,
the active `fpl:core` publication, plan/schema versions, PostgreSQL major, and read-only ACL
boundaries match.

`reporting.tournament_selection_stats` is consumed as the materialized source of counts and all
four percentages. GraphQL does not recompute selection, captain, vice-captain, or effective
ownership percentages; it only rounds the precomputed values for the API. This preserves
multiplier-aware triple-captain and bench behavior.

G1 remains an integration predecessor, not a production cutover image. Typed Data Redis
publications and revision-keyed GraphQL query caching are G2; the limited v3 Understat player-state
reader is G3.

## Reader and ownership evidence

- all Data models resolve through `V3ReadClient` with an automatic numeric `season_id` predicate;
- model, projection, filter, order, range, and OR identifiers are allowlisted and quoted;
- OR values remain PostgreSQL parameters, including hostile strings;
- reporting selection reads use only `reporting.tournament_selection_stats` and never scan entry
  picks/transfers or call an aggregation RPC;
- auth validation remains read-only and Web-owned `bauth` is not migrated or written by GraphQL;
- GraphQL deploy runs `contract:check` before `docker compose up` and contains no migration step;
- the original dirty GraphQL worktree was not modified.

Residual scans passed for `supabase`, `@supabase`, `.rpc(`, Redis season authority, retired
tournament RPC/view names, and GraphQL business DML/DDL. The old player-state SQL is explicitly
owned by G3 and prevents G1 from being treated as a production candidate.

## Database contract evidence

The accepted Data commit was replayed into a fresh vanilla PostgreSQL 15 database. The first run
applied the complete Drizzle/SQL contract through `0090`; the second run skipped every applied
migration and `db:migrate:status` was clean, with `0091`-`0093` still approval-gated.

A new disposable login inheriting `letletme_graphql_reader` then returned:

```json
{"roleName":"graphql_ci","currentSeason":{"seasonId":2026,"seasonCode":"2627"},"publicationId":"1f08ab2f-732b-349f-668c-4a2038c5f1ba","datasetRevision":"1","schemaVersion":"v3","planVersion":"3.2.3"}
```

The same startup contract passed against the exact migrated B0 database as
`p4_graphql_reader`. A Data owner/writer role failed the startup ACL contract as intended.

Unit cases also prove fail-closed behavior for a missing relation, missing column, unsupported
publication version, PostgreSQL 16, unsafe role attributes, and any Data relation write privilege.

## Test and runtime evidence

| Gate | Result |
| --- | --- |
| Full GraphQL suite | 348 passed, 0 failed, 1 snapshot, 930 assertions |
| Focused reader/contract/selection suite | 17 passed, 0 failed |
| Format | passed |
| ESLint | passed |
| TypeScript | passed |
| Bun production-target build | passed, 3.30 MB bundle |
| Real B0 startup contract | passed, v3 / plan 3.2.3 / revision 1 |
| Fresh PG15 replay twice | passed; second run no-op/status-clean |
| Diff whitespace check | passed |

A disposable Redis and the B0 reader database were used for an actual HTTP startup and GraphQL
smoke. `/health` returned PostgreSQL/Redis/season healthy, and one five-root request returned:

- preseason current-event metadata with GW1 next;
- GW1/GW2 event rows;
- current Arsenal players with teams/prices;
- fixture/team mappings;
- a 14-day market pulse with six observed days.

The temporary server, Redis container, fresh PG15 container, failed trial database, and temporary
roles were removed after verification. No production database, Redis, service, or deployment was
mutated.
