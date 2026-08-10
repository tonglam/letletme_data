# Non-live synchronization upgrade and evaluation standard

## Scope

This upgrade covers core season snapshots, entry profiles/history/picks/results/transfers, league
derivatives, tournament setup and weekly non-live finalization, fixture repair, queue retry behavior,
and bounded operational reporting.

The Live pipeline is deliberately excluded. No claim from this document applies to event-live
ingestion, live scores, live summaries/explains, live fixture/bonus calculations, or their queues.
Those components keep their separate implementation and evaluation track.

Destructive PostgreSQL season rollover is also excluded. Core snapshot gates start from a database
for the current season; replacing season-local player IDs while preserving referenced historical
rows remains the separately approved procedure in `docs/fpl-season-readiness.md`.

## Target workflow

1. A daily or manual core job reads bootstrap and fixtures once each.
2. The complete core payload is validated before mutation. PostgreSQL commits once; Redis stages and
   swaps the complete season view. A failed stage preserves the last published view.
3. Entry scans use an ID cursor. Entry snapshot and transfer checkpoints select only stale entries;
   entry/event rows select only missing picks and finalized rich results. Core-history writes preserve
   the separate picks/live-derived result checkpoint.
4. League coordinators fan out with a maximum concurrency of 10 and stable child IDs for one run.
   Each child uses stored tournament membership first and a bounded authoritative fallback only for
   legacy empty membership.
5. Tournament post-match work audits fresh results, picks, and transfer checkpoints before starting
   standings/insight derivatives. Partially persisted work remains a checkpoint for the retry.
6. Fixture event repairs use the existing snapshot-aware event publication path, then rebuild affected
   team hashes from the complete canonical fixture set. That set must contain 380 fixtures across
   scheduled database rows and the retained unscheduled cache; otherwise a core repair is queued and
   the attempt fails closed.
7. Every top-level non-live attempt emits one `data_sync_attempt`. A worker completion is successful
   only when `failedUnits=0`; raw URLs, payloads, names, and identities are never included.

## What is intentionally not added

- no workflow engine or per-row setup-task table;
- no new metrics database or dashboard;
- no unbounded child jobs or `Promise.all` fan-out;
- no user-facing ETA based on synthetic timings;
- no automatic enabling of official roster synchronization.

## Fixed-claim levels

Use the narrowest claim supported by evidence:

### Code complete

May be claimed only when all relevant checks below pass on the exact reviewed commit, with no
required test skipped, and the final Codex review explicitly reports no issues on that same SHA.
Warnings already present before the change may remain only when recorded and unrelated.

### Staging verified

Requires code-complete evidence plus cold, warm, partial-retry, crash-recovery, and fixture-move runs
against isolated PostgreSQL/Redis. Structured report counts must reconcile with canonical rows and
the mock FPL call collector. No test may contact live FPL.

### Production verified

Requires staging verification, green deployment checks, and one observed real non-live cycle with:

- one terminal report per attempt;
- no completed attempt with failed units;
- no unexplained checkpoint regression or duplicate child chain;
- database/cache counts agreeing at the publication boundary;
- no new final-failure alert caused by the upgraded paths.

This observation does not enable `TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED`; that remains a separate
explicit approval.

## Mandatory deterministic evaluations

| Area | Required evidence | Pass condition |
|---|---|---|
| Core cold snapshot | `1 x bootstrap`, `1 x fixtures`, atomicity benchmark | Exactly 38 events, 20 teams, 700 players, 1 phase, and 380 fixtures in the reference fixture; DB then Redis milestone order |
| Core failure | injected DB failure, lost commit response, Redis stage failure, and concurrent recovery | A proven rollback compensates Redis; an ambiguous commit preserves its receipt; recovery waits for durable authority; no split view remains |
| Fixture repair | fixture moved between events, an unscheduled fixture, and unaffected fixtures | Exactly 380 authoritative fixtures in total; DB rows equal the schedulable count; unscheduled fixtures remain cached; old/new event and team views are rebuilt without deleting unrelated rows |
| Entry scan | delete an earlier ID and insert a later ID during pagination | Every eligible ID is visited once; no offset skip and no duplicate |
| Snapshot checkpoint | null, preseason 0, stale, current, future, failed transaction, concurrent writes | Only proven contiguous checkpoints advance; failures do not advance; concurrent writes retain the highest proven target |
| Warm retry | complete checkpoints and canonical rows | Zero upstream calls |
| Partial retry | one stale snapshot, transfer history, pick/result pair | Only those exact units are fetched; successful units are not replayed |
| Empty transfers | full history returns an empty list | Empty state is persisted as complete and is not fetched again |
| Rich result checkpoint | history write after a picks/live result, active-to-finalized transition, later core refresh, and finalized warm scan | History changes cannot make stale derived fields look fresh; `data_checked_at` is set at finalization and never moves on routine refresh; finalized complete rows make zero upstream calls |
| League fan-out | 250 synthetic tournaments | Active fan-out never exceeds 10; child IDs are stable within one coordinator run |
| Tournament convergence | missing result, pick, transfer checkpoint, or derived row | Attempt fails with `DATA_SYNC_INCOMPLETE`; downstream publication does not run |
| Valid absence | no event transfer or no cup match | Successful no-op, not a false failure |
| Reporting | success, partial work, exception, 429 retry, timeout/network failure, concurrent attempts | Exactly one isolated report per attempt; bounded labels/counters only; no URL, payload, name, entry/admin identity |
| Migration | clean DB and already-migrated DB | Apply succeeds, second apply is a no-op, status/checksum clean, checkpoint constraints reject values outside 0-38, grants/RLS unchanged |

Wall-clock time is recorded but is not a CI pass/fail threshold. Structural request counts,
concurrency ceilings, memory growth, and milestone ordering are deterministic; host timing is not.

## Required commands

Run against the isolated test PostgreSQL and Redis documented in `tests/README.md`:

```bash
bun run typecheck
bun run lint
bun run test
bun run test:integration
bun run test:publication:integration
bun run test:core-publication-benchmark
bun run build
bun run db:check
bun run db:apply-sql
bun run db:apply-sql
bun run db:migrate:status
```

The second SQL migration apply is intentional. Before merge, verify CI on the exact reviewed SHA and
confirm the PR diff contains no Live-pipeline implementation change. Any later commit invalidates the
review and requires another review cycle.

## Stop conditions

Do not call the upgrade fixed if any required unit is silently converted to a skip, a warm retry
makes an avoidable upstream call, a response can publish a mixed core season, an unbounded loop is
introduced, a report exposes high-cardinality/private fields, a required migration/test is skipped,
or review/CI evidence belongs to an older commit.
