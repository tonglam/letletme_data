# P3 Understat/Mainline Integration Acceptance

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Plan version: 3.2.5

Status: **accepted for final candidate freeze and clean rehearsals**

## Result

The separately developed Understat pipeline is reconciled with Data Platform v3 without restoring
a second source of truth. PostgreSQL remains the sole durable business authority. Understat facts
use only `understat`, provider links use only `bridge`, and run/staging evidence uses only `ops`.
There is no Understat Data cache, Redis read model, cache publication, or routine cron schedule.

Redis is used only for BullMQ and bounded coordination on `QUEUE_REDIS_*`. The provider-wide
request permit is the leased key
`llm:v3:queue:coordination:understat-request-permits`. The low-frequency status and mapping reads
go directly to PostgreSQL; a future GraphQL consumer may add only a bounded query cache.

## Candidate lineage and isolation

- v3 integration base: Data `4574bc72f68e3cbd1afc33956bf4d28977e171e6`;
- merged Data mainline/Understat PR #52 commit:
  `6aee880cfdfc30dd6bd2b2702dba8a6ec740fb87`;
- integration worktree: `/Users/tong/CursorProjects/letletme_data-data-platform-v3-understat-integration`;
- integration branch: `codex/data-platform-v3-understat-integration`; and
- final committed Data SHA and tree digest are written to external
  `p5/rehearsal-6/manifests/run6-candidate-manifest.json` after this evidence commit, avoiding a
  self-referential repository manifest.

The original `/Users/tong/CursorProjects/letletme_data` worktree remains untouched on
`codex/understat-pipeline`; its pre-existing local `.gitignore` change is not copied or altered.

## Accepted runtime design

1. Discovery and detail jobs fetch and normalize provider responses, bind each envelope to its
   resource identity and source hash, and stage the normalized evidence in
   `ops.sync_items.normalized_payload`.
2. Team and Player finalizers revalidate every envelope and apply a complete snapshot inside one
   PostgreSQL transaction. A cardinality, participant, roster, or post-write hash failure rolls
   back every fact and records a skipped run rather than replacing a valid snapshot.
3. Team and Player lanes have independent tables, queues, workers, run identities, completeness
   checks, and provider links. Cross-provider analysis is allowed only through verified `bridge`
   links.
4. Run identity includes provider, lane, scope, season, null season/event IDs, mode, and trigger.
   Reusing a run ID with any different identity fails.
5. Completed, skipped, failed, and historical published runs are terminal. Delayed jobs cannot
   reopen a terminal run, overwrite settled evidence, append new items, or replace terminal
   metadata/error state.
6. Team sync accepts only team IDs. Player sync separately accepts team and match IDs, so an
   unsupported field cannot be silently ignored.
7. The Team and Player BullMQ clients are lazy. With `UNDERSTAT_ENABLED=false`, importing the API
   and worker modules opens no Understat queue connection; an explicit accepted sync or enabled
   worker initializes the queues on `QUEUE_REDIS_*`.
8. No raw-response archive was introduced here. `normalized_payload` is reproducible staging
   evidence inside the one PostgreSQL authority, not a byte-for-byte HTTP archive. Immutable raw
   capture remains owned by the separate Understat raw-pipeline task.

## Migration acceptance

Migration `0090_zzzz_integrate_understat_runtime.sql` has SHA-256
`7074c1849e01ec24b5a8c00344701d73cb66a10cee7444a3ab5ccc4258c62638` and makes three bounded
corrections:

- `bridge_entity_links_pair_unique` is `UNIQUE NULLS NOT DISTINCT`, making the provider pair the
  idempotent identity even when optional season bounds are null; and
- `understat.player_team_seasons` references `understat.seasons` and `understat.teams`
  independently instead of requiring a Team-lane season row; and
- the five dependency-free provider-local sync enums are removed because `ops.sync_runs` and
  `ops.sync_items` are the sole sync-control contract. No `CASCADE` is used.

Fresh PostgreSQL 15.8 acceptance:

- target: `v3_understat_integration_r1`, cloned from accepted `p2_fresh_325_final`;
- first migration apply: 22.78 ms;
- second migration run: no-op/status clean;
- all three new constraints exist and are validated; and
- Drizzle export `schema_export_understat_r1` matches the migrated catalog.

Restored-B0 PostgreSQL 15.8 acceptance:

- target: `p5_understat_b0_r1`, cloned from pristine `b0_full_run6`;
- the committed ownership normalizer passed before activation;
- all 18 migrations from `0079` through `0090_zzzz` applied once in 18.35 seconds;
- `0090_zzzz` applied in 18.84 ms;
- the second complete run skipped all 18 migrations and remained status clean;
- provider-pair duplicates are zero and all three corrected constraints are validated; and
- `0091`, `0092`, and `0093` have zero ledger rows and were not executed.

