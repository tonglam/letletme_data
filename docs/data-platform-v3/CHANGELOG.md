# Data Platform v3 Plan Changelog

## 3.2.5 - 2026-08-09

- Reconciled the merged Understat runtime into the v3 `understat`, `bridge`, and `ops` ownership
  model. Discovery/detail jobs now stage hash-bound normalized evidence and Team/Player finalizers
  apply complete snapshots in one PostgreSQL transaction.
- Added `0090_zzzz_integrate_understat_runtime.sql` for null-safe provider-pair idempotency and
  independent Player-lane season/team references, and removed five dependency-free Understat sync
  enum types after sync ownership moved to `ops`. The correction does not change table grain,
  cutover approvals, data-loss policy, or rollback policy, so plan version remains 3.2.5.
- Removed the merged Understat Data cache/publication path and routine cron schedules. Understat is
  explicit/API queued; its only Redis use is BullMQ, locks, and request permits on
  `QUEUE_REDIS_*` under the v3 coordination namespace. Its two BullMQ queue clients are lazy, so
  the default disabled runtime opens no Understat Redis connections.
- Accepted the integrated runtime on fresh and restored-B0 PostgreSQL 15 paths, including
  immutable run identity/terminal replay guards, complete-snapshot rollback tests, schema parity,
  least-privilege HTTP smoke, 729 unit tests, and the full P5 quality transaction. See
  `27-p3-understat-integration-acceptance.md`.

- Rejected rehearsal 5 at the encrypted full-B0 restore gate because `pg_restore --no-owner` was
  invoked with the direct `postgres` migration owner instead of the Supabase image administrator;
  the restore stopped before public business tables, Redis never started, and production was not
  touched. The runbook now makes the two local restore identities explicit.
- Rejected rehearsal 4 after the real Data writer correctly failed the core-cache preflight on
  `ops.migration_runs`; no v3 Redis key was written and the restored DB0 remained at 473 keys.
- Kept cache publication on the dedicated Data runtime identity and granted only column-level
  `SELECT` on `run_id`, `status`, and `metadata`. The writer still has no table-level read, no
  access to the remaining migration provenance, and no mutation privilege on migration runs.
- Added exact positive/negative grant validation to activation, P5, and PostgreSQL integration
  contracts, advanced Data/GraphQL publication parsing to plan 3.2.5, and required two new clean
  B0 replays before P5 can close.
- The focused writer regression then proved that Data's existing tournament refresh services could
  not enter `reporting`. Added schema usage plus `SELECT` only on the two tournament MVs; the three
  ordinary views remain GraphQL-only, reporting DML/DDL stays denied, and refresh remains limited
  to the two allowlisted `SECURITY DEFINER` functions.
- Corrected the production preactivation gate after the fresh cutover backup proved that the
  already-deployed GraphQL mainline added one catalog relation and two functions after the accepted
  B0. The gate now accepts only the exact old 220/6 baseline or the exact 221/8 baseline with the
  expected catalog shape, owner, function signatures, and zero tournament orphans.

## 2026-08-09 - Fresh-cluster migration and runtime identity correction

- Split the one-shot direct Supabase `postgres` migration identity from the Data API/worker
  `letletme_data_writer` LOGIN and made production startup fail before listening on an owner/admin
  or extra-membership connection.
- Required the GraphQL runtime to use its direct LOGIN identity and recursively inherit exactly
  `letletme_graphql_reader`, closing the extra-read-role and `SET ROLE` paths.
- Made isolated B0 ownership normalization transactional and faithful to production for the 220
  public relations plus the template-owned `bauth` and `wechat` application schemas, before Web
  or Data migrations run.
- Added a pre-DDL contract for the production-B0 empty `fpl` placeholder after rehearsal 3 proved
  that `pg_restore --no-owner` can retain the Supabase image template's different schema owner.

## 2026-08-09 - Post-cleanup B1 recovery and final performance gate

- Added generated, approval/run/dump-bound pre/post recovery capsules so selective rollback after
  `0091`, `0092`, or `0093` restores public data only from B1 and exact non-public cleanup state
  from its captured ops contract.
- Corrected PG15 public-schema ACL restoration and made the P5 quality validator valid both before
  and after physical v2 cleanup without reconstructing deleted source rows.
- Accepted encrypted B1-equivalent full and selective restores with zero data/security/ops diffs;
  the cleaned database measured 391,545,347 bytes versus the 512,218,885-byte budget ceiling.

