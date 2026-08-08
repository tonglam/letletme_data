# Data Platform v3 Execution Plan

Plan version: 3.1.1

Execution strategy: preseason hard cutover

Destructive cleanup gate: explicit approval required after B1

## Governance

- This document and `02-checklist.md` are the execution source of truth.
- Every production object must have exactly one row in `03-object-migration-manifest.md` before P2
  is accepted.
- Every completed checklist item must link to durable evidence: command output, SQL result, backup
  manifest, test report, commit SHA, or deployment run.
- A failed acceptance gate stops the phase. It is not converted to a warning.
- Any change to target ownership, table grain, cutover semantics, data-loss policy, or rollback
  strategy requires a plan-version bump and a `CHANGELOG.md` entry.
- The current `codex/understat-pipeline`, GraphQL, and Web working trees are user-owned and may be
  dirty. They are never used as v3 branch bases.
- Production destructive operations are restricted to migrations `0091`-`0093` and require the
  exact approval phrase documented in `05-cutover-runbook.md`.

## Branch and dependency graph

Branches are stacked only within the same repository. Each branch starts from a clean fetched
remote ref or the accepted predecessor SHA.

| ID | Repository | Branch | Depends on | Deliverable |
| --- | --- | --- | --- | --- |
| D0 | Data | `codex/data-platform-v3-baseline` | Data `origin/main` | Plans, inventory, deploy lock |
| D1 | Data | `codex/data-platform-v3-schema` | accepted D0 | Schema, migration, validation SQL |
| D2 | Data | `codex/data-platform-v3-runtime` | accepted D1 | Repositories, sync, Redis contract |
| D3 | Data | `codex/data-platform-v3-cleanup` | accepted D2 | Cleanup migrations and runbooks |
| G1 | GraphQL | `codex/data-platform-v3-pg-readers` | GraphQL `origin/main`, D1 contract | Direct PostgreSQL readers |
| G2 | GraphQL | `codex/data-platform-v3-reporting-cache` | accepted G1, D2 contract | Reporting readers and v3 cache |
| G3 | GraphQL | `codex/data-platform-v3-player-state` | accepted G2 | Limited Understat player-state API |
| W1 | Web | `codex/data-platform-v3-contract` | Web `origin/main`, accepted G3 schema | Query updates and maintenance UX |

Integration order is D0 -> D1 -> D2 -> G1 -> G2 -> G3 -> W1 -> D3. Production activation uses
exact accepted SHAs. No branch is merged merely to unblock another branch; contract tests may pin
an unmerged predecessor SHA.

## P0 - Freeze, inventory, and deploy lock

Purpose: establish a reproducible baseline before any implementation or production mutation.

Implementation:

1. Create D0 from fetched Data `origin/main`; leave all existing dirty worktrees untouched.
2. Save the initial plan set at 3.0.0; every later source-contract correction is versioned in
   `CHANGELOG.md` before implementation.
3. Capture exact SHAs, open PRs, CI/deploy workflows, migration tails, runtime versions, and current
   production database/Redis topology.
4. Enumerate production relations, functions, triggers, policies, grants, foreign keys, indexes,
   sizes, row counts, and migration ledgers. Classify every object in the migration manifest.
5. Enumerate every Data/GraphQL/Web database reference and every Redis key builder. Assign each to
   a target object or explicit retirement.
6. Add a deploy guard that prevents the v3 branch from being deployed until the exact externally
   frozen release manifest, its checksum, the activation token, and a digest-pinned prebuilt
   candidate image are present. The manifest is not committed into the candidate commit or image,
   avoiding commit/image self-reference. Existing production deployment remains unchanged.
7. Create a run ID format: `v3-YYYYMMDDTHHMMSSZ-<short-data-sha>`.

Acceptance:

- D0 is clean before edits and based on the fetched `origin/main` SHA recorded in the plan.
- Production PostgreSQL version, database size, migration tail, relation counts, and Redis
  endpoints are captured.
- No production relation/function/trigger or application database/cache reference is unclassified.
- The plan, checklist, object manifest, test matrix, runbook, and changelog are committed together.

## P1 - B0 backup and restore rehearsal

Purpose: prove recoverability before production DDL or data changes.

Implementation:

1. Enter a bounded backup window. Pause Data workers only if needed for a transactionally
   consistent logical snapshot; GraphQL remains read-only.
2. Create B0 under
   `/Users/tong/Documents/LetLetMe Backups/v3-cutover/<run-id>/b0/`:
   - roles/globals dump;
   - schema-only dump;
   - full custom-format logical dump;
   - Data-owned selective custom-format dump;
   - migration-ledger exports;
   - exact relation counts and canonical hashes;
   - Redis RDB/snapshot evidence, BullMQ inventory, and namespace/type/TTL manifest.
