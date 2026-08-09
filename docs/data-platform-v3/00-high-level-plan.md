# Data Platform v3 High-Level Plan

Status: approved for execution

Plan version: 3.2.4

Baseline date: 2026-08-08

Data baseline: `origin/main` at `62f134a`

Production project: `gtwcfjoviibmtkevurjw`

Production PostgreSQL: 15.8

Production migration tail: `0078_restore_event_live_summary_runtime_columns.sql`

## Objective

Rebuild the LetLetMe data platform around one authoritative physical data model, explicit
multi-season keys, private provider boundaries, derived reporting views, and revisioned Redis
publication. The cutover is a preseason hard switch: no dual-write, no shadow read path, and no
runtime fallback to the v2 schema after activation.

The migration must preserve every trusted FPL, competition, and Understat row. Legacy objects are
frozen after cutover and are dropped only after the B1 backup, complete reconciliation, and an
explicit final deletion approval.

## Locked decisions

1. PostgreSQL is the only source of truth. Redis contains rebuildable publications and query
   caches only.
2. Every physical table uses plural naming and an explicit owning schema. Application code never
   constructs season-suffixed table names.
3. Historical and current FPL data share the same physical tables, keyed by `season_id`.
   PostgreSQL partitioning is not used at the current volume.
4. Provider data remains isolated. FPL and Understat have separate clients, ingestion, write
   paths, and tables. Consumers join them only through verified rows in `bridge`.
5. Stable source facts are physical tables. Reconstructable calculations are ordinary views.
   Expensive, repeatedly consumed reporting results are materialized views.
6. `event_live_summaries` is not migrated as a table. It becomes
   `reporting.player_season_summaries`, one row per `(season_id, element_id)`.
7. `tournament_selection_stats` becomes a materialized view refreshed only after a complete
   event-picks publication. It precomputes selection, captain, vice-captain, percentage, and
   effective-ownership measures.
8. Understat is low-frequency. Data does not publish Understat to Redis. The future GraphQL
   player-state query reads indexed PostgreSQL and uses a bounded GraphQL cache only.
9. Data owns all business schema migrations. GraphQL no longer runs business DDL at startup or
   deploy time. Web remains the sole owner of `bauth`.
10. Queue Redis and cache Redis use separate logical deployments/configuration. No new paid
    service is introduced; the existing infrastructure is separated operationally.
11. Production activation is a maintenance-window hard cutover. There is no v2/v3 double-write,
    shadow traffic, row-by-row fallback, or simultaneous writer set.
12. No broad Redis flush and no unscoped destructive SQL are permitted.

## Target ownership model

| Schema | Owner | Purpose |
| --- | --- | --- |
| `fpl` | Data | FPL dimensions and immutable/current facts for all seasons |
| `competition` | Data | Entries, leagues, picks, results, transfers, cups, tournaments |
| `understat` | Data | Provider-owned real-match facts and dimensions |
| `bridge` | Data | Evidence-backed FPL/Understat entity and match links |
| `reporting` | Data | Ordinary views and materialized read models |
| `ops` | Data | Publications, sync runs/items, imports, and migration audit state |
| `bauth` | Web | Better Auth identities, sessions, bindings, and Web migrations |
| Supabase system schemas | Supabase | `auth`, `storage`, `realtime`, `vault`, managed ledgers |

All six Data schemas are private and excluded from the Supabase Data API. Data has write access;
GraphQL receives schema-qualified `SELECT` access only. Web uses a dedicated non-admin LOGIN that
inherits only `letletme_web_auth`: it can access the explicit current `bauth` runtime-table
allowlist, but cannot read or mutate Data schemas, frozen `public` business objects, historical
`bauth.apikey`, or the Web migration ledger. Web migrations use a separate administrator URL.

## Target physical data model

### FPL

- `fpl.seasons`
- `fpl.events`
- `fpl.teams`
- `fpl.players`
- `fpl.phases`
- `fpl.fixtures`
- `fpl.player_event_snapshots`
- `fpl.player_gameweek_stats`
- `fpl.player_gameweek_scoring_items`
- `fpl.player_fixture_stats`
- `fpl.player_market_snapshots`

