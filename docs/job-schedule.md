# Job schedule and execution gates

The standalone `scheduler` service is the durable schedule authority. Its
`ScheduledJobDefinition` registry resolves scope, period, catch-up policy and
success evidence into `ops.scheduler_obligations`; BullMQ is only the delivery
mechanism. `GET /jobs` is generated from the same registry plus the explicitly
supported maintenance/manual adapters, and `GET /jobs/status` exposes overdue,
failed and runtime-heartbeat evidence. The API-side cron registrations that
remain during migration are compatibility triggers, not a second source of
schedule truth. They are disabled when the standalone scheduler owns
production cadence. If a rolling migration temporarily leaves the API as the
timer owner, set `SCHEDULER_MODE=compatibility`; those ticks call the same
obligation reservation pass instead of enqueueing directly.

Legacy API cron registrations use `Asia/Shanghai` (UTC+8); the standalone
registry declares each obligation's timezone explicitly. Cron ticks are
candidates, not guarantees of a write: each job applies its documented season,
current event, fixture-window, and data-availability gates before enqueueing.

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
| `market-daily` | 09:25 UTC+8 plus durable retries | Before GW1 only the current UTC+8 date is eligible; failed or unavailable upstream responses retry through the same obligation without replaying old dates |
| `player-market-freshness-watchdog` | after the market window | Maintenance queue final-capture check: verifies current-day cardinality and end-of-window evidence; alerts without changing `/ready` |
| `player-prices` | after values capture | Replays that UTC+8 date's persisted Rise/Faller rows into affected current players; skips cleanly when none exist |
| `player-stats` | daily plus active-event reconciliation | Refreshes the current event, or the next event only when no current event exists |

The standalone scheduler reserves one durable daily obligation before enqueueing
the job. The data worker retries failures, while completed jobs remain for 24
hours and failed jobs for seven days (bounded to 500 each) so an empty queue is
never mistaken for success. Snapshot upsert, stale-row removal, and final
cardinality verification share one database transaction. Zero derived price
changes remains a successful complete capture. After recovery, only the current
UTC+8 market date is retried; older dates are explicitly recorded as
`irrecoverable` rather than reconstructed from today's bootstrap.

Daily latest-authoritative jobs recover yesterday's final due checkpoint before
reserving today's checkpoint. Current-day-only jobs, including market capture
and its watchdog, never synthesize an older date: missed historical periods are
recorded explicitly as `irrecoverable` and only today's evidence is checked.

The additional `player-stats-active` checkpoint runs every minute only during
`LIVE_ACTIVE` and `DAY_SETTLING`, and every five minutes during `PICKS_SYNC`,
`BETWEEN_FIXTURES`, and `GW_REVIEW`. Pre-match, finalized, and other static
lifecycle states rely on the daily, transition, and final-repair checkpoints.

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
| `live-snapshot` | 30-second lifecycle obligation | `isFPLSeason`, current event, `isMatchDayTime`; one job concurrently fetches event-live + fixtures, atomically publishes every live Redis view, and persists fixture rows only when football content changes. Every UTC ten-minute boundary also persists event-live/explain rows and runs the dependent cascade. |
| `post-match-consolidation` | bounded post-match slots | Maintenance coordinator enqueues the separate live-finalization and player-stat checkpoint obligations; its success means downstream jobs were accepted, not that their writes are complete. |

The snapshot derives `eventLives`, `fixtures`, `liveFixtures`, and `liveBonus` items from the same
accepted upstream pair. Every changed item publishes under one immutable revision;
content-identical minutes are a no-op. The standalone scheduler owns the 30-second
lifecycle obligation, requests full event-live persistence on a ten-minute bucket,
and has a separate post-match finalization obligation. This replaces the former independent
cache, score, fixture, and bonus writers, which could race or derive from
different minutes.

A persistent snapshot writes `fpl.player_gameweek_stats` and
`fpl.player_gameweek_scoring_items` in the same season/event scope. Player
season summaries derive from those facts; there is no separate summary writer.
If the event is data-checked inside the post-match window, the worker enqueues
a distinct final league-results correction after the durable rows commit.

## Selection publication window

The former standalone picks/transfers cron modules are removed. The registry's
event-checkpoint obligations are the only scheduled authority; API-side
compatibility code does not own these windows. Selection time
is the UTC match date from 30 through 90 minutes after the FPL deadline. It is
the post-deadline publication window for immutable picks and pre-event transfer tracking.

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
active tournament entry was processed. The cascade contains:

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