3. Encrypt B0 using GPG AES-256. Store checksums outside the encrypted payload and verify them
   after encryption.
4. Restore the full dump into isolated PostgreSQL 15. Restore the selective dump into a second
   clean PostgreSQL 15 database.
5. Re-run schema, count, hash, FK, view-definition, role/grant, and representative query checks on
   both restores.
6. Resume any paused worker only after the source remains healthy and the restore report passes.

Acceptance:

- Every backup command exits zero and the manifest contains timestamp, source project, PostgreSQL
  version, tool versions, sizes, SHA-256 checksums, and encryption status.
- Full and selective restores complete on PostgreSQL 15 without ignored errors.
- Restored relation counts and canonical hashes match the source snapshot.
- Representative FPL, competition, Understat, bridge, auth-binding, and migration-ledger queries
  pass.
- B0 retention is recorded as one year; Redis RDB retention is recorded as 14 days.

## P2 - v3 schemas, migrations, and data conversion

Purpose: create the complete target model and deterministic migration path without altering
production yet.

Migration sequence:

| Migration | Responsibility |
| --- | --- |
| `0079_create_v3_ops_and_roles.sql` | Schemas, roles, grants, ops audit/publication foundation |
| `0080_create_v3_fpl_dimensions.sql` | Seasons, events, teams, players, phases |
| `0081_create_v3_fpl_facts.sql` | Fixtures, snapshots, GW facts/scoring, fixture facts, market snapshots |
| `0082_create_v3_competition.sql` | Entry, league, and tournament physical facts |
| `0083_create_v3_understat_bridge.sql` | Provider tables, bridge links, provider sync audit mapping |
| `0084_create_v3_reporting.sql` | Views, materialized views, refresh functions and unique indexes |
| `0085_migrate_v3_fpl_data.sql` | Multi-season FPL conversion and source metadata |
| `0086_migrate_v3_competition_data.sql` | Entry/league/tournament conversion |
| `0087_migrate_v3_understat_ops_data.sql` | Understat, bridge, publications, imports, audit conversion |
| `0088_validate_v3_constraints.sql` | Validate deferred checks/FKs and record reconciliation |
| `0089_prepare_v3_publications.sql` | Create initial publication records without activating readers |
| `0090_activate_v3_and_freeze_v2.sql` | Revoke v2 writes, activate v3 revision, establish cutover fence |
| `0091_drop_v2_reporting_and_rpcs.sql` | Approval-gated legacy views/MVs/RPC removal |
| `0092_drop_v2_tables_partitions_triggers.sql` | Approval-gated legacy physical-object removal |
| `0093_finalize_v3_migration_ownership.sql` | Remove compatibility ledger/view and obsolete GraphQL DDL state |

Schema rules:

- Every table has an explicit primary key, `NOT NULL` business-key columns, FK indexes, and named
  constraints.
- Multi-season FPL keys start with `season_id`; competition event facts also carry `season_id`.
- IDs from upstream providers are stored as provider IDs, not generated surrogate replacements,
  unless the source has no stable identifier.
- All timestamps are `timestamptz`; exact decimal metrics use `numeric`; booleans are boolean.
- Tables remain unpartitioned until a measured table exceeds 100 million rows or maintenance data
  demonstrates a benefit.
- New schemas are private. `anon`, `authenticated`, and `PUBLIC` receive no access. GraphQL receives
  only schema usage and object-specific select/execute privileges.
- Reporting ordinary views use `security_invoker = true`. MVs have no RLS and are readable only by
  the GraphQL read role.
- MV refreshes use unique indexes and `REFRESH MATERIALIZED VIEW CONCURRENTLY` after the first
  population. Refresh is protected by a transaction-level advisory lock.
- Bulk data movement uses `INSERT ... SELECT` or `COPY`, stable ordering, conflict-free keys, and
  short transactions per object/season. Network calls never occur inside database transactions.

Conversion rules:

- Current tables and all season-suffixed/history partitions feed the same target tables.
- `event_live_summaries*` rows are never copied; the new view must reproduce season totals from
  gameweek facts.
- `player_values*` rows are not copied when market snapshots reproduce them. The B0 audit proved
  all historical rows reconstruct exactly. Of 573 current-season start rows, 9 coincide with the
  first market capture and 564 predate it. `0085` therefore creates one provenance-marked
  `legacy_value_seed` market snapshot per missing start row, then requires the reporting view to
  reproduce both historical and current value rows exactly. Any remaining mismatch stops P2.
