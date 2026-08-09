# P3 Data Runtime and Cache Acceptance

Plan version: 3.2.3

Status: **ACCEPTED**

Post-acceptance contract correction: `0090_z_finalize_v3_graphql_reader_contract.sql` grants the
read-only GraphQL role schema usage required to consume its existing
`ops.dataset_publications` SELECT grant. The same migration updates existing v3 publication
manifests to plan version 3.2.2. No write privilege is added. Substantive correction commit:
`175ac00`. The subsequent 3.2.3 contract absorbs the new GraphQL-mainline public-league catalog
into `competition.public_league_trends`; GraphQL remains read-only and publication manifests are
stamped 3.2.3.

Substantive D2 commit: `51201b40ec3187ad38a18171a7267836326a6fec`

Accepted scope: Data runtime ownership, schema-qualified repositories, explicit season authority,
runtime database constraints, reporting reads, immutable Redis publication, queue/cache isolation,
and bounded legacy-cache cleanup. This acceptance does not authorize production activation or
legacy deletion.

## Safety boundary

- Worktree: `/Users/tong/CursorProjects/letletme_data-data-platform-v3-runtime`
- Branch: `codex/data-platform-v3-runtime`
- Accepted predecessor: `e81696dddda7ff51b1c735e8e0d612cc5294ade7`
- The user-owned `codex/understat-pipeline` checkout was not used as a base and was not modified.
  Its provider ingestion implementation remains a separate integration input before rehearsal.
- All mutation tests used disposable local PG15 databases and Redis DB 9/10 in dedicated
  containers. No production PostgreSQL, Redis, deployment, role, or application mutation occurred.
- No dual-write, shadow-read, or v2 fallback path was introduced.
- Production activation and legacy deletion still require their separate exact approval phrases.

## Runtime contract implemented

### Database and season authority

- `src/db/schemas/platform-v3.schema.ts` is the one runtime declaration for the six private v3
  schemas. Physical business tables are plural and schema-qualified.
- Repositories read and write unified multi-season tables with an explicit `FplSeasonRef`; no
  runtime table suffix or history-parent routing remains.
- `fpl.seasons.is_current` is the sole current-season authority. Wall-clock time and Redis do not
  select a season.
- Runtime inserts now have database-generated source identities where the migrated source ID was
  previously mandatory. Business UPSERT keys are enforced in PostgreSQL, including null-equal
  transfer/publication keys.
- Data read/write APIs reject non-positive or fractional entry, event, tournament, and admin IDs
  before repository or queue access.
- FPL live persistence owns all three normalized fact grains in one transaction: gameweek stats,
  scoring items, and per-fixture player evidence. Fixture evidence requires canonical event,
  fixture, player, and participant-team identities; unresolved incoming evidence aborts the whole
  transaction instead of being logged and omitted.

### Reporting ownership

- `reporting.player_season_summaries` is a season/player view over canonical gameweek facts; it has
  no `event_id` or `team_id` output.
- `reporting.tournament_selection_stats` and
  `reporting.tournament_entry_event_summaries` are materialized reporting objects refreshed only
  after complete source checkpoints. No physical summary/stat table is written by the runtime.
- Selection denominators include only managers eligible for that event, require 15 valid picks,
  one captain, one vice-captain, and a complete transfer checkpoint, and guard all division by
  zero.
- The migrated catalog contains 46 physical v3 tables, 3 reporting views, 2 reporting MVs, and 19
  v3-owned sequences across `fpl`, `competition`, `understat`, `bridge`, `ops`, and `reporting`.

### Operations and Redis

- `ops.sync_runs`, `ops.sync_items`, `ops.dataset_publications`, and `ops.season_imports` own
  durable run, item, publication, and historical-import state. Run identity and terminal
  transitions are idempotent; stale item attempts cannot overwrite newer evidence.
- Core/live Redis data uses immutable `llm:v3:data:*` revisions. A complete staged revision is
  validated before one atomic active-manifest swap; active items are persistent and staged/retired
  items have bounded TTLs.
- Queue and cache connections have independent configuration and runtime clients. Identical
  endpoints fail configuration validation.
- Data publishes no Understat cache, `EventLiveSummary:*`, or `PlayerValue:*` keys. Understat facts
  remain PostgreSQL-only and provider-isolated.
- Legacy cleanup is dry-run by default and uses exact allowlists with `SCAN` plus `UNLINK`; it has
  no `KEYS`, `FLUSHDB`, or `FLUSHALL` path.

## Runtime migration additions

| Migration | Responsibility | SHA-256 |
| --- | --- | --- |
| `0090_activate_v3_and_freeze_v2.sql` | PG15-safe frozen-owner release and membership postcondition | `a339a20979f542e7b8dbf6a9d619c2bc590e1ebfe11c40829f45e97e6fa4ee72` |
| `0090_prepare_v3_runtime_contract.sql` | Runtime identities, sequences, and database business keys | `5b02d5a424ded54432719e26b7939d63965b3f9257142fb579f3d4c110defc6d` |
| `0090_revise_v3_reporting_runtime.sql` | Eligible-entry selection denominator and complete-scope MV | `2a138c8ef52e526403f0b8458c381ccbfc5b8bf2bb2841fca4f2ecee7f2383f7` |

