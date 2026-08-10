# P5 Rehearsal Run 1 - Clean B0 Consolidated Evidence

Date: 2026-08-09

Run ID: `v3-20260808T160008Z-b9eddc0`

Status: data-quality and representative application behavior accepted. The fresh-cluster follow-up
found that the Data application LOGIN in this run inherited `letletme_data_owner` instead of the
least-privilege `letletme_data_writer`; P5-08 and P5-09 are therefore reopened until every journey
is repeated with the writer LOGIN. This run originally left the Redis, post-cleanup B1, and
database-size gates open; those were subsequently accepted in
`20-p5-redis-cutover-rehearsal.md` and `21-p5-postcleanup-b1-restore.md`. P5-01, P5-05, P5-08,
P5-09, and P5-10 remain open.

## Frozen candidates

| Component | Branch | Candidate SHA |
| --- | --- | --- |
| Data | `codex/data-platform-v3-cleanup` | `95cc8021b52ef23e1826c794553f166efd6f6b21` |
| GraphQL | `codex/data-platform-v3-player-state` | `3b426383a13ddc4b2d1d22452216bfe77826e420` |
| Web | `codex/data-platform-v3-auth-role` | `6c885629a48c97e9050d192ff7f7959ae4627753` |

The original dirty Data and Web worktrees were not modified. All PostgreSQL and Redis mutations
described below were limited to disposable local rehearsal databases and containers.

## Clean database replay

`p5_rehearsal_1_clean` was cloned from the accepted full B0 restore on PostgreSQL 15.8. Before
migration, ownership was normalized for 220 relations, six functions, and 20 enums. The exact
candidate migrations were then applied once without deleting or rewriting a migration-ledger row.

| Migration | Duration |
| --- | ---: |
| `0079` | 81.81 ms |
| `0080` | 65.40 ms |
| `0081` | 66.28 ms |
| `0082` | 129.90 ms |
| `0083` | 98.05 ms |
| `0084` | 33.32 ms |
| `0085` | 13,867.75 ms |
| `0086` | 15.54 ms |
| `0087` | 1,853.92 ms |
| `0088` | 813.68 ms |
| `0089` | 30.98 ms |
| `0090` activation | 95.34 ms |
| `0090` runtime | 92.63 ms |
| `0090` reporting | 27.15 ms |
| `0090_z` | 2.86 ms |
| `0090_zz` | 23.91 ms |
| `0090_zzz` | 6.40 ms |
| Total Data migration time | 17,304.92 ms |

The committed Web `0008_web_auth_runtime_role.sql` migration applied once and was a no-op on its
second invocation. The second Data migration invocation was also status-clean and a no-op.

The activation validator passed with 192 frozen relations/fences and exactly one active
publication. The publication is revision 1 for season 2627, plan 3.2.4, with RFC UUID
`1f08ab2f-732b-449f-868c-4a2038c5f1ba`.

## Data-quality gate

`sql/v3/validate-p5-quality.sql` completed with
`status=p5_quality_validation_passed`. Its consolidated result included:

| Check | Result |
| --- | ---: |
| Current season | 2627 |
| Teams across preserved seasons | 220 |
| Events | 418 |
| Players | 7,931 |
| Fixtures | 4,180 |
| Player season summaries | 7,931 |
| Understat matches | 4,560 |
| Understat player-match facts | 129,576 |
| Verified FPL/Understat links | 1,909 |
| Completed Understat seasons | 1617 through 2526 |
| Critical/high validator assertions | 51 passed, 0 failed |

The current 2627 immutable core publication contains 38 events, 20 teams, 573 players, 11 phases,
and 380 fixtures. `currentEvent` is correctly null before GW1 rather than being inferred from the
wall clock.

Two independent hash comparisons passed:

- all 197 frozen `public` business relations, excluding both migration ledgers: zero differences
  from accepted B0; and
- all 45 v3 business relations: zero differences from the prior deterministic accepted replay.

The canonical `p5_rehearsal_1_clean` database was not changed after these checks. Integration and
journey fixtures were loaded only into separate clones.

## Reporting and query evidence

The Data integration suite passed 27 tests. The production-shaped tournament benchmark loaded
500 entries x 38 events x 15 picks, or 285,000 picks, and produced:

| Operation | Observed | Budget | Result |
| --- | ---: | ---: | --- |
| Selection MV refresh | 304.8 ms | 30 s | pass |
| Selection DB read p50 / p95 / max | 0.194 / 0.410 / 0.643 ms | p95 100 ms | pass |
| Player summary p50 / p95 / max | 0.180 / 0.237 / 0.423 ms | p95 150 ms | pass |

Measured GraphQL HTTP paths used the actual read-only login and signed ingress contract:

| Operation | Observed | Budget | Result |
| --- | ---: | ---: | --- |
| Tournament selection cold | 16.881 ms | 100 ms | pass |
| Tournament selection warm p50 / p95 / max | 2.755 / 4.905 / 8.143 ms | p95 20 ms | pass |
| Player state cold | 56.810 ms | 500 ms | pass |
| Player state warm p50 / p95 / max | 1.424 / 2.423 / 3.568 ms | p95 50 ms | pass |

Thirty independent signed subjects were used for warm measurements so the security rate limiter
remained enabled without measuring deliberate `429` responses as cache latency. Oversized
multi-root probes were rejected with `QUERY_TOO_COMPLEX`, proving both the 200-node and five-root
limits before the request set was split into the same bounded operations used by Web.

Database plans used `player_gameweek_stats_player_idx` for player summaries. The measured FPL
history path completed in 33.780 ms, and the verified-bridge Understat cohort path completed in
8.033 ms using `understat_player_seasons_player_idx`.

