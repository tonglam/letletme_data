# P4 G2 GraphQL publication and query-cache acceptance

Plan version: 3.2.4

Date: 2026-08-09

GraphQL branch: `codex/data-platform-v3-reporting-cache`

Accepted GraphQL commit: `e2612ad2db91db5a9841ed03812403e0082a4906`

GraphQL predecessor: `886351b1c26d86f5e8010cb57e8d5f33469423c8`

Accepted Data publication contract: `30a1f4cd27e0e5dc4d0cd16df3d6190d7cc97a0e`

## Outcome

G2 replaces all FPL core/live Redis authority reads with two immutable publication contracts.
Each GraphQL request pins one validated core revision. A live event additionally pins one live
revision and combines both revisions in live-derived query-cache keys. GraphQL never assembles a
dataset from individual Redis siblings or from mixed Redis/PostgreSQL sources.

The accepted contract is exact: schema `v3`, plan `3.2.4`, RFC-shaped publication UUID, canonical
scope, canonical item keys, string Redis type, complete item set, byte length, row/object count, and
SHA-256 payload digest. A missing or malformed active manifest, item, hash, count, or JSON payload
invalidates the complete publication and causes one coherent PostgreSQL statement to rebuild that
dataset for the request.

The canonical core publication has six items: `events`, `teams`, `players`, `phases`, `fixtures`,
and `currentEventId`. The canonical live publication has four items: `eventLives`, `fixtures`,
`liveFixtures`, and `liveBonus`. There is no second live-scoring implementation or rollout flag.

GraphQL-shaped query results use
`llm:v3:gql:v3:{datasetRevision}:{queryName}:{sha256(season,args)}`. Core/live authorities are
non-expiring Data-owned publications; query results expire normally under the accepted policy:

| Class | TTL |
| --- | ---: |
| Live | 10 seconds |
| Metadata | 60 seconds |
| Reporting | 300 seconds |
| Market | 300 seconds |
| Historical | 3600 seconds |

Redis query-cache writes, malformed-entry eviction, and reads are best-effort. PostgreSQL remains
the source of truth. No Understat cache was introduced; the limited player-state reader remains G3.

## Contract correction and migration evidence

The first pre-runtime publication ID in B0 had invalid UUID version/variant bits. Data commit
`30a1f4cd27e0e5dc4d0cd16df3d6190d7cc97a0e` adds the non-destructive migration
`0090_zzz_enforce_v3_publication_identity.sql`, which:

- normalizes invalid publication IDs deterministically before runtime;
- aborts before mutation on any identity collision;
- preserves `ops.sync_runs.publication_id` references transactionally;
- validates a named database CHECK; and
- advances every v3 publication manifest to plan 3.2.4.

The migration passed twice on the exact B0 PostgreSQL 15 restore and twice on a fresh PostgreSQL 15
database. Both second runs were no-ops/status-clean. A dedicated reference fixture proved that a
linked sync run followed the normalized publication ID. The final B0 core ID is
`1f08ab2f-732b-449f-868c-4a2038c5f1ba`; invalid IDs and stale v3 plan manifests are both zero.
Approval-gated migrations `0091`-`0093` were not applied.

## Real Redis and HTTP evidence

A disposable Redis received publications through the normal Data operations state machine:

- current 2627 core revision 1: 38 events, 20 teams, 573 players, 11 phases, 380 fixtures, and a
  null preseason current event;
- GW1 live revision 17: 573 live player rows, 10 fixtures, 20 fixture-team buckets, and zero bonus
  teams in scheduled state;
- all ten item keys and both active manifests were Redis strings with no expiry.

GraphQL started against the B0 reader database and that Redis. `/health` reported PostgreSQL,
Redis, and season healthy. Real HTTP GraphQL requests returned preseason GW1-next metadata,
20 teams, the current player catalog, the complete scheduled GW1 live dataset, reporting rows,
player detail, public-league empty state, and market pulse data.

Observed query keys used the accepted namespace and revision, including
`llm:v3:gql:v3:core-1:market-pulse-v3:*` and
`llm:v3:gql:v3:core-1:player_detail-v3:*`, with the 300-second policy.

The active core pointer was then removed reversibly. One request rebuilt all core siblings from
PostgreSQL and returned the same current data. The active live pointer was removed separately; one
request returned a single PostgreSQL live dataset with a `db-*` revision, zero scheduled player
facts, 10 fixtures, and 20 fixture-team rows instead of mixing those rows with the prior 573-row
Redis item. Restoring the pointer exposed live revision 17 and all 573 rows to the next request.

## Static ownership evidence

Runtime scans returned zero matches for:

- Supabase `.from()` business reads and RPC calls;
- retired v2 tournament snapshot/selection views and materialized views;
- legacy `PlayerValue:*`, `PlayerValueMissing:*`, event-result, event-live, and `gql:v2` authority
  keys; and
- the removed live-points rollout flag and configurable catch-all cache TTL.

The only old FPL history-parent references are in the bounded player-state repository/backtest
path. They are physical-table migration work explicitly assigned to G3, not G2 reporting/view/RPC
fallbacks.

## Test gates

| Gate | Result |
| --- | --- |
| Full GraphQL suite | 306 passed, 0 failed, 1 snapshot, 837 assertions |
| Publication/snapshot/query-cache cases | passed |
| Live batch and 100-way singleflight cases | passed |
| Real B0 startup contract | passed; v3 / plan 3.2.4 / core revision 1 |
| Real Redis and HTTP smoke | passed |
| Core and live pointer-loss fallbacks | passed; no mixed sibling dataset |
| Format | passed |
| ESLint | passed |
| TypeScript | passed |
| Diff whitespace check | passed |

The reproducible full-suite command supplies explicit non-production test values for required
environment variables; no `.env` file or credential is committed.

No production database, Redis, service, deployment, or DNS state was mutated.
