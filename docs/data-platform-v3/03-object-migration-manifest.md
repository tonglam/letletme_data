# Data Platform v3 Object Migration Manifest

Plan version: 3.2.5

Naming notation: `{season}` means each of `1617`, `1718`, `1819`, `1920`, `2021`, `2122`,
`2223`, `2324`, `2425`, `2526`, and `2627` where present.

This manifest is the destructive-operation allowlist. An object not listed here cannot be altered or
dropped by the v3 cleanup. Before P0 exits, generated inventory artifacts must prove that every
production object is represented by an exact row or an explicitly preserved system/application
group.

## FPL source facts

| v2 source object(s) | Kind | v3 target | Target grain/key | Conversion | Final action |
| --- | --- | --- | --- | --- | --- |
| `events`, `events_history`, `events_{season}` | table/partition family | `fpl.events` | `(season_id, event_id)` | union current + all seasons; deduplicate exact business key | drop in `0092` |
| `teams`, `teams_history`, `teams_{season}` | table/partition family | `fpl.teams` | `(season_id, team_id)` | union and preserve corrected historical names | drop in `0092` |
| `players`, `players_history`, `players_{season}` | table/partition family | `fpl.players` | `(season_id, element_id)` | union; preserve upstream player identity per season | drop in `0092` |
| `phases`, `phases_history`, `phases_{season}` | table/partition family | `fpl.phases` | `(season_id, phase_id)` | union; preserve all source phases | drop in `0092` |
| `event_fixtures`, `event_fixtures_history`, `event_fixtures_{season}` | table/partition family | `fpl.fixtures` | `(season_id, fixture_id)` | union; `event_id` remains nullable for postponed/unscheduled fixtures | drop in `0092` |
| `player_stats`, `player_stats_history`, `player_stats_{season}` | table/partition family | `fpl.player_event_snapshots` | `(season_id, event_id, element_id)` | union; preserve snapshot/business columns | drop in `0092` |
| `event_lives`, `event_lives_history`, `event_lives_{season}` | table/partition family | `fpl.player_gameweek_stats` | `(season_id, event_id, element_id)` | union official live totals | drop in `0092` |
| `event_live_explains`, `event_live_explains_history`, `event_live_explains_{season}` | table/partition family | `fpl.player_gameweek_scoring_items` | `(season_id, event_id, element_id, scoring_identifier)` | normalize explain rows; preserve scoring value/points | drop in `0092` |
| `fpl_player_fixture_stats`, `fpl_player_fixture_stats_history`, `fpl_player_fixture_stats_{season}` | table/partition family | `fpl.player_fixture_stats` | `(season_id, fixture_id, element_id)` | union; preserve fixture attribution | drop in `0092` |
| `player_market_snapshots`, `player_market_snapshots_history`, `player_market_snapshots_{season}` | table/partition family | `fpl.player_market_snapshots` | `(season_id, snapshot_date, element_id)` | union complete daily/event snapshot facts | drop in `0092` |
| `event_live_summaries`, `event_live_summaries_history`, `event_live_summaries_{season}` | table/partition family | `reporting.player_season_summaries` | `(season_id, element_id)` | do not copy; reconcile against derived view | drop in `0092` |
| `player_values`, `player_values_history`, `player_values_{season}` | table/partition family | `reporting.player_value_changes` | `(season_id, snapshot_date, element_id)` | historical rows derive exactly; create provenance-marked market seed facts only for B0 current-season starts that predate all market captures, then require zero view mismatch | drop in `0092` only if final audit has zero mismatches |

`fpl.seasons` has no v2 physical source. `0080` seeds one row per core manifest season with explicit
`season_code`, start/end years, source metadata, lifecycle state, and exactly one `is_current=true`.
It also seeds reference-only 2011/12 through 2015/16 rows required by preserved entry-season
history; those rows must not acquire fabricated core facts.

## Sequences and enum types

The 22 public sequences are first-class source objects, not implicit omissions:

- 21 table-owned `*_id_seq` sequences migrate into the identity/sequence contract of their mapped
  target tables and are dropped only with those v2 tables in `0092`;
- `core_snapshot_revision_seq` migrates into the `ops.dataset_publications` revision contract and
  is dropped in `0092` after publication reconciliation;
- B0 and every conversion rehearsal compare each sequence's `last_value` and `is_called` state.

The 20 public enum types map as follows:

| v2 type family | Count | v3 owner/action |
| --- | ---: | --- |
| `chip`, `cup_result`, `group_mode`, `knockout_mode`, `league_type`, `tournament_*` | 10 | recreate under `competition` with exact labels/order |
| `fpl_season_archive_status` | 1 | replace with the `ops.season_imports` status contract |
| `provider_entity_type`, `provider_link_status` | 2 | recreate under `bridge` |
| `understat_*` | 6 | recreate under `understat`; never shared with FPL |
| `value_change_type` | 1 | retire after `reporting.player_value_changes` reconstructability passes |

