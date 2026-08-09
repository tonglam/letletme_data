# Data Platform v3 Test and Acceptance Matrix

Plan version: 3.2.3

## Evidence rules

- Every SQL check records the run ID, source/target object, query SHA-256, row count, failed count,
  sample failed keys, and execution timestamp in `ops.migration_objects` and the run artifact.
- Canonical hashes concatenate stable business columns in primary-key order. Volatile audit/load
  timestamps are excluded only when the manifest names them explicitly.
- A critical or high data-quality failure blocks activation. A medium/low exception requires an
  owner, explanation, affected keys, and plan changelog entry.
- Estimates from `pg_stat_user_tables` are inventory hints only; migration acceptance uses exact
  `count(*)` and canonical hashes.

## Repository checks

### Data

Run on PostgreSQL 15 with separate queue/cache Redis instances:

```text
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
bun run build
DATABASE_URL=<disposable-export-db> bun run db:export
RUN_INTEGRATION=1 bun test tests/integration
LOG_LEVEL=error RUN_INTEGRATION=1 bun run test:publication:integration
LOG_LEVEL=error RUN_INTEGRATION=1 RUN_B0_ACCEPTANCE=1 \
  bun run test:core-publication-benchmark
```

Required migration cases:

1. fresh bootstrap through `0090`;
2. fresh bootstrap run a second time/status clean;
3. exact B0 upgrade through `0090`;
4. B0 upgrade run a second time/status clean;
5. interrupted conversion resumes without duplicate or partial target rows;
6. wrong PostgreSQL major fails before DDL;
7. checksum mismatch/missing applied migration fails closed;
8. `0091`-`0093` fail without the exact approval gate;
9. `0091`-`0093` affect only the generated allowlist;
10. GraphQL/Web/system schemas remain byte-for-byte/schema-definition equivalent where expected.
11. Drizzle export applies cleanly to an empty PG15 database and catalog parity passes against the
    migrated database. SQL owns the two reporting-MV index sets, the partial active-publication
    `NULLS NOT DISTINCT` option, and the stable name of the circular publication foreign key.
12. `letletme_graphql_reader` can select `ops.dataset_publications`, cannot mutate it, and has no
    create privilege in any Data-owned schema.
13. `competition.public_league_trends` exists at season/tournament grain; only the Data writer can
    mutate it and GraphQL can only select it.

### GraphQL

```text
bun install --frozen-lockfile
bun run format:check
bun run lint
bun test
```

Required cases:

- startup succeeds with the exact v3 schema version and read-only role;
- startup fails closed for missing relation/column, wrong schema version, or write-capable role;
- no business DDL executes during startup/deploy;
- core/live reader accepts one complete revision and rejects missing/mixed revisions;
- PostgreSQL fallback reads one coherent dataset revision;
- cache keys include GraphQL schema version and Data dataset revision;
- authorization uses direct competition reads and cannot mutate rows;
- reporting readers use only v3 views/MVs;
- `playerStateProfile` handles verified link, no verified link, no Understat data, provider error, and
  bounded success/null cache TTLs.

### Web

```text
npm ci
npm run lint
npm test
npm run build
npm run test:e2e
```

Required journeys:

- selections page position counts/percentages;
- player directory/detail and season summary;
- player-state profile available/unavailable states;
- live points and event status;
- market history/value-change views;
- tournament creation, membership, results, entry event summaries, and selection statistics;
- login, FPL binding, profile, and session management;
- maintenance mode and recovery from maintenance without stale v2 content.

## Data quality checks

### Universal object checks

| Category | Check | Pass condition | Severity |
| --- | --- | --- | --- |
| Completeness | Required columns populated | zero null/blank values outside documented nullable fields | Critical |
| Uniqueness | Primary/composite key duplicates | zero duplicate keys | Critical |
| Exactness | Canonical source vs target hash | hashes and row-level mismatch count agree; zero unexplained mismatch | Critical |
| Integrity | FK/orphan coverage | zero orphan target rows | Critical |
| Shape | Join expansion | expected 1:1/1:N cardinality; no unexplained multiplication | High |
| Validity | Enum/range/cross-field checks | zero invalid rows | High |
| Timeliness | Source/load/publication timestamps | within dataset-specific freshness bound | High for current, Medium historical |
| Volume | Exact row count by season/object | equals conversion formula | Critical |
| Schema | Columns/types/constraints/indexes | matches target manifest exactly | Critical |

### FPL dimensions and fixtures

For completed seasons `1617` through `2526`:

- exactly 20 teams per season;
- exactly 380 fixtures per season;
- exactly 38 event rows per season;
- each fixture has two different valid teams;
- each team appears in 38 fixtures, counting postponed fixtures by fixture identity rather than
  gameweek assignment;
- kickoff/score/finished/provisional fields satisfy cross-field checks;
- blank and double gameweeks are represented through fixture-to-event allocation and do not change
  the 380-fixture season rule.

For current preseason `2627`:

- target counts equal the frozen upstream/current-source snapshot rather than completed-season
  constants;
- exactly one `fpl.seasons.is_current=true` row exists;
- no code infers current season from wall-clock time or table suffix.

### Player facts

- `fpl.players`: unique `(season_id, element_id)` and valid team/type references.
- `fpl.player_event_snapshots`: unique `(season_id, event_id, element_id)` and no event/team/player
  orphan.