This run alone did not close P5-07. The activated pre-cleanup database is 824,103,727 bytes versus
B0 at 426,849,071 bytes because v2 and v3 coexist before `0091`-`0093`. The subsequent cleanup
rehearsal measured 391,545,347 bytes, while the representative Redis rehearsal removed
177,093,288 bytes; `21-p5-postcleanup-b1-restore.md` therefore closes the combined budget gate.

## Cross-service security gate

The three runtime logins each inherit exactly one capability role:

| Login | Sole inherited capability |
| --- | --- |
| `p5_data_run1` | `letletme_data_owner` |
| `p5_graphql_run1` | `letletme_graphql_reader` |
| `p5_web_run1` | `letletme_web_auth` |

All logins are non-superuser, cannot create roles or databases, and cannot bypass RLS. All three
capability roles are `NOLOGIN NOINHERIT`.

The consolidated live privilege probe returned:

| Principal | Required access | Forbidden access |
| --- | --- | --- |
| `PUBLIC`, `anon`, `authenticated` | none | no usage on `fpl`, `competition`, `understat`, `reporting`, or `ops` |
| GraphQL | FPL schema usage and `SELECT` | no FPL DML, Auth read, or reporting schema creation |
| Web | exact Better Auth user-table CRUD | no Data read, API-key/ledger read, or Auth schema creation |
| Data | FPL table CRUD | no Better Auth read or write |

The GraphQL startup contract passed using `p5_graphql_run1`. The Web runtime contract passed using
`p5_web_run1`, while an administrator connection exited with status 1. Data readiness passed using
`p5_data_run1`, but that LOGIN inherited the owner role and was over-privileged. This evidence does
not close P5-08; the fresh-cluster rerun must use `letletme_data_writer`.

## End-to-end journeys

Data candidate runtime results:

- `/health` and `/ready` passed with PostgreSQL, cache Redis, queue Redis, and active season true;
- unauthenticated `POST /events/sync` returned 401;
- current/next event, event-live, and tournament setup-status reads passed; and
- preseason live state remained an honest empty GW1 result.

GraphQL candidate runtime results:

- health, season, events, teams, players, fixtures, live fallback, market, player detail, and
  FPL-only player-state queries returned 200;
- public tournament catalog returned its legitimate empty B0 state; and
- a disposable two-entry tournament fixture returned total entries 2, position counts 2/5/5/3,
  15 player rows, 100% selection for both identical squads, captain total 2, and vice total 2.

The tournament fixture was loaded only in `p5_rehearsal_1_clean_e2e`. Its two entries were marked
synced through GW1 because the reporting MV deliberately excludes incomplete entry/event scopes.
This is a documented fixture precondition, not a candidate correction.

Web candidate runtime results:

- all 46 pages built against the exact GraphQL endpoint and service-token contract;
- public home, player stats, price changes, live matches, and tournament pages returned 200;
- unauthenticated protected selections creation redirected to login;
- a synthetic Better Auth user signed in, resolved an entry-verified session, read protected
  tournament/selections data, signed out, and then resolved an unauthenticated session;
- the protected tournament list and live tournament pages rendered the synthetic tournament; and
- no external email, OAuth provider, or production identity was invoked.

The exact Web candidate was then restarted with `MAINTENANCE_MODE=true`:

| Probe | Result |
| --- | --- |
| English data page | 503, English document, `data-maintenance-page=true` |
| Simplified Chinese data page | 503, Chinese document, `data-maintenance-page=true` |
| `/api/graphql` | 503 with `MAINTENANCE_MODE` |
| Better Auth session endpoint | 200 and remained available |
| Cache policy | `private, no-store, no-transform` and `Retry-After: 300` |

These journeys establish functional behavior, but do not close P5-09 after the Data runtime-role
finding. The complete journey set must be repeated with the dedicated writer LOGIN.

## Redis state observed in this partial run

The isolated E2E cache contained one coherent v3 publication and query/security keys only:

| Namespace | Keys | `MEMORY USAGE` sum | TTL contract |
| --- | ---: | ---: | --- |
| `llm:v3:data:*` | 7 | 283,584 bytes | all immutable, TTL `-1` |
| `llm:v3:gql:*` | 81 | 67,416 bytes | 73 short-lived rate keys; 8 query-cache keys |

No `Understat*`, `PlayerState*`, `PlayerValue*`, or `EventLiveSummary*` legacy key existed in this
new cache. This proves the candidate does not recreate retired keys, but it does not prove the
memory-reduction gate because representative B0 Redis state has not yet been restored.

## Documented probe notes and remaining work

No SQL correction or migration-ledger edit was made to the clean canonical replay. The following
operator-level retries are retained here so P5-01 is not incorrectly called intervention-free:

- a deliberately oversized GraphQL smoke query hit the expected complexity limits and was split
  into the bounded production operations;
- early sign-out probes omitted required browser headers/body and returned 415 then 403 before the
  browser-format request returned 200; and
- the first maintenance-mode password-rotation probe used unsupported psql variable syntax, made
  no role change, and failed startup authentication; the documented hex-password command then
  succeeded.

During a long-running Data process, Bun emitted one `TimeoutNegativeWarning` from the
`postgres@3.4.5` reconnect timer. PostgreSQL and both Redis instances remained healthy, Data
readiness stayed fully green, and no request failed. It is tracked as a non-data-corrupting runtime
warning and must be rechecked in rehearsal run 2; it is not hidden as a clean-log result.

Remaining blockers are:

1. run the exact complete sequence in maintenance mode without the probe retries above;
2. repeat the full rehearsal with identical target hashes and accepted timing/size budgets; and
3. integrate the separately owned Understat branch before freezing P5-10 candidates.
