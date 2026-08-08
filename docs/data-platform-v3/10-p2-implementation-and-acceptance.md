# P2 Schema and Migration Implementation Acceptance

Plan version: 3.1.1

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: **ACCEPTED**

Accepted scope: Data D1 schema, deterministic conversion, activation/freeze boundary, and
approval-gated cleanup migrations. This acceptance does not authorize production activation or
legacy deletion.

## Safety boundary

- Worktree: `/Users/tong/CursorProjects/letletme_data-data-platform-v3-schema`
- Branch: `codex/data-platform-v3-schema`
- Accepted predecessor: `6f66095b162160c1c0b55076b6960f92d7754881`
- The user-owned `codex/understat-pipeline` worktree was not read as a branch base and was not
  modified.
- Production access during P2 was read-only inventory and advisor access. No production DDL, DML,
  role, Redis, deployment, or application mutation occurred.
- `0091` through `0093` remain excluded unless
  `V3_LEGACY_DROP_APPROVAL="APPROVE_V3_LEGACY_DROP <CUTOVER_RUN_ID>"` exactly matches an activated
  migration run. Production has not supplied this approval.

## Implemented migration set

| Migration | Responsibility | SHA-256 |
| --- | --- | --- |
| `0079_create_v3_ops_and_roles.sql` | PG15 guard, private schemas, roles, ops foundation, fresh-source convergence | `fe336d1ccef1eccac0bbd744291a44a3ff5c413e7a03a8ed5eb97b695e7dafc4` |
| `0080_create_v3_fpl_dimensions.sql` | Deterministic seasons, teams, events, players, phases | `744a9ed80392516235fb805085cbe03a063605d0a29c63a52654dc64d4ce17ff` |
| `0081_create_v3_fpl_facts.sql` | Fixtures, event/GW/fixture facts, market snapshots | `5d569a2eaeaad4aa5318b1b6990de7ffe3ca0c26a968a024894ab965d06aba21` |
| `0082_create_v3_competition.sql` | Entry, league, and tournament facts | `c90eff8bb944d8b83de5143625abaa03b9225144e4ff594688222ed823817db0` |
| `0083_create_v3_understat_bridge.sql` | Provider-isolated Understat and verified bridge facts | `70523cf603e9239ba3de46d94007d489c9b98c149da6d9c8463a48ed17908279` |
| `0084_create_v3_reporting.sql` | Three views, two MVs, locked refresh functions | `3d0847f5846cef1c5e919de4d2592774054932ca2cea19779a93b2c71f578882` |
| `0085_migrate_v3_fpl_data.sql` | All-season FPL conversion and value reconstruction | `4cc7459d3c74f5a7c9bc32a5fe35bfecccef0b627d631b6b3e01e370b22a031c` |
| `0086_migrate_v3_competition_data.sql` | Competition conversion | `219d98bb1ee4a27b7c70503b29f24ce50ee86fd9f050d5344136f04b9bd2e932` |
| `0087_migrate_v3_understat_ops_data.sql` | Understat, bridge, import, and audit conversion | `25681423515b2033ee5835dbe6e8129f9cc7d1d90d656e720532a3316b9204e6` |
| `0088_validate_v3_constraints.sql` | FK creation/indexing, validation, data/security gates | `2a1f9666f4bd71d47aaa85b6605f5a84770cc91fa8813a1194f901cc0b644bdf` |
| `0089_prepare_v3_publications.sql` | First MV population and inactive publication | `8d3989edb3254ce86f29b668c7fb182f007559bce714d198105587e37d1c4069` |
| `0090_activate_v3_and_freeze_v2.sql` | Active publication, exact v2 quarantine ownership and write fences | `da8c7a9537f83cbb45423b1f03d8efa77b2492cfd67656a631713487f9d13e91` |
| `0091_drop_v2_reporting_and_rpcs.sql` | Approval-gated legacy read/function deletion | `164d893e99c819cf6dcbb5fa33b5527cbcb6d47e8925dcafcc8ad63f2750fe6a` |
| `0092_drop_v2_tables_partitions_triggers.sql` | Approval-gated exact physical-object deletion | `2f458b2bdb0e397fef490f8188c924ed130e36b0afdb9a3c4891738355af9cfd` |
| `0093_finalize_v3_migration_ownership.sql` | Approval-gated ledger cleanup and empty quarantine-role proof | `6224cac1c766b0c83948993274465c096c5b5932e27c159cdb10699143dcd517` |

