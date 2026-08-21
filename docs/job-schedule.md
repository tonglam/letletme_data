# Job schedule and execution gates

All cron expressions run in `Asia/Shanghai` (UTC+8). Cron ticks are candidates,
not guarantees of a write: each job applies its documented season, current
event, fixture-window, and data-availability gates before enqueueing.

## Core season discovery

This job runs year-round so a newly published season can be discovered before
the fixture-derived `isFPLSeason` window opens.

| Job | Cron | Gate |
|---|---|---|
| `core-snapshot-sync` | `35 6 * * *` | None; both validated upstream payloads are required before atomic publication |

The snapshot uses one bootstrap call and one fixtures call. Events, teams,
players, phases, and fixtures are committed together; an empty or incomplete
payload preserves the previously accepted PostgreSQL and Redis state.

`player-stats-sync` runs at `40 9 * * *` but is not a discovery job. Player
values and stats use the player-specific `current ?? next` resolver so GW1 can
be initialized before the ordinary current-event gate opens.

## Season launch and current-event control

| Job | Cron | Gate / behavior |
|---|---|---|
| `launch-monitor` | `*/5 * * * *` | One bootstrap read detects both an empty-event warning and a published current-year GW1; each notification is sent once |
| `event-current-refresh` | `* * * * *` | `isFPLSeason`; compares PostgreSQL's current event with the active core revision and enqueues a complete rebuild on mismatch |

The launch monitor calls the FPL bootstrap endpoint directly from the API
process. All other synchronization work is queue-backed.

## Player values

| Job | Cron | Gate / behavior |
|---|---|---|
| `player-values-sync` | `25-35 9 * * *` | Before GW1 only 09:25 runs against the next event; once current, every minute until that UTC+8 date's Rise/Faller batch exists |
| `player-market-freshness-watchdog` | `36 9 * * *` | Read-only final-capture check: waits up to five minutes for the deterministic 09:35 job's retries, then verifies current-day cardinality and end-of-window evidence; alerts without changing `/ready` |
| `player-prices-sync` | `40 9 * * *` | Replays that UTC+8 date's persisted Rise/Faller rows into affected current players; skips cleanly when none exist |
| `player-stats-sync` | `40 9 * * *` | Refreshes the current event, or the next event only when no current event exists |

The window uses one deterministic daily job ID to prevent overlap. The data
worker retries failures, and settled deterministic jobs are removed so another
tick can enqueue when needed. Snapshot upsert, stale-row removal, and final
cardinality verification share one database transaction. Zero derived price
changes remains a successful complete capture.

## Entry jobs

| Job | Cron | Gate / behavior |
|---|---|---|
| `entry-info-daily` | `30 10 * * *` | `isFPLSeason`; once per UTC date marker |
| `entry-event-picks-window` | `*/5 * * * *` | `isFPLSeason`, current event, selection publication window |
| `entry-event-transfers-daily` | `40 10 * * *` | `isFPLSeason`, current event, `isAfterMatchDay` |
| `entry-event-results-daily` | `45 10 * * *` | `isFPLSeason` and current event |

Entry jobs operate only on known `competition.entries`; core season bootstrap does not
create entry bindings. Scans use an entry-ID keyset cursor, failed-entry retries
contain only exact failed IDs, and canonical snapshot/pick/result/transfer
checkpoints prevent successful units from being fetched again.

## Match-window live jobs

| Job | Cron | Gate / behavior |
|---|---|---|
| `live-snapshot-trigger` | `* * * * *` | `isFPLSeason`, current event, `isMatchDayTime`; one job concurrently fetches event-live + fixtures, atomically publishes every live Redis view, and persists fixture rows only when football content changes. Every UTC ten-minute boundary also persists event-live/explain rows and runs the dependent cascade. Deterministic event/minute IDs dedupe scheduler replicas, while a waiting/delayed/active check prevents a slow prior minute from stacking. |
| `post-match-consolidation` | `0 6,8,10 * * *` | Current event and bounded post-match result slot; forces a persistent snapshot with a deterministic result-slot ID. |

The snapshot derives `eventLives`, `fixtures`, `liveFixtures`, and `liveBonus` items from the same
accepted upstream pair. Every changed item publishes under one immutable revision;
content-identical minutes are a no-op. This replaces the former independent
cache, score, fixture, and bonus writers, which could race or derive from
different minutes.

A persistent snapshot writes `fpl.player_gameweek_stats` and
`fpl.player_gameweek_scoring_items` in the same season/event scope. Player
season summaries derive from those facts; there is no separate summary writer.
If the event is data-checked inside the post-match window, the worker enqueues
a distinct final league-results correction after the durable rows commit.

## Selection publication window

The following poll every five minutes:

- `league-event-picks-trigger`
- `tournament-event-picks-trigger`
- `tournament-event-transfers-pre-trigger`

They require `isFPLSeason`, a current event, and `isSelectTime`. Selection time
is the UTC match date from 30 through 60 minutes after the FPL deadline. It is
the post-deadline publication window for immutable picks and pre-event transfer tracking.

## Post-match league and tournament results

| Job | Cron | Gate / behavior |
|---|---|---|
| `league-event-results-trigger` | `*/10 * * * *` | Current event plus bounded post-match slot |
| `tournament-event-results-trigger` | `*/10 * * * *` | Current event plus bounded post-match slot |

The result window starts after the final fixture's expected end
(`latest kickoff + 2 hours`) and remains open for 24 hours. It intentionally
does not use the calendar `isFPLSeason` gate, so the next-day GW38 finalization
can still run.

Each hour maps to `provisional-N` or `final-N` according to the event's
`data_checked` flag. Deterministic job IDs make repeated ten-minute ticks
idempotent. Successful jobs remain in BullMQ for 24 hours; failed jobs are
removed so a later tick can retry the same slot.

The tournament event-results job starts its cascade only when at least one
active tournament entry was processed. The cascade contains:

- points-race, battle-race, and knockout structure jobs;
- post-event transfer calculation and a completeness-gated selection-stats MV refresh;
- cup results;
- one materialized-view refresh after the three structure jobs reach their
  Redis-backed completion barrier.

Tournament and league jobs audit canonical rows before returning. Missing
required units fail the BullMQ attempt; a valid absence such as no transfer or
no FPL cup match remains a successful no-op. A Bull retry reuses rows written
since that same job began and fetches only the remaining entry/event units.

## Tournament metadata

| Job | Cron | Gate / behavior |
|---|---|---|
| `tournament-info-sync` | `45 10 * * *` | `isFPLSeason` |

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
- `isSelectTime`: match day and 30–60 minutes after the event deadline.
- Post-match result slot: later than final kickoff +2h but earlier than 24
  hours after that expected end.

Manual triggers are listed by `GET /jobs`. Some manual paths intentionally
bypass a cron time gate for recovery; operators must verify upstream readiness
before using them.