### Competition

- `competition.entries`
- `competition.entry_season_histories`
- `competition.entry_leagues`
- `competition.entry_event_picks`
- `competition.entry_event_results`
- `competition.entry_event_transfers`
- `competition.entry_event_cup_results`
- `competition.league_event_results`
- `competition.tournaments`
- `competition.tournament_entries`
- `competition.tournament_groups`
- `competition.tournament_knockouts`
- `competition.tournament_battle_group_results`
- `competition.tournament_points_group_results`
- `competition.tournament_knockout_results`

### Understat and bridge

- `understat.seasons`, `understat.teams`, `understat.players`
- `understat.matches`, `understat.team_match_stats`
- `understat.team_seasons`, `understat.team_stat_splits`
- `understat.player_seasons`, `understat.player_team_seasons`
- `understat.player_match_stats`
- `bridge.entity_links`, `bridge.match_links`, `bridge.entity_aliases`

### Operations

- `ops.schema_migrations`
- `ops.dataset_publications`
- `ops.sync_runs`, `ops.sync_items`
- `ops.migration_runs`, `ops.migration_objects`
- `ops.season_imports`

`fpl.seasons` also contains reference-only rows for a season required by preserved competition
history even when no FPL core archive exists for that season. This keeps `season_id` authoritative
without fabricating teams, players, events, or fixtures.

## Target reporting model

| Object | Type | Grain | Refresh/source |
| --- | --- | --- | --- |
| `reporting.player_season_summaries` | View | season + player | Sum of gameweek facts; always current |
| `reporting.player_value_changes` | View | season + player + snapshot date | Derived from market snapshots |
| `reporting.tournament_selection_stats` | MV | tournament + event + player | After complete picks publication |
| `reporting.tournament_entry_event_summaries` | MV | tournament + event + entry | After finalized entry facts |
| `reporting.tournament_event_results` | View | tournament result row | Canonical tournament result facts |

`mv_tournament_snapshot`, all `v_tournament_*` compatibility views, the old tournament snapshot
RPC aggregation path, and physical `event_live_summaries`/`tournament_selection_stats` are not part
of v3.

## Redis contract

Data publications use immutable revisions and an atomic manifest pointer:

- `llm:v3:data:fpl:core:{season}:{revision}:*`
- `llm:v3:data:fpl:live:{season}:{event}:{revision}:*`
- active manifest keys have no TTL;
- staging revisions expire after 15 minutes;
- retired revisions expire after 24 hours.

GraphQL query caches use:

`llm:v3:gql:{schemaVersion}:{datasetRevision}:{query}:{argsHash}`

Default TTLs:

| Query class | TTL |
| --- | ---: |
| Live | 10 seconds |
| Metadata/current-event | 60 seconds |
| Tournament/reporting | 300 seconds |
| Market | 300 seconds |
| Historical | 3600 seconds |
| Understat player state | 900 seconds |
| Valid Understat no-result | 60 seconds |

Understat Data publication keys, EventLiveSummary keys, and PlayerValue keys are retired. Redis
cleanup uses namespace-scoped `SCAN` plus `UNLINK`; `FLUSHDB` and `FLUSHALL` are prohibited.

## Delivery and cutover

The implementation is split into reviewable Data, GraphQL, and Web branches, but production has
one maintenance-window cutover. B0 backup and restore rehearsal precede any production mutation.
Migrations `0079` through `0090_zzz` create, populate, validate, and activate v3. Old objects
remain frozen until B1 backup and explicit approval. Migrations `0091` through `0093` then remove legacy
reporting objects, physical tables, triggers, and obsolete migration ownership.

The authoritative phase checklist, acceptance gates, object mapping, tests, and operator commands
are maintained in the sibling documents in this directory. A change to a locked decision requires
a plan-version bump and a changelog entry before implementation continues.