- `fpl.player_gameweek_stats`: one row per available season/event/player upstream live result.
- `fpl.player_gameweek_scoring_items`: scoring rows roll up exactly to the corresponding official
  explain totals where the upstream exposes a breakdown.
- `fpl.player_fixture_stats`: fixture/player rows use the correct fixture event and team; no join
  expansion when linked to fixtures.
- `reporting.player_season_summaries`: one row per season/player and each additive measure equals
  the sum of gameweek facts. `event_id` and `team_id` are absent from the view contract.
- Historical summary counts equal historical player counts, including 841 rows for `2526` if the B0
  exact source confirms that count.

### Market/value audit

For every v2 `player_values*` row:

1. derive the same business output from ordered `fpl.player_market_snapshots`;
2. compare player, effective date/event, current price, prior price, and change;
3. report unmatched source rows, unmatched derived rows, and differing values.

Pass condition: zero mismatch after the versioned B0 exception is applied. Historical rows must
derive directly. Nine B0 current-season start rows derive from same-day first captures; the other
564 must map one-to-one to `snapshot_source='legacy_value_seed'` facts. No other source value row
may create a seed fact. Any remaining mismatch blocks dropping `player_values*`.

### Competition and tournament

- Every competition fact has a valid season, entry, and event where applicable.
- Complete entry picks have positions 1-15 exactly once, one captain, one vice-captain, and valid
  multipliers/chips.
- Transfers retain source identity/order and do not collapse multiple same-element transactions.
- Result/checkpoint timestamps never precede source evidence timestamps.
- Tournament rows reference the same season as their entry/event facts.
- For each complete tournament/event with `N` entries:
  - `sum(selected_count) = N * 15`;
  - `sum(captain_count) = N`;
  - `sum(vice_captain_count) = N`;
  - `selection_percentage = selected_count * 100 / N` with zero-denominator guarded;
  - effective ownership matches the agreed multiplier formula;
  - every percentage is between 0 and 100, except explicitly defined effective ownership which may
    exceed 100.
- The selection MV does not publish a tournament/event until every expected entry has 15 valid
  picks.
- The entry-event summary MV has exactly one row per tournament/event/entry and agrees with source
  results, picks, transfers, and chips.

### Understat and bridge

- B0 exact counts are authoritative. Current inventory sanity values are 4,560 matches and 129,576
  player-match rows; differences at B0 must be explained by legitimate ingestion before migration.
- Provider table PKs are unique and parent links have zero orphans.
- Match/player/team season relationships do not multiply source rows.
- Only verified bridge rows are used by consumers; unverified candidates never appear in player
  state output.
- Verified entity links are one-to-one within provider/type/season rules.
- Verified match links satisfy verified teams, kickoff tolerance, score agreement, and single
  candidate rules.
- FPL and Understat sync runs/publications are independent; one provider failure cannot mutate the
  other provider's facts or active revision.

## Cache and failure tests

| Scenario | Expected result |
| --- | --- |
| Core staging write fails before manifest swap | prior revision stays active; staging expires in 15 min |
| Process dies immediately after manifest swap | new complete revision active; old expires within 24 h |
| Live revision references missing key/type | reader rejects whole revision and uses coherent DB fallback |
| Queue Redis unavailable | jobs fail/retry without corrupting cache publication |
| Cache Redis unavailable | DB path remains correct; no BullMQ impact |
| Wrong key type | bounded error and scoped repair; no namespace-wide deletion |
| GraphQL cache stale after Data revision | key changes because dataset revision changes |
| Understat query has valid no-result | 60-second negative result, not a persistent sentinel |
| Redis cleanup | only allowlisted v2 prefixes removed via `SCAN`/`UNLINK` |

## Performance budgets

Measurements use the restored B0 dataset, PostgreSQL 15, production-like indexes, warmed and cold
runs, and at least 30 measured iterations after warm-up unless the operation is a full refresh.

| Operation | Budget |
| --- | ---: |
| Tournament selection MV refresh, 500 x 38 x 15 | <=30 s |
| Tournament selection DB read p95 | <=100 ms |
| Tournament selection warm cache p95 | <=20 ms |
| Player season summary DB p95 | <=150 ms |
| Understat player state cold p95 | <=500 ms |
| Understat player state warm p95 | <=50 ms |
| Full FPL core Redis publication | <=5 min |
| Post-v3 DB size growth | <=20% unless accepted explanation |
| Redis memory reduction after Understat cache removal | >=100 MB unless measured baseline proves cache was smaller |

Every benchmark stores query text/hash, `EXPLAIN (ANALYZE, BUFFERS)`, row counts, index usage,
hardware/container limits, cold/warm state, p50/p95/max, and timestamp.

## Security and ownership tests

- `anon`, `authenticated`, and `PUBLIC` cannot access Data schemas.
- GraphQL role can use required schemas and select required objects only.
- GraphQL role cannot create schemas/tables/functions or write Data/competition rows.
- Data role cannot mutate `bauth` or Supabase system schemas.
- Web role cannot mutate Data schemas.
- Reporting views are `security_invoker`; public MVs/RPCs do not exist.
- No new `SECURITY DEFINER` function exists unless explicitly documented, private, search-path
  hardened, execute-revoked from `PUBLIC`, and advisor-clean.
- All foreign-key columns have supporting indexes and no redundant duplicate indexes remain.