## Data, role, and quality evidence

The read-only P5 quality transaction passed all 51 migration checks on the B0 replay:

| Scope | Accepted result |
| --- | --- |
| Completed FPL seasons | `1617` through `2526` |
| Current season | one `2627` preseason row |
| FPL totals | 220 teams; 418 events; 4,180 fixtures; 7,931 players; 7,931 player summaries |
| Understat totals | 4,560 matches; 129,576 player-match rows; 1,909 provider entity links |
| 2025/26 repository read | 38 events; 20 teams; 841 players; 11 phases; 380 fixtures |

The local Data runtime login inherits exactly `letletme_data_writer`; the explicit runtime-role
contract passed. The same writer ran the B0 integration and HTTP smoke. It cannot read ordinary
reporting views. Reporting benchmarks therefore use the migration/refresh owner, matching the
existing operational contract rather than broadening Data runtime grants.

## Test and performance gates

| Gate | Result |
| --- | --- |
| Focused Understat PostgreSQL integration on B0 writer | 13 pass, 0 fail, 71 assertions |
| Full fresh PostgreSQL integration | 42 pass, 6 explicit out-of-scope gated skips, 0 fail, 196 assertions |
| Full B0 PostgreSQL integration with B0 gates enabled | 44 pass, 4 explicit harness skips, 0 fail, 220 assertions |
| Fresh schema parity and complete persistence gates | 2 pass, 0 fail, 50 assertions |
| Unit suite | 729 pass, 0 fail, 3,490 assertions |
| Static/build gates | ESLint, TypeScript, Prettier, `git diff --check`, and Bun production build pass |
| Full 2025/26 core Redis publication | 20.46 ms; exact 38/20/841/11/380 payload |
| Reporting MV refresh | 437.19 ms over 285,000 source rows |
| Reporting cold-read p95 | selections 0.338 ms; player summary 0.493 ms |

The fresh suite's six skips and the B0 suite's four skips are deliberate specialized harnesses.
B0 history and core publication are enabled and pass in the B0 suite; schema-export parity and
destructive core persistence pass in their dedicated fresh harness. The two reporting benchmarks
had already passed with the correct owner harness.

## Runtime HTTP smoke

The production Bun build started on an isolated clone `p3_understat_http_r1`; no provider or sync
mutation endpoint was called.

- `GET /ready`: PostgreSQL, cache Redis, queue Redis, and active-season checks all true;
- `GET /understat/status/2526`: `storage=postgresql`, `dataCache=disabled`, 20 teams, 380 matches,
  760 team-match rows, 738 team splits, 537 players, 551 team memberships, and 11,490
  player-match rows; and
- `GET /understat/mappings/2526`: 537 season-applicable entity links, all `auto_verified`, and
  zero match links.

Historical converted run rows may retain the status `published` and a
`legacy_cache_revision` metadata field as audit history. The live endpoint independently reports
`dataCache=disabled`; new Understat runs end as PostgreSQL `completed` or `skipped` runs and do not
publish a Data cache.

## Residual and ownership audit

- runtime cache/publication search for Understat returned zero matches;
- the only direct Redis import in the Understat path is the request-permit utility, and it resolves
  `QUEUE_REDIS_*`;
- disabled Understat imports instantiate neither BullMQ queue; a unit source-contract gate keeps
  both queue getters after the worker feature-flag exit;
- no Understat cron or schedule is registered; historical trigger values remain ordinary
  constrained `ops.sync_runs.trigger` text and no provider-local sync enum survives;
- no legacy FPL archive API, service, repository, domain, or test returned during the merge;
- `src/db/schemas/` contains only `index.schema.ts`, `platform-v3.schema.ts`, and
  `platform-v3.types.ts`;
- `git ls-files -u` and the unmerged-path scan are empty; and
- anchored merge-marker scans and `git diff --check HEAD` are clean.

## Destructive boundary and decision

All PostgreSQL and Redis writes in this acceptance used disposable local resources. Production was
read-only throughout and was not activated, cleaned, or altered. No legacy cleanup migration ran.

P2-24 and P3-16 through P3-18 are accepted. The next permitted work is to commit and freeze this
candidate, then execute clean Runs 7 and 8 from new resources with identical SHAs, digests, and
runbook. Production activation remains blocked until both clean rehearsals pass and the user sends
the exact activation approval phrase for this run ID.
