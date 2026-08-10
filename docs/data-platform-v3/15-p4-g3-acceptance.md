# P4 G3 GraphQL player-state acceptance

Plan version: 3.2.4

Date: 2026-08-09

GraphQL branch: `codex/data-platform-v3-player-state`

Accepted GraphQL commit: `3b426383a13ddc4b2d1d22452216bfe77826e420`

GraphQL predecessor: `e2612ad2db91db5a9841ed03812403e0082a4906`

Accepted Data publication contract: `30a1f4cd27e0e5dc4d0cd16df3d6190d7cc97a0e`

## Outcome

G3 moves `playerStateProfile` from v2 public/history parents and Understat Redis manifests to the
accepted v3 source-of-truth contract. Current FPL identity comes from the request-pinned core
publication; current and historical metrics read schema-qualified PostgreSQL relations. Historical
FPL seasons use the same `fpl.*` physical tables as the current season, keyed by `season_id`.

Understat remains a low-frequency PostgreSQL-only provider. A profile consumes
`understat.player_seasons` only through `auto_verified` or `manual_verified`
`bridge.entity_links` rows whose evidence explicitly confirms the requested season. There are no
Understat Data publications, Redis manifests, provider caches, history caches, or fallback reads.

The GraphQL result cache is the sole cache for this feature. Its key includes the GraphQL schema
version, Data dataset revision, season, engine version, player, and horizon. Non-null profiles,
including honest FPL-only profiles, expire after 900 seconds. A valid missing-player null expires
after 60 seconds. PostgreSQL/provider errors propagate and are never converted into cached no-data.

The existing GraphQL schema, resolver, service, and output types are unchanged. Field players now
receive actual Understat NPxG, xA, shots, key passes, xG chain, and xG buildup per-90 process metrics
against a season- and position-matched linked cohort. Goalkeepers remain explicitly team-context
only. Missing, unverified, ambiguous, quarantined, and verified-without-data cases remain visible in
coverage limitations instead of being promoted to verified data.

## B0 data and query evidence

The restored B0 PostgreSQL 15 dataset contains 12 Understat seasons, 2,192 players, 6,424
player-season rows, 129,576 player-match rows, and 1,909 bridge links. All migrated links are
durable `auto_verified` rows.

For completed season 2526, the real repository returned a cross-provider field-player profile from
the unified FPL tables, verified bridge, and Understat player-season facts. For current preseason
2627, B0 has 573 FPL players and 475 durable verified player links, but no link evidence confirming
2627 and no 2627 Understat rows. A real request through the current Redis core publication therefore
returned the intended FPL-only profile with `UNVERIFIED` mapping, no current Understat metrics, and
preserved historical Understat coverage.

The verified-link lookup uses `bridge_entity_links_verified_right_idx`. The one-season process
cohort uses the FPL player code/type indexes, the verified bridge index, and
`understat_player_seasons_player_idx`; its observed B0 execution was approximately 13 ms. The
historical FPL query was changed from nested per-player aggregation to one season-level
preaggregation: both forms returned 2,139 rows with zero rows in either set difference, while the
observed execution fell from approximately 255.6 ms to 68.9 ms.

Five warm-up calls followed by 30 measured cache misses and 30 measured cache hits produced:

| Path | Observed p95 | Budget |
| --- | ---: | ---: |
| PostgreSQL cold query cache | 61.028 ms | 500 ms |
| Redis warm query cache | 0.039 ms | 50 ms |

The B0 integration suite ran as the actual `p4_graphql_reader` login, not the Data owner. It proved
the complex FPL/reporting/bridge/Understat SQL can execute with application ACLs. The startup
contract returned:

```json
{"roleName":"p4_graphql_reader","currentSeason":{"seasonId":2026,"seasonCode":"2627"},"publicationId":"1f08ab2f-732b-449f-868c-4a2038c5f1ba","datasetRevision":"1","schemaVersion":"v3","planVersion":"3.2.4"}
```

## Cache and failure evidence

The real Redis integration cases observed a 900-second success TTL and 60-second valid-null TTL.
Each test deleted only its exact synthetic keys in `finally`; a namespace-scoped scan afterward
returned zero `llm:v3:gql:v3:b0-2526:*` keys. No broad Redis flush was used.

Unit cases prove:

- verified and season-confirmed links read direct Understat PostgreSQL facts;
- no verified link returns an explicit FPL-only profile without an Understat query;
- a verified link with no provider row remains verified but reports provider data unavailable;
- ambiguous mapping remains ambiguous and cannot trigger an Understat metrics read;
- provider errors propagate without writing a cache entry; and
- a valid missing player is cached as null for exactly 60 seconds.

## Walk-forward release evidence

The FPL-only backtest was also moved to the unified v3 tables and run read-only on all ten complete
B0 seasons from 1617 through 2526. It produced 41,425 observations. Future-five-GW means were 12.71
for `RISING`, 13.87 for `STABLE`, and 11.92 for `FALLING`; because the required ordering failed, the
directional release gate remains `WITHHOLD`. Cross-provider directional trends continue to require
their own future walk-forward evidence. The backtest's non-zero exit is therefore an intentional
release refusal, not a storage or migration failure.

## Static ownership evidence

Repository, test, and script scans returned zero references to:

- v2 FPL history parents/archives and season-suffixed table construction;
- old public Understat/bridge table names;
- Understat Redis manifests or player-state history cache keys;
- Supabase `.from()` business reads or RPC calls; and
- the old `player-state-v1.1` cache/engine namespace.

Every SQL source in the player-state repository and backtest is schema-qualified. The changed path
contains no business DML or DDL. The startup probe now includes the exact reporting, Understat, and
bridge columns required by G3 and fails closed before serving if any are absent or unreadable.

## Test gates

| Gate | Result |
| --- | --- |
| Full GraphQL suite | 311 passed, 4 B0-only skipped, 0 failed, 1 snapshot, 872 assertions |
| Focused player-state/read-client suite | 17 passed, 0 failed |
| Real B0 player-state suite | 4 passed, 0 failed, 18 assertions |
| Current 2627 Redis-publication profile | passed; honest FPL-only degradation |
| Completed 2526 cross-provider profile | passed |
| Real Redis TTL and cleanup | passed; 900/60 seconds; zero synthetic keys left |
| Read-only startup contract | passed; v3 / plan 3.2.4 / core revision 1 |
| FPL history equivalence | passed; 2,139 rows; zero bidirectional difference |
| Performance budgets | passed; 61.028 ms cold p95 / 0.039 ms warm p95 |
| Format | passed |
| ESLint | passed |
| TypeScript | passed |
| Diff whitespace check | passed |

The reproducible full-suite command supplies explicit non-production test values for required
environment variables; no `.env` file or credential is committed.

No production database, Redis, service, deployment, DNS, or legacy object was mutated.