## 2026-08-09 - Executable Redis cutover and representative memory gate

- Added a formal dry-run-first operator command for canonical BullMQ DB0-to-DB1 copy, independent
  target verification, and exact-manifest legacy cleanup.
- Bound Redis deletion to the same exact run-specific legacy-drop approval as PostgreSQL cleanup;
  retained bounded `SCAN` plus `UNLINK` and no `DEL`/`FLUSH` path.
- Restored the accepted Redis 7.0.15 B0 RDB and measured a 177,093,288-byte `used_memory`
  reduction while preserving all 296 queue keys and v3/unrelated sentinels.

## 2026-08-09 - Clean B0 cross-service rehearsal evidence

- Replayed the committed Data and Web migrations from a clean full B0 clone without SQL or
  migration-ledger correction and recorded every migration duration and deterministic hash gate.
- Accepted the P5 data-quality, cross-service least-privilege, and representative Data/GraphQL/Web
  journey gates, including authenticated selections and real maintenance-mode behavior.
- Kept the overall run-1 and performance gates open for representative Redis restoration, scoped
  memory cleanup, post-cleanup database sizing, and an exact-order intervention-free rerun.

## 2026-08-09 - Web runtime database boundary hardening

- Replaced Web's administrator runtime connection with a dedicated LOGIN inheriting only the
  NOLOGIN `letletme_web_auth` capability role; the direct administrator URL is migration-only.
- Added a fail-closed Next instrumentation contract for exact role attributes/membership, an
  explicit ten-table Better Auth allowlist, RLS policies, and zero Data/public/ledger access.
- Preserved but denied the three historical `bauth.apikey` rows discovered in full B0 because the
  current Web application has no API-key plugin or schema declaration.
- Added full-B0 PostgreSQL 15 tests proving allowed Auth CRUD, denied Data/API-key/ledger access,
  administrator rejection, and non-zero Web startup on an unsafe connection.

## 2026-08-09 - P5 performance evidence hardening

- Made the 500 x 38 x 15 reporting benchmark deterministic after its one-transaction fixture load
  by analyzing the four source relations before measurement; this models production planner
  statistics without racing autovacuum.
- Expanded the reporting read evidence from p95-only output to p50, p95, and maximum latency.
- Retained the observed stale-statistics execution plan as rehearsal evidence instead of counting
  it as the production-like performance result.

## 2026-08-09 - P5 rollback acceptance

- Added a generated, exact, approval-gated preactivation rollback capsule that restores the v2
  public ledger and staging ACL contract without dropping private v3 staging schemas.
- Accepted both preactivation and postactivation/pre-cleanup rollback drills against selective and
  full B0 restores, including exact old Data, GraphQL, and Web SHA startup probes.
- Corrected full-Supabase-PG15 validation to distinguish a real frozen-owner membership edge from
  PostgreSQL's superuser `pg_has_role()` semantics; applied the same rule to the pending `0093`
  cleanup postcondition.

## 3.2.4 - 2026-08-09

- Corrected the deterministic initial publication identity produced before runtime: a new
  non-destructive `0090_zzz` migration normalizes non-RFC UUID version/variant bits while
  transactionally preserving `ops.sync_runs` references, then installs and validates a named RFC
  UUID CHECK.
- Made `planVersion` mandatory in every immutable Redis publication manifest and in every staged
  database publication. Data and GraphQL now reject missing, stale-plan, or non-RFC authorities
  before serving a mixed contract.
- Replayed the correction twice on both the accepted B0 PostgreSQL 15 restore and a fresh
  PostgreSQL 15 database. Both second runs were no-ops; invalid IDs and stale v3 plan manifests
  were zero, while `0091`-`0093` remained approval-gated.

## 3.2.3 - 2026-08-09

- Collapsed the live Redis publication to one canonical four-item contract. `liveFixtures`
  requires `fixtureId`, `liveBonus` is computed only from fixture-scoped stats and supports
  summed DGW awards, and all dual/shadow live representations were removed. Substantive commit:
  `b91363196695e6f127b34f1e7c0486bc77db4c15`.

- Accepted GraphQL G1 at `886351b1c26d86f5e8010cb57e8d5f33469423c8`: schema-qualified PostgreSQL
  readers, SELECT-only fail-closed startup contract, no GraphQL business migrations, and direct
  multiplier-aware reporting-MV percentages. See `13-p4-g1-acceptance.md`.