No v2 enum or sequence is dropped independently of its mapped target and the exact `0092` drop
manifest.

## Competition source facts

| v2 source | v3 target | Target grain/key | Conversion | Final action |
| --- | --- | --- | --- | --- |
| `entry_infos` | `competition.entries` | `(season_id, entry_id)` | preserve manager/team metadata and sync checkpoints | drop in `0092` |
| `entry_history_infos` | `competition.entry_season_histories` | `(season_id, entry_id)` | preserve season-total points/rank rows, including reference-only 2011/12-2015/16 seasons | drop in `0092` |
| `entry_league_infos` | `competition.entry_leagues` | `(season_id, entry_id, league_id, league_type)` | preserve membership/standing data | drop in `0092` |
| `entry_event_picks` | `competition.entry_event_picks` | `(season_id, entry_id, event_id, position)` | preserve exactly 15 valid positions for complete squads | drop in `0092` |
| `entry_event_results` | `competition.entry_event_results` | `(season_id, entry_id, event_id)` | preserve canonical event result/checkpoint fields | drop in `0092` |
| `entry_event_transfers` | `competition.entry_event_transfers` | source transfer identity under season/entry/event | preserve source identity and transfer order/time | drop in `0092` |
| `entry_event_cup_results` | `competition.entry_event_cup_results` | `(season_id, source_result_id)` plus entry/event indexes | preserve the stable source row ID and cup opponent/result metadata; do not invent a missing match ID | drop in `0092` |
| `league_event_results` | `competition.league_event_results` | `(season_id, league_id, entry_id, event_id)` | preserve standings/results | drop in `0092` |
| `tournament_infos` | `competition.tournaments` | `(tournament_id)` plus explicit `season_id` | preserve lifecycle/setup/checkpoints | drop in `0092` |
| GraphQL mainline `public_league_trends_catalog` (not present in accepted B0) | `competition.public_league_trends` | `(season_id, tournament_id)` | Data-owned operator allowlist; guarded copy if the source appears during rehearsal | retire the GraphQL migration; legacy source requires a separately approved cleanup entry if production preflight finds it |
| `tournament_entries` | `competition.tournament_entries` | `(tournament_id, entry_id)` | preserve membership/seed/admin state | drop in `0092` |
| `tournament_groups` | `competition.tournament_groups` | source group identity | preserve tournament/group identity | drop in `0092` |
| `tournament_knockouts` | `competition.tournament_knockouts` | source knockout identity | preserve bracket identity/state | drop in `0092` |
| `tournament_battle_group_results` | same unprefixed name in `competition` | source result identity | direct normalized copy | drop in `0092` |
| `tournament_points_group_results` | same unprefixed name in `competition` | source result identity | direct normalized copy | drop in `0092` |
| `tournament_knockout_results` | same unprefixed name in `competition` | source result identity | direct normalized copy | drop in `0092` |
| `tournament_selection_stats` | `reporting.tournament_selection_stats` | `(tournament_id, event_id, element_id)` | do not copy; rebuild MV from complete picks | drop in `0092` |

## Understat and bridge

| v2 source | v3 target | Conversion | Final action |
| --- | --- | --- | --- |
| `understat_seasons` | `understat.seasons` | direct provider-owned copy | drop in `0092` |
| `understat_teams` | `understat.teams` | direct provider-owned copy | drop in `0092` |
| `understat_players` | `understat.players` | direct provider-owned copy | drop in `0092` |
| `understat_matches` | `understat.matches` | direct provider-owned copy | drop in `0092` |
| `understat_team_match_stats` | `understat.team_match_stats` | direct provider-owned copy | drop in `0092` |
| `understat_team_seasons` | `understat.team_seasons` | direct provider-owned copy | drop in `0092` |
| `understat_team_stat_splits` | `understat.team_stat_splits` | direct provider-owned copy | drop in `0092` |
| `understat_player_seasons` | `understat.player_seasons` | direct provider-owned copy | drop in `0092` |
| `understat_player_team_seasons` | `understat.player_team_seasons` | direct provider-owned copy | drop in `0092` |
| `understat_player_match_stats` | `understat.player_match_stats` | direct provider-owned copy | drop in `0092` |
| `provider_entity_links` | `bridge.entity_links` | preserve evidence/status; only verified statuses consumable | drop in `0092` |
| `provider_match_links` | `bridge.match_links` | preserve evidence/status | drop in `0092` |
| `provider_entity_aliases` | `bridge.entity_aliases` | preserve aliases as candidate evidence only | drop in `0092` |

No Understat row is inserted into an `fpl` table. No FPL row is inserted into an `understat` table.

## Operations and migration ownership

