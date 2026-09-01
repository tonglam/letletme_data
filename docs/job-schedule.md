# Job schedule and execution gates

The standalone `scheduler` service is the durable schedule authority. Its
`ScheduledJobDefinition` registry resolves scope, period, catch-up policy and
success evidence into `ops.scheduler_obligations`; BullMQ is only the delivery
mechanism. `GET /jobs` is generated from the same registry plus the explicitly
supported maintenance/manual adapters, and `GET /jobs/status` exposes overdue,
failed and runtime-heartbeat evidence. Live Points V2 has one scheduler
authority and one queue contract; it has no legacy timer mode or alternate
live-points enqueue path.

Legacy API cron registrations use `Asia/Shanghai` (UTC+8); the standalone
registry declares each obligation's timezone explicitly. Cron ticks are
candidates, not guarantees of a write: each job applies its documented season,
current event, fixture-window, and data-availability gates before enqueueing.

## Canonical executable inventory

The following names are the current `schedulerRegistry` entries. Cadence,
timezone, catch-up policy, queue lane, and success evidence are defined in
`src/scheduler/job-registry.ts`; this document explains the business gates
below. The documentation contract test fails if a registry name disappears
from this inventory.

```text
core-current-reconcile
price-change-predictions
price-change-watch
core-snapshot
market-daily
player-prices
player-stats
understat-team-incremental
understat-player-incremental
understat-orphan-reconciler
player-market-freshness-watchdog
bug-report-cleanup
bug-report-screenshot-retention
client-signal-retention
player-season-summary-repair
tournament-trends-repair
tournament-review-v2
launch-monitor
post-match-consolidation
my-fpl-snapshot
my-fpl-finalization
my-fpl-snapshot-outbox
entry-info
tournament-roster
tournament-info
entry-picks
entry-transfers
entry-results
league-event-picks
league-event-results
tournament-event-results
tournament-event-picks
tournament-transfers-pre
live-snapshot
live-picks-refresh
tournament-official-h2h-live
live-finalization
content-acquisition
```

`GET /jobs` is the operator-facing view of this registry, filtered by the
`manualTrigger` flag and merged with these explicit manual adapters:
`core-snapshot-sync`, `event-current-refresh`, `player-prices`,
`player-stats-sync`, `player-values-sync`, `entry-info-daily`,
`entry-event-results-daily`, `league-event-results-sync`,
`tournament-event-results-sync`, `tournament-selection-stats-sync`,
`tournament-info-sync`, and `tournament-materialized-views-refresh`. An alias
does not own a second cadence.

## Core season discovery

This job runs year-round so a newly published season can be discovered before
the fixture-derived `isFPLSeason` window opens.

| Job | Cadence | Gate |
|---|---|---|
| `core-snapshot` | daily obligation | None; both validated upstream payloads are required before atomic publication |

The snapshot uses one bootstrap call and one fixtures call. Events, teams,
players, phases, and fixtures are committed together; an empty or incomplete
payload preserves the previously accepted PostgreSQL and Redis state.

`player-stats-sync` has a daily obligation but is not a discovery job. Player
values and stats use the player-specific `current ?? next` resolver so GW1 can
be initialized before the ordinary current-event gate opens.

## Season launch and current-event control

| Job | Cadence | Gate / behavior |
|---|---|---|
| `launch-monitor` | every five minutes | Maintenance queue obligation; one bootstrap read detects both an empty-event warning and a published current-year GW1; each notification is sent once |
| `core-current-reconcile` | every 30 seconds | Scheduler reconciliation; compares PostgreSQL's current event with the active core revision and enqueues a complete rebuild on mismatch |

The launch monitor calls the FPL bootstrap endpoint from the maintenance
worker. All synchronization work is queue-backed; the scheduler only reserves
and dispatches durable obligations.

## Player values

| Job | Cadence | Gate / behavior |
|---|---|---|
| `market-daily` | 06:55 UTC+8 plus one-minute retries through 07:05 | Before GW1 only the 06:55 tick runs; for a current event, a complete no-change capture remains retryable through the final minute, while failed or unavailable upstream responses retry through the same obligation |
| `player-market-freshness-watchdog` | 07:06 UTC+8 after the market window | Maintenance queue final-capture check: verifies current-day cardinality and end-of-window evidence; alerts without changing `/ready` |
| `player-prices` | 07:10 UTC+8 after values capture | Replays that UTC+8 date's persisted Rise/Faller rows into affected current players; skips cleanly when none exist |
| `player-stats` | daily plus active-event reconciliation | Refreshes the current event, or the next event only when no current event exists |