- `entry_history_infos` is season-summary history, not event history. It migrates to
  `competition.entry_season_histories` at `(season_id, entry_id)` grain. Reference-only season rows
  preserve 2011/12 through 2015/16 without creating fake FPL core facts.
- `entry_event_cup_results` has no source `match_id`; its stable source row ID is preserved in the
  target key instead of inventing a match identity.
- `tournament_selection_stats` rows are never copied; the MV is rebuilt from complete picks.
- `mv_tournament_snapshot` and compatibility views have no target.
- Understat names are removed only at the schema boundary: for example
  `public.understat_matches` -> `understat.matches`. Provider fields and evidence are not merged
  into FPL facts.
- Only `auto_verified` and `manual_verified` bridge links are consumable. Candidate/unverified rows
  remain provider-resolution evidence but cannot drive joins.

Acceptance:

- Fresh install and upgrade from the exact production B0 schema both apply `0079`-`0090` twice
  safely in PostgreSQL 15.
- All intended PK/FK/check/unique constraints validate and all FK columns have supporting indexes.
- Source and target counts/hashes pass `04-test-matrix.md` for every season and object.
- No target application table or view is reachable through the Supabase Data API roles.
- Supabase security/performance advisors have no unaccepted v3 finding.

## P3 - Data runtime and Redis publication

Purpose: make Data the sole v3 writer and cache publisher.

Implementation:

1. Replace public/suffixed repository names with schema-qualified v3 repositories. Every repository
   method requires an explicit season; only a current-season boundary service may resolve
   `fpl.seasons.is_current`.
2. Remove history-parent routing, season table-name construction, physical summary writes,
   tournament-stat table writes, and obsolete MV refreshes.
3. Consolidate sync metadata into `ops.sync_runs`, `ops.sync_items`, `ops.dataset_publications`, and
   `ops.season_imports`.
4. Preserve immutable core/live revision publication: stage a full revision, validate it, atomically
   move the manifest pointer, then retire the prior revision.
5. Configure separate queue and cache Redis clients. Queue code cannot receive the cache client and
   cache code cannot receive the queue client.
6. Adopt the `llm:v3:data:*` namespace, type metadata, revision manifest, and TTL contract. Add
   bounded namespace cleanup using `SCAN` + `UNLINK`.
7. Remove Data Understat cache code and scheduling. Understat ingestion writes PostgreSQL only and
   stages normalized payload/evidence in `ops.sync_items` before a transactional finalizer.
8. Remove EventLiveSummary and PlayerValue publication keys. Readers use the v3 facts/views.

Acceptance:

- No Data runtime SQL references `public` business tables, `_history`, or season-suffixed names.
- No Data source contains an Understat Redis writer or retired key builder.
- Publication interruption before pointer swap leaves the old revision active; interruption after
  swap leaves one valid active revision and a bounded retired revision.
- Cache and queue endpoint tests prove no client is cross-wired.
- Core rebuild completes within five minutes on the B0 dataset.

## P4 - GraphQL and Web contracts

Purpose: move all consumers to v3 and remove independent business-schema ownership.

GraphQL implementation:

1. Replace Supabase Data API business reads with schema-qualified `pg` repositories.
2. Remove the Supabase business client/dependency/env. A storage-only Supabase client is not added
   to GraphQL.
3. Replace GraphQL migration execution with a read-only schema-contract startup check. Deploy does
   not create/alter/drop business objects.
4. Use a typed Data publication reader for core/live Redis. A missing or invalid revision falls
   back to one coherent PostgreSQL dataset revision, never mixed per key.
5. Read reporting views/MVs directly. Remove compatibility-view and aggregation-RPC fallbacks.
6. Resolve the current season from `fpl.seasons.is_current`; Redis is not season authority.
7. Add query-cache keys containing GraphQL schema version and Data dataset revision.
8. Add the limited `playerStateProfile` resolver over indexed Understat/bridge PostgreSQL reads,
   with 900-second success and 60-second valid-null TTLs.
9. Use a read-only database role. Any residual Better Auth mutation moves to Web-owned endpoints.

Web implementation:

1. Update GraphQL operations/types for v3 reporting and player-state contracts.
2. Preserve Better Auth ownership and direct `bauth` access only where already required.
3. Add a maintenance state for the hard-cutover window; do not present stale v2 data as current.
4. Verify selections, player detail, live points, market, tournament, profile, and binding journeys.

Acceptance:

- GraphQL has zero `.from()` business-table calls and zero v2 reporting/RPC references.
- GraphQL starts with `SELECT` only and fails closed when the v3 schema contract is absent.
- The GraphQL database role cannot insert/update/delete Data tables.
- Web has no new direct access to Data-owned schemas.
- Contract tests and representative end-to-end journeys pass against the migrated B0 dataset.