| v2 source | v3 target/action | Conversion | Final action |
| --- | --- | --- | --- |
| `core_snapshot_authority` | `ops.dataset_publications` | convert active/finalized core/live authority into revision records | drop in `0092` |
| `understat_sync_runs` | `ops.sync_runs` | copy with `provider='understat'` and lane/scope fields | drop in `0092` |
| `understat_sync_items` | `ops.sync_items` | copy status/evidence; normalized payload retained as JSONB | drop in `0092` |
| `fpl_season_archives` + `fpl_season_archive_items` | `ops.season_imports` | one import row per archive with item manifest JSONB and source hashes | drop in `0092` |
| `sql_migrations` | `ops.schema_migrations` | move authoritative Data ledger; temporary updatable public compatibility view | compatibility removed in `0093` |
| `graphql_schema_migrations` | `ops.migration_objects` audit rows | preserve version/checksum evidence only; GraphQL stops DDL | drop in `0093` |
| `supabase_migrations.schema_migrations` | preserved managed system ledger | never moved or edited by Data cleanup | preserve |
| `drizzle.__drizzle_migrations` | preserved until ownership audit proves no active owner | not a Data cleanup target | preserve |
| `bauth.__drizzle_migrations` | Web-owned ledger | not a Data cleanup target | preserve |

`ops.migration_runs` records each v3 rehearsal/cutover run. `ops.migration_objects` records source
and target counts/hashes/status per object and stores legacy migration-ledger evidence.

`ops.dataset_publications.publication_id` is an RFC UUID at every runtime boundary. Migration
`0090_zzz_enforce_v3_publication_identity.sql` deterministically normalizes any pre-runtime ID,
preserves `ops.sync_runs.publication_id` references transactionally, validates the named CHECK,
and advances every v3 publication manifest to plan 3.2.5.

`0090_zzzz_integrate_understat_runtime.sql` adds the null-safe provider-pair uniqueness contract
used by `bridge.entity_links` upserts and replaces the cross-lane
`understat.player_team_seasons -> understat.team_seasons` dependency with independent season and
team references. It also drops the five unused provider-local sync enum types after sync control
moves to constrained fields in `ops`; only `understat.season_state` remains in use. It creates no
second provider or FPL fact table.

`letletme_data_writer` receives column-level `SELECT` only on
`ops.migration_runs(run_id, status, metadata)` for the initial core-cache preflight. All other
migration-run columns and every mutation privilege remain migration-operator-only.

The same writer receives `reporting` schema usage, `SELECT` only on
`reporting.tournament_selection_stats` and `reporting.tournament_entry_event_summaries`, and
`EXECUTE` only on their two hardened refresh functions. The three ordinary reporting views are
GraphQL-only.

## Reporting and executable objects

| v2 object | Kind | v3 target/action | Final action |
| --- | --- | --- | --- |
| `mv_tournament_event_snapshot` | MV | replace with `reporting.tournament_entry_event_summaries` | drop in `0091` |
| `mv_tournament_snapshot` | MV | no target | drop in `0091` |
| `v_tournament_event_result` | view | replace with `reporting.tournament_event_results` | drop in `0091` |
| `v_tournament_event_snapshot` | compatibility view | no target | drop in `0091` |
| `v_tournament_snapshot` | compatibility view | no target | drop in `0091` |
| `v_tournament_selection_stats` | compatibility view | no target | drop in `0091` |
| GraphQL read RPCs from `0043`/`0074` | functions | replace with schema-qualified `pg` queries | drop in `0091` |
| live/tournament checkpoint assertions | functions | replace with target constraints/publication gates where still required | drop or recreate under owning private schema in `0091`/`0092` |
| `reject_sealed_fpl_history_mutation` and history triggers | function/triggers | v3 immutable-season write rules in repository/constraints | drop in `0092` |

Target MV invariants:

- `reporting.tournament_selection_stats`: for each complete tournament/event with `N` entries,
  `sum(selected_count)=N*15`, `sum(captain_count)=N`, and `sum(vice_captain_count)=N`.
- `reporting.tournament_entry_event_summaries`: one row per tournament/event/entry only after all
  required source facts are finalized.
- Both MVs have unique indexes matching their grain and are refreshed concurrently after initial
  population.

## Preserved non-Data objects

The following schemas/groups are explicitly outside the v3 cleanup. Their presence in the same
database does not authorize any mutation:

- Supabase: `auth`, `storage`, `realtime`, `vault`, `extensions`, `pgsodium`,
  `supabase_migrations`.
- Web/Auth: `bauth` and every contained table/function/ledger.
- Other application/system owners: `wechat`, `cron`, and any object not owned by the Data role.
- Storage objects and bucket contents.

Before `0091`/`0092`, the generated exact drop manifest must resolve every wildcard family above to
fully qualified relation names and compare it to `pg_depend`. A dependency outside Data ownership
blocks cleanup.
