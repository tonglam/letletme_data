# P3 Test Retirement and Replacement Audit

Plan version: 3.2.1

Status: **ACCEPTED**

This audit covers every test file removed while replacing the v2 Data runtime. Removing a test is
acceptable only when the tested behavior is deliberately retired or when an identified v3 test
executes the replacement contract. A deleted test is not evidence that its behavior is obsolete.

## Inventory

- Deleted test files: 62 total — 48 integration and 14 unit.
- Deleted integration helpers: 3. They mutated shared v2/current-season tables and were replaced by
  one disposable, explicit-season PostgreSQL fixture.
- Current suite after replacement: 11 integration files and 76 unit files.
- `tests/integration/core-persistence-contract.test.ts` now writes all 26 active FPL and competition
  physical-table families through runtime services/repositories, repeats every idempotent path,
  injects transaction failures, validates reporting output, and cleans its exact fixture seasons.

## Integration-test disposition

| Deleted v2 test family | Files | v3 disposition and evidence |
| --- | --- | --- |
| Core dimensions and atomic persistence | `core-snapshot-atomicity`, `events`, `fixtures`, `phases`, `players`, `teams`, `upsert-correctness` | Replaced by `core-persistence-contract`, `database-trust-boundary`, schema parity, and the retained domain/upsert unit tests. The PG15 test proves rollback, 38/20/220/1/380 persistence, and repeat-write cardinality. |
| Core publication and performance | `core-snapshot-benchmark`, `player-cache-atomicity`, `fixtures-cache-guard` | Replaced by `data-publication`, `core-publication-benchmark`, `redis-separation`, and publication unit tests. These use immutable `llm:v3:data:*` revisions instead of mutable v2 hashes. |
| Live facts, explain facts, and fixture attribution | `event-lives`, `event-live-explains`, `event-finalization-checkpoint`, `live-snapshot-cache`, `live-snapshot-serialization`, `live-fixtures`, `live-bonus` | Replaced by `core-persistence-contract` plus live snapshot/bonus unit suites. The PG15 test now proves one transaction owns gameweek stats, scoring items, and per-fixture evidence; invalid scoring or fixture references roll back all three. |
| Retired physical summaries | `event-live-summaries`, `event-overall-results` | Deliberately retired. `reporting.player_season_summaries` is tested from canonical gameweek facts in `core-persistence-contract`; no physical summary writer or Redis key remains. |
| Player snapshots and value derivation | `player-stats`, `player-values` | Replaced by `core-persistence-contract`, player stats/market/value unit tests, and B0 migration reconciliation. The PG15 test writes event snapshots and complete market days twice and reads `reporting.player_value_changes`. |
| Entry ownership and checkpoints | `entries`, `entry-infos`, `entry-result-evidence-time`, `entry-sync-keyset` | Replaced by `core-persistence-contract`, `sync-operations`, and entry history/sync/convergence unit tests. The PG15 test covers rename history, picks, rich results, transfer checkpoints, season histories, leagues, cup results, and stale evidence rejection. |
| League jobs/results | `league-event-picks`, `league-event-results`, `league-result-checkpoint`, `league-sync-jobs`, `workers/league-sync.worker` | Database writes are covered by `core-persistence-contract`; convergence, cascade, freshness, queue targeting, and retry behavior are covered by retained unit tests. Mutable shared-environment worker fixtures were retired. |
| Live jobs/workers | `live-data-jobs`, `workers/live-data.worker` | Replaced by live-data job/cascade, post-match readiness, event finalization, and live snapshot unit tests. Durable write atomicity is covered by `core-persistence-contract`. |
| Tournament persistence | `tournament-creation-entry-infos`, `tournament-event-cup-results`, `tournament-event-picks`, `tournament-event-results`, `tournament-event-transfers`, `tournament-info`, `tournament-battle-race-counters`, `tournament-battle-race-results`, `tournament-knockout-results`, `tournament-points-race-results` | Replaced by `core-persistence-contract` for every physical tournament table and by retained lifecycle, convergence, readiness, history, management, and race-batch unit suites. |
| Tournament reporting | `tournament-selection-stats-atomicity` | Replaced by `tournament-selection-reporting` and `core-persistence-contract`. Both reporting MVs are refreshed only after complete checkpoints; selection denominators/counts/percentages are asserted. |
| Tournament setup orchestration | `tournament-setup-enqueue`, `tournament-sync-checkpoints`, `tournament-sync-jobs`, `workers/tournament-sync.worker` | Replaced by retained enqueue, cascade barrier, lifecycle, finalization, management, convergence, and transaction-coverage unit tests. Queue/database endpoint separation is integration-tested. |
| Tournament setup benchmark | `tournament-setup-benchmark` | Deferred to P5 rehearsal, where B0-sized production-like data and the accepted candidate image are mandatory. It is not counted as a P3 pass. |

Deleted helpers `helpers/current-event.ts`, `helpers/reference-data.ts`, and
`helpers/tournament-seed.ts` belonged to the shared mutable v2 fixture strategy. The replacement
test creates explicit seasons in `p3_schema_export`, never resolves season from wall-clock state,
and removes only its own IDs in `finally`.

## Unit-test disposition

| Deleted unit tests | Disposition |
| --- | --- |
| `cache-hygiene`, `cache-season`, `event-live-explains-cache`, `fixture-cache-transition`, `live-snapshot-ownership`, `player-cache-merge`, `player-stats-cache-publish`, `player-values-cache-merge`, `player-values-cache-repair` | Retired v2 mutable-key behavior. Replaced by immutable publication, endpoint separation, and scoped legacy cleanup tests. |
| `core-fixture-derivatives`, `fixture-repair-plan` | Retired mutable fixture-cache derivative/repair layer. Canonical fixtures plus one coherent live revision now own the behavior; fixture validation and live snapshot tests remain. |
| `event-overall-results` | Retired physical aggregate. The reporting view is asserted against canonical live facts. |
| `players.service` | Retired cache-first service. Core snapshot publication and schema-qualified repository contracts replace it. |
| `tournament-selection-stats` | Retired physical stats service. PostgreSQL reporting MV semantics are covered by integration tests. |

## Repository/table ownership result

The runtime writer audit found one real omission: `fpl.player_fixture_stats` remained in the target
model and migration matrix, but its domain transformer, repository, and `event-live` transaction
call had been dropped during the v3 rewrite. P3 now restores that path with:

1. fixture-grain transformation from each FPL `event-live` explain;
2. explicit `(season_id, fixture_id, element_id)` reconciliation;
3. canonical fixture/player/team validation and deterministic source hashes;
4. hard failure for unresolved incoming evidence, so the entire live transaction rolls back rather
   than silently publishing incomplete facts;
5. conservative preservation when an already-finished fixture disappears from an incomplete
   upstream response.

All FPL and competition target physical tables now have a runtime writer and real PG15 write
coverage. `ops.sync_runs`, `ops.sync_items`, and `ops.dataset_publications` are covered by
`sync-operations`. `ops.season_imports` belongs to the separately owned Understat ingestion branch.
`ops.migration_runs`, `ops.migration_objects`, and `ops.schema_migrations` are migration-owned and
are exercised by fresh and B0 replay, not application repositories.

## Acceptance rule

P3 may close only after the full unit suite, fresh and B0 integration suites, schema export/catalog
parity, lint, typecheck, build, Drizzle check/export, and whitespace checks all pass after this
audit. P5 still owns the deferred tournament setup benchmark and full rehearsal workload.
