# Data Platform v3 Plan Changelog

## 3.2.3 - 2026-08-09

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