Fresh and exact-B0 PG15 migration replays both completed, repeated as no-ops with a clean ledger,
and passed the v3 activation validation. The B0 logical restore used a disposable, non-superuser
runtime login inheriting only `letletme_data_owner` for application integration tests.

## Schema declaration parity

CI now exports the Drizzle declaration into a second empty PG15 database and compares it with the
migration-built catalog. The comparison covers relations, columns/types/defaults/identity,
enums, sequences, normalized view/MV definitions, constraints, and non-constraint indexes across
all six v3 schemas.

The declaration and migration catalogs have zero unexplained differences. Three PostgreSQL
details remain deliberately SQL-owned and are asserted explicitly:

1. seven indexes attached to the two reporting MVs, because Drizzle 0.43 does not declare MV
   indexes;
2. `NULLS NOT DISTINCT` on the partial one-active-publication index, which Drizzle 0.43 cannot
   express for a partial unique index;
3. the stable `sync_runs_publication_fk` name on one edge of the circular
   `sync_runs`/`dataset_publications` relationship; Drizzle can express the lazy FK semantics but
   not its custom name without creating a TypeScript declaration cycle.

During parity work, 287 incorrect explicit operator-class annotations, schema-prefixed identity
sequence names, and several composite tournament key-order drifts were found in the generated
TypeScript declaration and corrected to match the accepted migration catalog. The migrated
database itself already used PostgreSQL's correct default operator classes.

## Acceptance results

Host runtime: Bun 1.2.12. Repository and CI package manager remains pinned to Bun 1.3.3.

| Gate | Result |
| --- | --- |
| Unit tests | 664 passed, 0 failed; 3,276 assertions across 76 files |
| B0 integration | 31 passed, 0 failed; 192 assertions across 11 files |
| Fresh integration | 29 passed, 2 intentional B0 skips, 0 failed; 166 assertions |
| Drizzle catalog parity | Passed; 13 top-level assertions over all six schemas |
| TypeScript | `tsc --noEmit` passed |
| ESLint | 0 errors, 0 warnings |
| Build | API and worker bundles succeeded |
| Drizzle check/export | Check passed; export applied cleanly to empty PG15 |
| Git whitespace | `git diff --check` passed |

The B0 repository acceptance read season 2526 as 38 events, 20 teams, 380 fixtures, 841 players,
and 841 player-season summary rows. Full 2526 core DB read plus immutable Redis publication took
52.73 ms against the local restored B0 dataset, far below the five-minute P3 budget.

The expanded PG15 persistence contract writes every one of the 26 active FPL/competition physical
table families, repeats idempotent writes, verifies derived reporting output, injects core/live
foreign-key failures, and confirms exact cleanup. The retirement disposition for all 62 deleted v2
test files is recorded in `12-p3-test-retirement-audit.md`; the B0-sized tournament setup benchmark
remains an explicit P5 gate rather than an inferred P3 pass.

## Defects caught and closed in P3

- A stale `ops.sync_items` attempt could overwrite newer payload evidence; the repository now
  updates attempt-owned fields only when the incoming attempt is current.
- PostgreSQL reports superusers as members of every role through `pg_has_role`; the v2-frozen-owner
  handoff now distinguishes actual membership grants and passes on plain PG15 and Supabase PG15.
- Several API path/body IDs accepted zero or fractions; all relevant boundaries now require
  positive integers.
- Current documentation still described v2 table/cache/route behavior; operational docs now state
  the v3 season, schema, publication, queue, and readiness contracts.
- The first schema-parity test draft omitted `bridge`; the final test covers all six v3 schemas.
- The initial runtime rewrite retained `fpl.player_fixture_stats` in the schema but dropped its
  transformer, repository, and live-service writer. The fixture-grain path is restored with
  explicit season scope, deterministic source hashes, canonical identity checks, and transaction
  rollback on unresolved incoming evidence.
- `events` UPSERT conflict predicates used TypeScript property names as literal SQL qualifiers;
  they now interpolate schema-qualified Drizzle columns.
- Rich entry-result freshness SQL attempted to bind a JavaScript `Date` inside a raw expression;
  it now binds an explicit ISO `timestamptz` value.
- The entry-season advisory-lock key cast a 64-bit hash to `integer` and could overflow; it now uses
  PostgreSQL `hashint8` to produce an `int4` lock key safely.
- Deleting 62 v2-bound tests initially removed real write-path coverage together with obsolete
  cache behavior. Every deletion is now audited, and actual PG15 writes cover all active
  FPL/competition table families.

## Deferred gates

- GraphQL direct PostgreSQL readers, read-only startup contract, query-cache revisioning, and Web
  maintenance/contract work are P4 and are not implied by this acceptance.
- The separate Understat ingestion branch must converge on the accepted provider schema and ops
  contract before P5; Data continues to have no Understat Redis cache.
- P5 still requires two full rehearsals, performance evidence, rollback drills, and exact candidate
  image/commit manifests.
- Production activation still requires
  `APPROVE_V3_ACTIVATION <CUTOVER_RUN_ID>`.
- Production legacy deletion still requires B1 backup/restore evidence and
  `APPROVE_V3_LEGACY_DROP <CUTOVER_RUN_ID>`.
