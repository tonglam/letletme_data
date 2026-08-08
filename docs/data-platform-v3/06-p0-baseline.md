# Data Platform v3 P0 Baseline Evidence

Captured: 2026-08-08

Plan version: 3.0.0

Production project: `gtwcfjoviibmtkevurjw`

This file contains non-secret summary evidence. Exact definitions are reproducible with
`sql/v3/p0-object-inventory.sql`; raw B0 outputs belong in the encrypted cutover evidence
directory, not Git.

## Repository baselines

| Repository | Fetched `origin/main` | Dirty checkout policy |
| --- | --- | --- |
| Data | `62f134aab250d1daeee423381689924a16d438b1` | v3 uses independent `/Users/tong/CursorProjects/letletme_data-data-platform-v3` |
| GraphQL | `8cf4ddc6a429134c8bf4a37f11a959b68e5ae613` | existing dirty worktree excluded |
| Web | `c290d912dfc3756237d65794c47e78f2193771e8` | existing dirty worktree excluded |

Production Data API/worker image is tagged with Data `62f134a` and both containers were healthy at
inspection time.

## PostgreSQL baseline

| Metric | Result |
| --- | ---: |
| PostgreSQL | 15.8 |
| Database size | 466,490,159 bytes / 445 MB |
| Public ordinary tables | 180 |
| Public partitioned parents | 12 |
| Public materialized views | 2 |
| Public ordinary views | 4 |
| Public sequences | 22 |
| Public enum types | 20 |
| Public relation bytes | 442,368,000 |
| Data SQL migration rows | 75 |
| Data migration tail | `0078_restore_event_live_summary_runtime_columns.sql` |

Public relation classification produced zero unmatched objects:

| Owner/class | Kind | Count |
| --- | --- | ---: |
| FPL | partitioned parent | 12 |
| FPL | ordinary/current/season table | 144 |
| Competition | table | 16 |
| Understat | table | 12 |
| Bridge | table | 3 |
| Ops/migration | table | 5 |
| Reporting | MV | 2 |
| Reporting | view | 4 |
| FPL | sequence | 7 |
| Competition | sequence | 14 |
| Ops | sequence | 1 |

The 20 public enums are also fully classified: FPL 1, Competition 10, Understat 6, Bridge 2, and
Ops 1. The reproducible inventory fails P0 if either a public relation/sequence or enum/domain has
a null classification.

Executable/security inventory:

- six public functions: `get_captain_counts`, `get_pick_aggregation`,
  `get_players_for_picker`, `get_transfer_aggregation`, `search_players_for_picker`, and
  `reject_sealed_fpl_history_mutation`;
- zero public `SECURITY DEFINER` functions;
- 144 `reject_sealed_mutation` triggers across the historical parent/season relations;
- one RLS policy, on `sql_migrations`;
- 606 public-schema foreign keys, 564 valid indexes, and zero invalid indexes;
- 1,571 effective non-owner ACL records across the public schema, relations, sequences, functions,
  and default privileges; B0 full and selective restore comparison reproduces them exactly;
- `anon` and `authenticated` currently have all table privileges on both `sql_migrations` and
  `graphql_schema_migrations`. This is a high-severity v2 security defect; `0079` must revoke it
  before creating the private v3 migration model.

The managed `supabase_migrations.schema_migrations` ledger contains 17 rows. It includes Data
history/drop migrations also recorded in `public.sql_migrations`; v3 treats the managed ledger as
immutable Supabase state and Data's `ops.schema_migrations` as the sole future Data ledger.

## Runtime reference baseline

### Data

- 28 schema exports and 27 `pgTable` definitions in the mainline schema folder;
- 30 repository files and 23 cache files;
- 29 runtime/script references matching history or season-suffix patterns;
- 14 explicit `public.` runtime/script references;
- current Redis contract includes physical EventLiveSummary/PlayerValue keys and v2 core/live
  prefixes, all mapped in `03-object-migration-manifest.md` and the v3 Redis plan.

### GraphQL

On fetched `origin/main`:

- 123 Supabase `.from()` business-read calls;
- five Supabase RPC calls;
- seven files already using direct PostgreSQL pool/query paths;
- 21 unique `.from()` relation names, all mapped to v3 targets or retirement:
  `entry_event_picks`, `entry_event_results`, `entry_event_transfers`, `entry_history_infos`,
  `entry_infos`, `entry_league_infos`, `event_fixtures`, `event_live_explains`, `event_lives`,
  `events`, `league_event_results`, `mv_tournament_event_snapshot`, `player_stats`,
  `player_values`, `players`, `teams`, `tournament_battle_group_results`, `tournament_entries`,
  `tournament_infos`, `tournament_selection_stats`, and `v_tournament_event_result`;
- five RPC names, all retired by G1/G2: `get_captain_counts`, `get_pick_aggregation`,
  `get_players_for_picker`, `get_transfer_aggregation`, and `search_players_for_picker`.

### Web

On fetched `origin/main`:

- 34 Supabase `.from()` calls, owned by Web auth/storage paths;
- five files reference direct database environment variables: Web DB initialization, Web
  migrations/status, tournament creation, and an entry-sync backfill;
- v3 work preserves Web ownership of `bauth`; the tournament/entry paths must consume the GraphQL
  or explicit Data contract and cannot become independent Data writers.

## Redis baseline

Live inspection used endpoint signatures only; host/password values are not recorded.

| Metric | Result |
| --- | ---: |
| Redis server | 7.0.15 |
| Used memory | 185,965,648 bytes / 177.35 MB |
| Cache endpoint vs queue endpoint | Same host/port |
| Cache database | DB 0 |
| Queue database | DB 0 through fallback |
| Keys at first INFO sample | 493, 20 expiring |
| Key types at grouped sample | 440 hashes, 46 strings, 5 sorted sets, 3 streams |

This proves queue/cache are currently mixed. V3 keeps the existing Redis server but moves BullMQ to
DB 1 through explicit `QUEUE_REDIS_DB=1`; cache remains DB 0. During maintenance, BullMQ keys are
copied and verified before the old DB 0 copies are retired. The two client configurations must not
fall back to each other in production.

Key/memory evidence:

| Group | Keys | `MEMORY USAGE` bytes |
| --- | ---: | ---: |
| Data Understat cache | 114 | 197,961,073 |
| Understat player queue | 107 | 1,452,281 |
| Understat team queue | 109 | 366,949 |
| Other BullMQ queues | 86 | 120,888 |
| GraphQL `player_state` | 8 | 2,089,872 |
| GraphQL `gql` | 3 | 15,384 |
| FPL Data core/live/entry groups | 67 | 1,220,435 |

The Understat Data cache alone exceeds the required 100 MB reduction target. Its removal is still
validated by a post-cutover memory comparison because Redis allocator overhead and queue cleanup
can change total `used_memory` differently from per-key `MEMORY USAGE`.

## Tooling baseline

- Repository package manager target: Bun 1.3.3.
- Local default Bun observed: 1.2.12; release verification must use the pinned 1.3.3 container/CI.
- Local default PostgreSQL client: 14.17 and unsuitable for the PostgreSQL 15 source.
- Explicit PostgreSQL 15 client path: `/opt/homebrew/opt/postgresql@15/bin` (15.18).
- Redis CLI: 8.0.0.
- GPG: 2.4.7 using libgcrypt 1.11.0.
- Docker: 28.2.2.

No B0 dump may use the default PostgreSQL 14 `pg_dump`; the runbook must invoke the explicit
PostgreSQL 15 client path and record it in the manifest.