The standalone scheduler reserves one durable daily obligation before enqueueing
the job. The data worker retries failures, while completed jobs remain for 24
hours and failed jobs for seven days (bounded to 500 each) so an empty queue is
never mistaken for success. Snapshot upsert, stale-row removal, and final
cardinality verification share one database transaction. Zero derived price
changes remains a successful complete capture after the final 07:05 attempt;
before then, a current-event no-change result is a retryable observation so a
late upstream price update is fetched. After recovery, only the current UTC+8
market date is retried; older dates are explicitly recorded as
`irrecoverable` rather than reconstructed from today's bootstrap.

Daily latest-authoritative jobs recover yesterday's final due checkpoint before
reserving today's checkpoint. Current-day-only jobs, including market capture
and its watchdog, never synthesize an older date: missed historical periods are
recorded explicitly as `irrecoverable` and only today's evidence is checked.

Player statistics remain a low-priority observer during the live window. They
do not perform a 1m/5m full-bootstrap replace and do not gate Live Points
publication; their component hash is only recorded until the live-window
cadence report establishes a durable SLO.

## Entry jobs

| Job | Cadence | Gate / behavior |
|---|---|---|
| `entry-info` | daily obligation | `isFPLSeason`; once per UTC date marker, scoped to the latest finalized event (or event `0` before one exists) |
| `entry-picks` | event checkpoint after deadline + 30m | `isFPLSeason`; every due event is reconciled from the entry checkpoint, not only the current API process |
| `entry-transfers` | same event checkpoint as picks | Uses the same deadline window and event scope as picks; a service restart cannot permanently lose transfers |
| `entry-results` | event checkpoint | `isFPLSeason` and every due event |

Entry jobs operate only on known `competition.entries`; core season bootstrap does not
create entry bindings. Scans use an entry-ID keyset cursor, failed-entry retries
contain only exact failed IDs, and canonical snapshot/pick/result/transfer
checkpoints prevent successful units from being fetched again. Picks, results,
and transfers continue to use the current event; only entry-info freshness is
bounded by the latest finalized event so an unfinished current event cannot
invalidate otherwise complete history.

## Match-window live jobs

| Job | Cadence | Gate / behavior |
|---|---|---|
| `live-snapshot` | 30-second lifecycle obligation | `isFPLSeason`, current event, and lifecycle window; one coherent fetch validates event-live + fixtures before atomically publishing the V2 Redis current/previous pair. Heartbeats update source freshness only; semantic changes advance the relevant revision and a merged PostgreSQL checkpoint obligation. |
| `live-match-checkpoint` | coalesced asynchronous obligation | Internal `live-data` worker job created by the Match V3 publisher. It reads only the latest Redis desired publication, writes the compact desk/detail checkpoint after the ten-minute watermark (or immediately for first, lifecycle/identity-boundary, and final publications), then CAS-marks Redis. It never calls FPL and never queues one job per heartbeat. |
| `post-match-consolidation` | bounded post-match slots | Maintenance coordinator enqueues the separate live-finalization and player-stat checkpoint obligations; its success means downstream jobs were accepted, not that their writes are complete. |

The snapshot derives all global live items from the same accepted upstream pair. Every changed item
publishes under one immutable generation; content-identical checks only update `sourceCheckedAt`
and `expectedNextCheckAt`. The standalone scheduler owns the 30-second lifecycle obligation and
the separate post-match finalization obligation. Redis is promoted before PostgreSQL checkpointing,
so a database outage does not remove the last complete page response.

Live Matches V3 is a sibling of that observation, not a second provider poll. It promotes a compact
desk when fixtures are valid and promotes fixture-grain player detail only when the event-live result
and player identity are valid. A fixtures-only success therefore advances the score desk while the
previous compatible detail remains available and marked degraded. The warm checkpoint path is
`Redis current -> Redis previous -> process LKG -> bounded PostgreSQL cold fallback`; no page request
calls FPL, Data API, a queue, or PostgreSQL.

The V2 snapshot does not synchronously write the legacy `fpl.player_gameweek_stats`
rowset. Its complete event-live payload is checkpointed as one immutable V2
publication in PostgreSQL after Redis promotion. Final league, tournament,
knockout, and transfer consumers read that V2 checkpoint as their event-live
authority; they do not reconstruct a final result from legacy rows or refetch
FPL. Player-stat reporting is a separate observer/final-repair concern and is
not a prerequisite for serving the live-points publication.

## Selection publication window

Live picks use a deadline canary and then one per-entry single-flight fetch. A complete same-event
V2 input is not fetched again by a recurring cohort sweep. If PostgreSQL is unavailable after Redis
promotion, the entry remains a durable Redis checkpoint obligation and the repair reads Redis
directly; it does not refetch FPL. Selection time is the UTC match date from 30 through 90 minutes
after the FPL deadline, with pre-start repair probes controlled by the shared lifecycle state.

## Post-match league and tournament results

| Job | Cadence | Gate / behavior |
|---|---|---|
| `league-event-results-trigger` | post-match checkpoint | Every event after its last fixture, plus permanent final repair |
| `tournament-event-results-trigger` | post-match checkpoint | Every event after its last fixture, plus permanent final repair |

