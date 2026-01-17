# Job Schedule

## Daily Data Sync
- ✅ `events-sync`: daily 06:35 (`35 6 * * *`) via data sync queue.
- ✅ `fixtures-sync`: daily 06:37 (`37 6 * * *`) via data sync queue.
- ✅ `teams-sync`: daily 06:40 (`40 6 * * *`) via data sync queue.
- ✅ `players-sync`: daily 06:43 (`43 6 * * *`) via data sync queue.
- ✅ `phases-sync`: daily 06:45 (`45 6 * * *`) via data sync queue.
- ✅ `player-stats-sync`: daily 09:40 (`40 9 * * *`) via data sync queue.

## Player Values Poller
- ✅ `player-values-sync`: 09:25-09:35 every minute (`25-35 9 * * *`), stops once the day’s price changes have been stored.

## Entry **Jobs**
- ✅ `entry-info-daily`: daily 10:30 (`30 10 * * *`) via entry sync queue.
- ✅ `entry-event-picks-daily`: daily 10:35 (`35 10 * * *`) via entry sync queue.
- ✅ `entry-event-transfers-daily`: daily 10:40 (`40 10 * * *`) via entry sync queue.
- ✅ `entry-event-results-daily`: daily 10:45 (`45 10 * * *`) via entry sync queue.
- ✅ Entry sync retries failed entry IDs up to 2 cycles.

## Matchday Jobs
- ✅ `event-lives-sync`: every 5 minutes (`*/5 * * * *`), gated by `isMatchDayTime`.
- ✅ `live-scores`: every 15 minutes (`*/15 * * * *`), gated by `isMatchDayTime`.
- ✅ `event-live-summary-sync`: matchday 06:05/08:05/10:05 (`5 6,8,10 * * *`), gated by `isMatchDay`.
- ✅ `event-live-explain-sync`: matchday 06:08/08:08/10:08 (`8 6,8,10 * * *`), gated by `isMatchDay`.
- ✅ `event-overall-result-sync`: matchday 06:02/08:02/10:02 (`2 6,8,10 * * *`), gated by `isMatchDay`.

## Selection Window Jobs (Pre-deadline)
- ✅ `league-event-picks-sync`: every 5 minutes (`*/5 * * * *`), gated by `isSelectTime`.
- ✅ `tournament-event-picks-sync`: every 5 min 00:00-04:59 & 18:00-23:59 (`*/5 0-4,18-23 * * *`), gated by `isSelectTime`.
- ✅ `tournament-event-transfers-pre-sync`: every 5 min 00:00-04:59 & 18:00-23:59 (`*/5 0-4,18-23 * * *`), gated by `isSelectTime`.

## Post-Matchday Jobs
- ✅ `league-event-results-sync`: 08:00/10:00/12:00 (`0 8,10,12 * * *`), gated by `isAfterMatchDay`.
- ✅ `event-standings-sync`: daily 12:00 (`0 12 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-event-results-sync`: matchday 06:10/08:10/10:10 (`10 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-points-race-results-sync`: matchday 06:20/08:20/10:20 (`20 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-battle-race-results-sync`: matchday 06:30/08:30/10:30 (`30 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-knockout-results-sync`: matchday 06:40/08:40/10:40 (`40 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-event-transfers-post-sync`: matchday 06:45/08:45/10:45 (`45 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-event-cup-results-sync`: matchday 06:55/08:55/10:55 (`55 6,8,10 * * *`), gated by `isAfterMatchDay`.

## Daily Tournament Metadata
- ✅ `tournament-info-sync`: daily 10:45 (`45 10 * * *`).

## Matchday Helpers
- ✅ `isMatchDay`: today is in fixture kickoff dates (UTC), skips if event finished.
- ✅ `isMatchDayTime`: between earliest kickoff and (latest kickoff + 2h).
- ✅ `isAfterMatchDay`: event finished or now > (latest kickoff + 2h).
- ✅ `isSelectTime`: between deadline + 30m and +60m on matchday.
