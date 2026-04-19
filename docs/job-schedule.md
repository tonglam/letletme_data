# Job Schedule

## Daily Data Sync
- ✅ `events-sync`: daily 06:35 (`35 6 * * *`) via data sync queue.
- ✅ `teams-sync`: daily 06:37 (`37 6 * * *`) via data sync queue.
- ✅ `fixtures-sync`: daily 06:40 (`40 6 * * *`) via data sync queue.
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
- ✅ `event-lives-cache-trigger`: every minute (`* * * * *`), gated by `isMatchDayTime`.
- ✅ `event-lives-db-trigger`: every 10 minutes (`*/10 * * * *`), gated by `isMatchDayTime`.
- ✅ `live-scores`: every 15 minutes (`*/15 * * * *`), gated by `isMatchDayTime`.
- ✅ `post-match-consolidation`: 06:00/08:00/10:00 (`0 6,8,10 * * *`), gated by `isAfterMatchDay`.
- ✅ Cascade-only live jobs (no direct cron): `event-live-summary`, `event-live-explain`, `event-overall-result`.
- ✅ Minute-triggered cache jobs: `live-fixture-cache`, `live-bonus-cache`.

## Selection Window Jobs (Pre-deadline)
- ✅ `league-event-picks-sync`: every 5 minutes (`*/5 * * * *`), gated by `isSelectTime`.
- ✅ `tournament-event-picks-sync`: every 5 minutes (`*/5 * * * *`), gated by `isSelectTime`.
- ✅ `tournament-event-transfers-pre-sync`: every 5 minutes (`*/5 * * * *`), gated by `isSelectTime`.

## Post-Matchday Jobs
- ✅ `league-event-results-sync`: every 10 minutes (`*/10 * * * *`), gated by `isAfterMatchDay`.
- ✅ `tournament-event-results-sync`: every 10 minutes (`*/10 * * * *`), gated by `isAfterMatchDay`.
- ✅ Cascade-only tournament jobs (no direct cron): `tournament-points-race`, `tournament-battle-race`, `tournament-knockout`, `tournament-transfers-post`, `tournament-cup-results`.

## Daily Tournament Metadata
- ✅ `tournament-info-sync`: daily 10:45 (`45 10 * * *`).

## Matchday Helpers
- ✅ `isMatchDay`: today is in fixture kickoff dates (UTC), skips if event finished.
- ✅ `isMatchDayTime`: between earliest kickoff and (latest kickoff + 2h).
- ✅ `isAfterMatchDay`: event finished or now > (latest kickoff + 2h).
- ✅ `isSelectTime`: between deadline + 30m and +60m on matchday.