The provisional result window starts after the final fixture's expected end
(`latest kickoff + 2 hours`) and remains open for 24 hours. Before that boundary
no result checkpoint is created. It intentionally does not use the calendar
`isFPLSeason` gate, so the next-day GW38 finalization can still run.

Each hour maps to one deterministic provisional checkpoint, so repeated
scheduler passes are idempotent. Once an event is both `finished` and
`data_checked`, the registry also emits one permanent `event-N-final`
checkpoint outside the 24-hour window. That checkpoint remains recoverable
after downtime for every historical gameweek. Successful jobs remain in BullMQ
for 24 hours and failed jobs for seven days (bounded to 500 per queue); a later
scheduler generation retries the same slot without losing the previous failure
evidence.

The league coordinator keeps one scheduler obligation leased while it processes
all active tournaments with bounded concurrency and one shared database
freshness cutoff. It completes the obligation only after every required unit
has converged; otherwise it throws one aggregate failure so a later generation
can repair the incomplete set.

The tournament event-results job starts its cascade only when at least one
active tournament entry was processed, and the event has exact
`finished && data_checked` evidence plus season-owned finalized event-live
rows. Provisional result checkpoints do not open derived tournament work. The
cascade contains:

- points-race, battle-race, and knockout structure jobs;
- post-event transfer calculation;
- cup results;
- selection-stats calculation;
- one materialized-view refresh only after all six real success roles reach
  their Redis-backed completion barrier.

The scheduler obligation ID and generation follow every cascade job. Child
settlement never completes the obligation; only the six-role materialized-view
finalizer may complete it. Partial enqueue, terminal child failure, or finalizer
enqueue failure fails the current generation before BullMQ settlement. A later
generation can compensate it, while generation guards reject a late completion
from an older attempt. Failed enqueue markers are not treated as barrier
success and cannot publish a partial view.

Tournament and league jobs audit canonical rows before returning. Missing
required units fail the BullMQ attempt; a valid absence such as no transfer or
no FPL cup match remains a successful no-op. A Bull retry reuses rows written
since that same job began and fetches only the remaining entry/event units.

## Tournament metadata

| Job | Cadence | Gate / behavior |
|---|---|---|
| `tournament-info-sync` | daily obligation | `isFPLSeason` |

## My Tournament Review V2

| Job | Cadence | Gate / behavior |
|---|---|---|
| `tournament-review-v2` | every five minutes | Reconciles finalized, setup-ready `(season, tournament, event)` obligations and processes at most 20 due scopes per run on the `my-fpl-orchestration` lane. |

The worker is downstream of finalization. It will not publish an event until
`finished = true`, `data_checked = true`, `data_checked_at` is present, and the
selected format's source rows are complete and fresh through that timestamp. A
source-not-ready result increments `source_rechecks` without consuming an
execution attempt; source delays retry at 60s/180s/600s. Execution failures
retry at 60s/300s/900s. After those bounded attempts the obligation is
`DEGRADED` and is repaired every 15 minutes for up to 24 hours from
eligibility.

Success evidence is the committed immutable publication plus the matching
atomic head and `READY` obligation. A BullMQ completion record alone is not
success evidence. The publication transaction uses repeatable-read plus a
scope advisory lock, content hashes the JSON payload, reuses identical content,
and advances only that tournament/event head. Custom tournaments use this same
backfill after `setup_status = 'ready'`; no second creation-time scheduler is
required.

## Gate definitions

- `isFPLSeason`: UTC day range from the earliest GW1 kickoff through the
  latest GW38 kickoff date. It returns false until both fixture sets exist.
- `isMatchDay`: today matches at least one fixture kickoff date and the event
  is not finished.
- `isMatchDayTime`: any fixture is between kickoff -5m and kickoff +2h. The
  five-minute prewarm ensures the first complete snapshot exists before users
  open the live screen; a started, unfinished fixture may keep its interval
  open up to +6h for delayed FPL finish flags.
- `isAfterMatchDay`: event is finished or now is later than the final kickoff
  +2h.
- `isSelectTime`: match day and 30–90 minutes after the event deadline. The live
  lifecycle's first upstream picks probe starts at deadline +60 minutes, but the
  downstream publication window remains open for late cron ticks and retries.
- Provisional post-match result slot: at or after final kickoff +2h but earlier
  than 24 hours after that expected end; the permanent final checkpoint is not
  window-limited once `finished + data_checked` is true.

Manual triggers are listed by `GET /jobs`; scheduler definitions and their
catch-up policies are included in that response. `GET /jobs/status` requires
the service API key and reports obligations, runtime heartbeats, queue counts,
and DB/Redis publication consistency. Some manual paths intentionally
bypass a cron time gate for recovery; operators must verify upstream readiness
before using them.