The migration runner now keeps the public ledger authoritative until the `0090` compatibility-view
boundary, then uses `ops.schema_migrations`. It re-probes after each file, verifies every applied
checksum, fails on a missing applied file, applies declared lock/statement timeouts in a prior
protocol round trip, and omits cleanup migrations unless the exact approval gate is present.

## Replay matrix

Evidence root:
`/Users/tong/Documents/LetLetMe Backups/v3-cutover/v3-20260808T160008Z-b9eddc0/p2`

| Case | Result | Durable evidence |
| --- | --- | --- |
| Fresh PG15 bootstrap | First run passed; second run no-op; status clean; `sourceProfile=fresh_empty`; 48/48 audit rows passed; zero domain business facts outside seeded seasons/control rows | `logs/p2-fresh-final-4-*` |
| Exact B0 upgrade | First run passed; second run no-op; status clean; `sourceProfile=b0_nonempty`; 51/51 audit rows passed | `logs/p2-b0-final-5-*` |
| B0 source immutability | 197 legacy business-relation hashes unchanged; all 22 sequence states unchanged | `manifests/p2-b0-final-5-pre-vs-post-business-relations.diff`; `manifests/p2-b0-final-5-public-sequences.diff` (both 0 bytes) |
| Deterministic target | 44 v3 relation hashes equal the preceding accepted replay | `manifests/p2-b0-final-5-vs-final-4-v3-business-hashes.diff` (0 bytes) |
| Interrupted `0085` | Injected end-of-file failure rolled back the migration and ledger row; immediate retry through `0090` passed with identical target hashes | `logs/p2-interrupted-v2-*`; `manifests/p2-interrupted-v2-resume-v3-business-hashes.diff` (0 bytes) |
| Wrong PostgreSQL major | PG16 stopped in `0079` before v3 DDL with SQLSTATE `0A000` | `logs/p2-pg16-major-guard.log` |
| Checksum mismatch | Altered ledger checksum stopped before new migration work | `logs/p2-ledger-checksum-mismatch.log` |
| Missing applied file | Missing ledgered `0080` stopped before cleanup or new migration work | `logs/p2-ledger-missing-applied-file.log` |
| Runner timeout | A 100 ms declared timeout cancelled `pg_sleep(1)` with SQLSTATE `57014`; transaction and ledger remained empty | `logs/p2-runner-statement-timeout.log` |
| Cleanup approval | Missing and malformed approval failed closed; exact local rehearsal removed only the allowlist and changed zero v3 hashes | `logs/p2-cleanup-final-4-*`; `manifests/p2-cleanup-final-4-v3-business-hashes.diff` (0 bytes) |

`sql/v3/validate-0090-activation.sql` passed on both accepted replay classes. On B0 it reported 192
frozen relations, 192 owner-level mutation fences, and exactly one active core publication.

## Data reconciliation

Representative B0 target counts:

| Relation | Rows |
| --- | ---: |
| `fpl.events` | 418 |
| `fpl.fixtures` | 4,180 |
| `fpl.players` | 7,931 |
| `fpl.player_gameweek_stats` | 245,146 |
| `fpl.player_gameweek_scoring_items` | 240,797 |
| `fpl.player_market_snapshots` | 248,560 |
| `competition.entries` | 2 |
| `competition.entry_season_histories` | 27 |
| `bridge.entity_links` | 1,909 |
| `understat.matches` | 4,560 |
| `understat.player_match_stats` | 129,576 |

The 28,266 historical `player_values` rows reconstruct bidirectionally from market snapshots with
zero difference. Of 573 current start rows, 9 reconstruct from their first capture and exactly 564
become provenance-marked `legacy_value_seed` snapshots. The resulting reporting view has zero
source/target difference. Completed-season gates enforce 20 teams, 38 events, 380 fixtures, and 38
fixtures per team.

