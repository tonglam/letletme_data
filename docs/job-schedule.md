# Job schedule and execution gates

All cron expressions run in `Asia/Shanghai` (UTC+8). Cron ticks are candidates,
not guarantees of a write: each job applies its documented season, current
event, fixture-window, and data-availability gates before enqueueing.

## Core season discovery

These jobs run year-round so a newly published season can be discovered before
the fixture-derived `isFPLSeason` window opens.

| Job | Cron | Gate |
|---|---|---|
| `events-sync` | `35 6 * * *` | None; empty events preserve existing state |
| `teams-sync` | `37 6 * * *` | None; empty teams preserve existing state |
| `fixtures-sync` | `40 6 * * *` | None; empty fixtures preserve existing state |
| `players-sync` | `43 6 * * *` | None; empty players preserve existing state |
| `phases-sync` | `45 6 * * *` | None; empty phases preserve existing state |

`player-stats-sync` runs at `40 9 * * *` but is not a discovery job. Player
values and stats use the player-specific `current ?? next` resolver so GW1 can
be initialized before the ordinary current-event gate opens.

## Season launch and current-event control

| Job | Cron | Gate / behavior |
|---|---|---|
| `launch-monitor` | `*/5 * * * *` | One bootstrap read detects both an empty-event warning and a published current-year GW1; each notification is sent once |
| `event-current-refresh` | `* * * * *` | `isFPLSeason`; rebuilds `event:current` and enqueues events sync when the GW changes |

The launch monitor calls the FPL bootstrap endpoint directly from the API
process. All other synchronization work is queue-backed.

## Player values

| Job | Cron | Gate / behavior |
|---|---|---|
| `player-values-sync` | `25-35 9 * * *` | Before GW1 only 09:25 runs against the next event; once current, every minute until that UTC+8 date's Rise/Faller batch exists |
| `player-prices-sync` | `40 9 * * *` | Replays that UTC+8 date's persisted Rise/Faller rows into affected current players; skips cleanly when none exist |
| `player-stats-sync` | `40 9 * * *` | Refreshes the current event, or the next event only when no current event exists |

The window uses one deterministic daily job ID to prevent overlap. The data
worker retries failures, and settled deterministic jobs are removed so another
tick can enqueue when needed.

## Entry jobs

| Job | Cron | Gate / behavior |
|---|---|---|
| `entry-info-daily` | `30 10 * * *` | `isFPLSeason`; once per UTC date marker |
| `entry-event-picks-window` | `*/5 * * * *` | `isFPLSeason`, current event, selection publication window |
| `entry-event-transfers-daily` | `40 10 * * *` | `isFPLSeason`, current event, `isAfterMatchDay` |
| `entry-event-results-daily` | `45 10 * * *` | `isFPLSeason` and current event |

Entry jobs operate only on known `entry_infos`; core season bootstrap does not
create entry bindings. Failed entry IDs can be retried by the entry worker's
bounded retry cycle.

## Match-window live jobs

| Job | Cron | Gate / behavior |
|---|---|---|
| `live-snapshot-trigger` | `* * * * *` | `isFPLSeason`, current event, `isMatchDayTime`; one job concurrently fetches event-live + fixtures, atomically publishes every live Redis view, and persists fixture rows only when football content changes. Every UTC ten-minute boundary also persists event-live/explain rows and runs the dependent cascade. Deterministic event/minute IDs dedupe scheduler replicas, while a waiting/delayed/active check prevents a slow prior minute from stacking. |
| `post-match-consolidation` | `0 6,8,10 * * *` | Current event and bounded post-match result slot; forces a persistent snapshot with a deterministic result-slot ID. |

The snapshot derives `EventLive`, `Fixtures`, legacy/V2 live-fixture, and
legacy/V2 bonus hashes from the same accepted upstream pair. Changed views are
published together; content-identical minutes update only freshness metadata.
This replaces the former independent cache, score, fixture, and bonus cron
paths, which could race or derive from different minutes.

After a persistent snapshot succeeds, the worker enqueues summary, explain,
and overall-result jobs. Fixture and bonus derivatives are already in the
snapshot, so they are not re-enqueued. If the event is data-checked inside the
post-match window, the worker also enqueues a distinct final league-results
correction after the fresh `event_lives` rows are persisted.

## Selection publication window

The following poll every five minutes:

- `league-event-picks-trigger`
- `tournament-event-picks-trigger`
- `tournament-event-transfers-pre-trigger`

They require `isFPLSeason`, a current event, and `isSelectTime`. Selection time
is the UTC match date from 30 through 90 minutes after the FPL deadline. It is
the post-deadline publication window for immutable picks, despite the legacy
"pre" name on tournament transfer tracking.

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
- post-event transfer calculation and selection stats;
- cup results;
- one materialized-view refresh after the three structure jobs reach their
  Redis-backed completion barrier.

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
- `isSelectTime`: match day and 30–90 minutes after the event deadline.
- Post-match result slot: later than final kickoff +2h but earlier than 24
  hours after that expected end.

Manual triggers are listed by `GET /jobs`. Some manual paths intentionally
bypass a cron time gate for recovery; operators must verify upstream readiness
before using them.