- Absorbed the newly merged GraphQL `public_league_trends_catalog` contract into the sole
  Data-owned physical source `competition.public_league_trends`.
- Preserved explicit operator enablement and display ordering while keeping GraphQL read-only and
  removing any need for GraphQL-owned business DDL.
- Added a guarded rehearsal copy for the unshipped public source and explicit role/grain tests.
- Substantive contract commit: `e91a355c9d2253c2ebff07256c3793a57c7f49b9`.

## 3.2.2 - 2026-08-09

- Corrected the private-schema ACL contract so `letletme_graphql_reader` can actually consume its
  existing read-only `ops.dataset_publications` grant.
- Added an explicit integration assertion that the GraphQL role can read publication authority but
  cannot mutate it or create objects in `reporting`.
- Updated existing v3 publication manifests to the current plan version without changing dataset
  revisions or granting any write capability.
- Advanced the GraphQL implementation baseline from planned `8cf4ddc` to fetched `3cc9951` so the
  already-merged player-state/data-page contract and bounded tournament-cache fix are preserved.

## 3.2.1 - 2026-08-09

- Audited every deleted v2 test and added real PG15 write coverage for all 26 active FPL and
  competition physical-table families instead of treating deletion as equivalent coverage.
- Restored `fpl.player_fixture_stats` ingestion from fixture-grain FPL live explanations inside the
  unified live persistence transaction; unresolved incoming references now fail atomically.
- Recorded the P3 test retirement/replacement matrix and kept the B0-sized tournament setup
  benchmark as an explicit P5 rehearsal gate.
- Closed runtime SQL defects exposed by the expanded persistence contract: schema-qualified event
  conflict expressions, timestamp binding in rich entry-result UPSERTs, and overflow-safe entry
  advisory lock keys.

## 3.2.0 - 2026-08-09

- Locked the P3 runtime implementation to explicit database season authority, one schema-qualified
  physical-table contract, and immutable Redis publications with independently configured queue
  and cache endpoints.
- Made reporting summaries read-only views/materialized views and removed physical summary writes
  and retired cache publications from the Data runtime.
- Added PG15 Drizzle-export catalog parity to CI. SQL migrations explicitly own materialized-view
  indexes, the active-publication partial `NULLS NOT DISTINCT` index option, and the stable name of
  the circular publication foreign key.
- Added positive-integer API boundary validation and made PostgreSQL runtime identities/business
  uniqueness enforceable for post-migration writes.

## 3.1.1 - 2026-08-09

- Refined the B0 current value audit: 9 of 573 start rows coincide with a player's first market
  capture and reconstruct directly; exactly 564 require provenance-marked seed snapshots.
- Made current tables authoritative when a 2627 history partition overlaps the same business key;
  B0 currently has this overlap for all 20 teams.
- Added the hosted PostgreSQL patch warning and dedicated non-migration runtime credentials as
  explicit production activation preflight gates.

## 3.1.0 - 2026-08-09

- Corrected `entry_history_infos` from an event-grain assumption to its actual season-summary
  grain and renamed the target physical table to `competition.entry_season_histories`.
- Added reference-only `fpl.seasons` rows for 2011/12 through 2015/16 so all preserved entry
  histories retain an authoritative `season_id` without fabricated core facts.
- Corrected the cup-result key: the source has no `match_id`, so v3 preserves the source result ID.
- Recorded the B0 value audit: 28,266 historical value rows reconstruct exactly from market
  snapshots; all 573 current start rows predate the first market capture and require one-to-one,
  provenance-marked seed snapshots before the final zero-mismatch gate.
- Renamed the normalized physical scoring table to `fpl.player_gameweek_scoring_items`, completing
  the plural physical-table naming rule.
- Updated the authoritative B0 Understat player-match count to 129,576.

## 3.0.0 - 2026-08-08

- Established a clean execution baseline from Data `origin/main` at `62f134a`.
- Recorded the production migration tail as `0078` and PostgreSQL as 15.8.
- Locked the six-schema ownership model, unified season tables, plural naming, and private Data API
  boundary.
- Locked the hard-cutover strategy with no dual-write, shadow reads, or v2 fallback.
- Locked Redis publication/query-cache ownership and removed the Data Understat cache.
- Added a pre-execution dirty-worktree isolation requirement. The existing
  `codex/understat-pipeline` checkout is not a v3 base and is handled by a separate task.
- Preserved an explicit approval gate before production legacy-object deletion.