## Schema, security, and reporting gates

The accepted B0 replay produced:

- 46 physical v3 tables, 3 ordinary reporting views, 2 populated reporting MVs, and 9 owned
  sequences;
- 125 foreign keys, with zero missing leading-column indexes;
- zero unvalidated check/FK constraints and zero duplicate-index pairs;
- all three ordinary views with `security_invoker=true`;
- both MVs populated and each backed by a valid full unique index;
- zero v3 functions executable by `PUBLIC`;
- zero v3 schemas reachable by `PUBLIC`, `anon`, or `authenticated`;
- zero write-capable v3 relations for `letletme_graphql_reader`;
- exactly one current season and one active current core publication;
- no membership from the migration login to `letletme_v2_frozen_owner`, and no `CREATE` privilege
  for that role in `public`.

Supabase CLI `db lint` against all six local v3 schemas returned `No schema errors found` at warning
level with fail-on-warning enabled.

## Supabase advisor review

The hosted advisors inspect the current production v2 database, because v3 has not been deployed.
They therefore provide a legacy/platform baseline, not a scan of local v3 objects.

| Advisor | Hosted baseline | Classification |
| --- | --- | --- |
| Security | 190 `rls_enabled_no_policy` INFO notices; one mutable-search-path WARN on the legacy mutation function; one RLS-disabled ERROR on `public.graphql_schema_migrations`; one PostgreSQL patch WARN | The table/function findings are frozen and later removed by the exact v2 cleanup path. The PostgreSQL patch warning is platform-owned and remains an explicit P6 preflight gate. |
| Performance | 286 unindexed-FK INFO notices; 29 unused-index INFO notices; one duplicate-index WARN on legacy `public.tournament_entries`; one auth connection INFO notice | The relation findings belong to v2 and disappear with exact cleanup. Local v3 independently has 0 unindexed FKs and 0 duplicate-index pairs. |

References: [unindexed foreign keys](https://supabase.com/docs/guides/database/database-linter?lint=0001_unindexed_foreign_keys),
[unused indexes](https://supabase.com/docs/guides/database/database-linter?lint=0005_unused_index),
[duplicate indexes](https://supabase.com/docs/guides/database/database-linter?lint=0009_duplicate_index),
[RLS enabled without policy](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy),
[mutable function search path](https://supabase.com/docs/guides/database/database-linter?lint=0011_function_search_path_mutable),
[RLS disabled in public](https://supabase.com/docs/guides/database/database-linter?lint=0013_rls_disabled_in_public),
and [PostgreSQL platform upgrades](https://supabase.com/docs/guides/platform/upgrading).

No hosted advisor finding is attributed to a v3 object. Production activation remains prohibited
until the outstanding PostgreSQL patch warning is resolved or explicitly accepted at the P6
preflight gate, followed by a fresh advisor run.

## Repository quality gate

The exact package-manager version was verified in the existing `oven/bun:1.3.3` image with the
workspace mounted read-only for tests/typecheck/build:

| Check | Result |
| --- | --- |
| Unit tests | 787 passed, 0 failed across 86 files |
| TypeScript | `tsc --noEmit` passed |
| Build | Both `src/index.ts` and `src/worker.ts` bundled successfully |
| ESLint | 0 errors; 7 pre-existing warnings outside the P2 implementation |
| Prettier | All changed TS, tests, JSON, Markdown files passed |
| Git whitespace | `git diff --check` passed |

The host Bun 1.2.12 run independently produced the same 787/0 result and successful typecheck,
lint, and build. The migration runner/gate unit coverage is included in that suite.

## Deferred gates

- Runtime schema/repository/cache conversion is P3 and is not implied by this schema acceptance.
- Application credentials must inherit the dedicated writer/reader group roles; the cluster-admin
  migration login is not a runtime credential.
- Production activation still requires the exact `APPROVE_V3_ACTIVATION <CUTOVER_RUN_ID>` phrase.
- Production legacy deletion still requires B1 backup/restore evidence and the separate exact
  `APPROVE_V3_LEGACY_DROP <CUTOVER_RUN_ID>` phrase.
- No P5/P6/P7/P8 gate is satisfied by this report.