## P5 - Full rehearsal

Purpose: prove the exact production procedure, timing, rollback, and data/performance gates.

Implementation:

1. Restore B0 into isolated PostgreSQL 15 and restore representative Redis state.
2. Deploy the exact candidate Data/GraphQL/Web builds in maintenance mode.
   Freeze the candidate Data image by digest, then generate the external release manifest from
   `release-manifest.template.json`; store it in the encrypted cutover evidence, not in Git.
3. Run `0079`-`0090`, migrate all data, build publications/MVs, and run the complete test matrix.
4. Record per-migration duration, lock waits, database growth, Redis memory, query p95, and cache
   hit/miss behavior.
5. Exercise rollback before `0090`, after `0090` but before `0091`, and after a simulated `0091`
   using B1-equivalent selective restore.
6. Repeat until the runbook is executable without undocumented intervention.

Acceptance:

- Two consecutive rehearsals pass with identical target hashes and no manual SQL correction.
- Maintenance-window estimate includes 50% contingency and fits the approved window.
- Selection MV refresh is <=30 seconds at 500 entries x 38 events x 15 picks.
- Selection query p95 is <=100 ms cold DB and <=20 ms warm cache.
- Player season summary p95 is <=150 ms.
- Understat player state p95 is <=500 ms cold and <=50 ms warm.
- Redis memory is at least 100 MB lower after retiring Understat Data cache, or the discrepancy is
  explained and accepted.
- Target database size does not exceed B0 by more than 20% without an accepted explanation.

## P6 - Production hard cutover

Purpose: activate v3 without concurrent v2/v3 writers.

Implementation:

1. Verify B0, rehearsal reports, exact candidate SHAs, image digests, migration checksums,
   maintenance messaging, operator/runtime roles, and resolution or explicit acceptance of the
   hosted PostgreSQL security-patch advisor warning.
2. Enable maintenance mode and stop Data API/workers plus GraphQL. Web serves maintenance UX.
3. Confirm no active application sessions or queued jobs can write business data.
4. Apply `0079`-`0090` with statement/lock timeouts and durable command logging.
5. Run all data gates, refresh reporting MVs, build the first v3 Redis revision, and validate the
   active manifest.
6. Start Data, then GraphQL, run private smoke tests, then disable maintenance mode.
7. Keep all v2 objects frozen and inaccessible to writers. Do not run cleanup migrations.

Acceptance:

- Exactly one writer set is active at every point.
- All data, contract, security, performance, and private-smoke gates pass.
- No service log contains missing-relation, permission, mixed-revision, or cache-type errors.
- v2 object row counts/hashes remain unchanged after the freeze point.

## P7 - B1 and legacy cleanup

Purpose: remove v2 only after v3 is proven and another recoverable checkpoint exists.

Implementation:

1. Take encrypted B1 full and legacy-selective backups immediately before cleanup.
2. Restore-spot-check B1 and verify the legacy object manifest.
3. Present the B1 evidence, v3 acceptance report, frozen-v2 hash report, and exact `0091`-`0093`
   drop list to the user.
4. Wait for the exact explicit deletion approval. Without it, keep v3 live and v2 frozen.
5. Re-enter maintenance, apply `0091`-`0093`, run schema/data/security tests, rebuild publications,
   and resume services.
6. Delete only retired Redis namespaces using scoped `SCAN` + `UNLINK` and save the deletion count.

Acceptance:

- B1 restore spot-check passes before any drop.
- Approval text and run ID are captured in the run evidence.
- No v2 application relation, compatibility view/MV/RPC, trigger, or obsolete grant remains.
- Supabase system schemas, `bauth`, Web data, and unrelated application objects are unchanged.

## P8 - Post-cutover verification and retention

1. Take encrypted B2 after cleanup; retain it for 90 days.
2. Monitor for 24 hours: sync freshness, publication revisions, job failure rate, GraphQL errors,
   cache memory/hit rate, DB locks/latency/size, and key user journeys.
3. Run final security/performance advisors and exact object inventory.
4. Close the execution only after the 24-hour report passes and all evidence links are attached.

Rollback boundaries:

- Before `0090`: stop, drop only unactivated v3 objects in the isolated/rehearsal environment, and
  keep production v2 unchanged.
- After `0090` and before `0091`: re-enter maintenance, deactivate v3 publication/permissions,
  restore the frozen v2 writer contract, and deploy the recorded old SHAs. Never run both writers.
- After `0091`: remain in maintenance and restore B1 selective/full. Do not improvise object
  recreation from memory.
