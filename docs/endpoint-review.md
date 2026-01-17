# Job Review

Assumption: background jobs are the only source of trust.

## Data Sync Jobs (queue-based)

### events-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh events metadata from FPL.
- Main logic: cron 06:35 enqueues `data-sync` job `events`; worker runs `syncEvents()`.
- Deep dive: `syncEvents()` calls `fplClient.getBootstrap()`, maps via `transformEvents()`, upserts
  with `eventRepository.upsertBatch()`, then refreshes `eventsCache.set()`.
- Potential issues: duplicate enqueues if cron/manual overlap; no job lock; validation warnings are
  surfaced but `errors` now includes warnings as well as transform failures.
- Improvements: season gate and validation warning count added; keep monitoring hooks for queue health.

### fixtures-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh fixtures list from FPL.
- Main logic: cron 06:37 enqueues `data-sync` job `fixtures`; worker runs `syncFixtures()`.
- Deep dive: `syncFixtures(eventId?)` calls `fplClient.getFixtures()`, validates/transforms via
  `transformFixtures()`, upserts in 500-row batches via `fixtureRepository.upsertBatch()`, then
  refreshes cache with `fixturesCache.set()` or `fixturesCache.setByEvent()`.
- Potential issues: full sync is heavy; `transformFixtures()` still throws if all fixtures are invalid;
  no lock/dedupe.
- Improvements: season gate added; chunked batch upserts to reduce DB load; empty API responses now
  return safely; event-only sync clears stale event keys and unscheduled cache; evaluate
  incremental/delta updates and queue limiter.

### teams-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh team metadata from FPL.
- Main logic: cron 06:40 enqueues `data-sync` job `teams`; worker runs `syncTeams()`.
- Deep dive: `syncTeams()` uses `fplClient.getBootstrap()`, maps via `transformTeams()` (validated),
  upserts with `teamRepository.upsertBatch()`, then refreshes `teamsCache.set()`.
- Potential issues: `transformTeams()` throws if all teams invalid, failing the job; `errors` metric
  only reflects transform failures (no warning split); no lock/dedupe.
- Improvements: season gate added; consider safe handling for empty/invalid arrays and warning counts;
  add job dedupe/lock or rate limiter.

### players-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh player metadata from FPL.
- Main logic: cron 06:43 enqueues `data-sync` job `players`; worker runs `syncPlayers()`.
- Deep dive: `syncPlayers()` uses `fplClient.getBootstrap()`, maps via `transformPlayers()` (skips
  invalid elements), upserts via `playerRepository.upsertBatch()`, then refreshes `playersCache.set()`.
- Potential issues: invalid players are logged but still return a non-zero `errors` count without
  warning split; no lock/dedupe; full bootstrap fetch every run.
- Improvements: season gate added; empty/invalid payload now fails early; consider warning count or
  per-player error output; add job dedupe/lock or rate limiter.

### player-stats-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh current player stats.
- Main logic: cron 09:40 enqueues `data-sync` job `player-stats`; worker runs `syncCurrentPlayerStats()`.
- Deep dive: `syncCurrentPlayerStats()` pulls bootstrap, finds current event, transforms via
  `transformCurrentGameweekPlayerStats()`, upserts via `playerStatsRepository.upsertBatch()`, then
  refreshes cache with `playerStatsCache.setByEvent()`.
- Potential issues: errors are computed as input-output but transform can skip items without
  warning split; no lock/dedupe.
- Improvements: season gate added; empty-response guard and event cache refresh added; consider
  warning counts; add job dedupe/lock or rate limiter.

### phases-sync
- Location: `src/jobs/data-sync.jobs.ts`, `src/jobs/data-sync.queue.ts`, `src/workers/data-sync.worker.ts`.
- Aim: refresh season phases.
- Main logic: cron 06:45 enqueues `data-sync` job `phases`; worker runs `syncPhases()`.
- Deep dive: `syncPhases()` pulls bootstrap, transforms via `transformPhases()` (validated), upserts
  with `phaseRepository.upsertBatch()`, then refreshes `phasesCache.set()`.
- Potential issues: `transformPhases()` throws if all phases invalid, failing the job; errors metric
  only reflects transform failures; no lock/dedupe.
- Improvements: season gate added; consider warning count or safe empty handling; add job
  dedupe/lock or rate limiter.

### player-values-sync
- Location: `src/jobs/player-values-window.jobs.ts`, `src/jobs/data-sync.queue.ts`,
  `src/workers/data-sync.worker.ts`.
- Aim: refresh current player value changes.
- Main logic: cron 09:25-09:35 (every minute) runs `syncCurrentPlayerValues()` directly and skips the
  remaining minutes once a change-date row exists; manual triggers still enqueue the data-sync job.
- Deep dive: `syncCurrentPlayerValues()` uses bootstrap, finds current event, compares current
  `now_cost` with last stored values, transforms via `transformPlayerValuesWithChanges()`, inserts
  new records, then caches by `changeDate`.
- Potential issues: empty `elements` yields `{ count: 0 }` with no explicit warning; transform errors
  are logged but not surfaced in result; event-specific sync uses ISO `changeDate`, which doesn’t
  match the `YYYYMMDD` date cache convention.
- Improvements: season gate added; consider empty-response guard and warning counts; align
  event-sync `changeDate` format with date cache keys.

## Entry Sync Jobs (queue-based)

### entry-info-sync
- Location: `src/jobs/entry-info.jobs.ts`, `src/jobs/entry-sync.queue.ts`, `src/workers/entry-sync.worker.ts`, `src/services/entry-info.service.ts`.
- Aim: refresh entry profiles for all known entries.
- Main logic: cron 10:30 checks season + daily-cache guard, enqueues `entry-info` job; worker processes entries in configurable chunks with concurrency/throttling and retry cycles.
- Potential issues: still sequential per entry inside chunk (no per-entry cache) and heavy API usage for thousands of IDs; manual triggers still rely on queues only.
- Improvements: consider per-entry rate limiting, richer metrics, and letting API trigger accept subset IDs (now possible via `/entry-sync` body schema).

### entry-picks-sync
- Location: `src/jobs/entry-picks.jobs.ts`, `src/jobs/entry-sync.queue.ts`, `src/workers/entry-sync.worker.ts`, `/entry-sync/picks` API.
- Aim: refresh current event picks for all known entries or selected IDs.
- Main logic: cron 10:35 enforces season + `isSelectTime`, enqueues `entry-picks` job with eventId; worker processes entries in batches using shared event context; `/entry-sync/picks` allows manual/manual subset triggers.
- Potential issues: still dependent on selection-window accuracy and FPL rate limits; no lock to prevent overlapping manual triggers beyond queue dedupe.
- Improvements: add distributed lock on cron, surface metrics about filtered entryIds, optionally support specifying eventId in the API.

### entry-transfers-sync
- Location: `src/jobs/entry-transfers.jobs.ts`, `src/jobs/entry-sync.queue.ts`, `src/workers/entry-sync.worker.ts`, `/entry-sync/transfers` API.
- Aim: refresh current event transfers for all known entries.
- Main logic: cron 10:40 enforces season + `isAfterMatchDay` and enqueues `entry-transfers` job with eventId; worker reuses per-job event live points cache; `/entry-sync/transfers` API triggers the same job.
- Potential issues: caching TTL may miss late live updates; still no distributed lock; job duration tied to entry volume.
- Improvements: add cache invalidation strategy, support manual eventId override, expose progress metrics.

### entry-results-sync
- Location: `src/jobs/entry-results.jobs.ts`, `src/jobs/entry-sync.queue.ts`, `src/workers/entry-sync.worker.ts`, `/entry-sync/results` API.
- Aim: refresh per-event results for all known entries.
- Main logic: cron 10:45 (pending match-day gating) enqueues `entry-results` job; worker batches entries with concurrency; `/entry-sync/results` allows manual/sliced triggers.
- Potential issues: still lacks automated `isAfterMatchDay` guard; results handler fetches picks+live per entry without caching; long runtimes.
- Improvements: add same gating + shared data caching as transfers; consider splitting per-event vs per-entry responsibilities.

## Live Jobs (cron direct)

### event-lives-sync
- Location: `src/jobs/live.jobs.ts`, `src/services/event-lives.service.ts`.
- Aim: refresh live player event data during match windows.
- Main logic: cron every 5 minutes; checks season + `isMatchDayTime`; runs `syncEventLives(currentEvent.id)`.
- Potential issues: no lock; if run exceeds 5 minutes, overlap occurs; fixture fetch each run.
- Improvements: add distributed lock; cache fixtures; move to queue for retries.

### event-live-summary-sync
- Location: `src/jobs/live.jobs.ts`, `src/services/event-live-summaries.service.ts`.
- Aim: snapshot aggregated live summary data on matchdays.
- Main logic: cron at 06:05/08:05/10:05; checks `isMatchDay`; runs `syncEventLiveSummary()`.
- Potential issues: depends on event live data being fresh; no lock or retry beyond cron.
- Improvements: add dependency check on event-lives sync; move to queue with retries.

### event-live-explain-sync
- Location: `src/jobs/live.jobs.ts`, `src/services/event-live-explains.service.ts`.
- Aim: snapshot live explain data for current event.
- Main logic: cron at 06:08/08:08/10:08; checks `isMatchDay`; runs `syncEventLiveExplain(currentEvent.id)`.
- Potential issues: external API calls without rate limit; no lock; no retry beyond cron.
- Improvements: add rate limiting + lock; move to queue for backoff.

### event-overall-result-sync
- Location: `src/jobs/live.jobs.ts`, `src/services/event-overall-results.service.ts`.
- Aim: snapshot overall event results from bootstrap data.
- Main logic: cron at 06:02/08:02/10:02; checks `isMatchDay`; runs `syncEventOverallResult()`.
- Potential issues: fetches bootstrap every run; no lock or retry; depends on bootstrap consistency.
- Improvements: cache bootstrap; add lock and retry with backoff.

### live-scores
- Location: `src/jobs/live.jobs.ts`.
- Aim: live score updates (placeholder).
- Main logic: cron every 15 minutes; checks season + `isMatchDayTime`; logs placeholder.
- Potential issues: no implementation; produces no data.
- Improvements: implement score fetch + persistence or remove until ready.

## League Jobs (cron direct)

### league-event-picks-sync
- Location: `src/jobs/league-event-picks.jobs.ts`, `src/services/league-event-picks.service.ts`.
- Aim: sync league entry picks during selection windows.
- Main logic: cron every 5 minutes; checks season + `isSelectTime`; runs `syncLeagueEventPicks(currentEvent.id)`.
- Potential issues: runs in-process; no lock; repeated full syncs may be heavy.
- Improvements: add job lock; move to queue with per-league batching.

### league-event-results-sync
- Location: `src/jobs/league-event-results.jobs.ts`, `src/services/league-event-results.service.ts`.
- Aim: sync league results after matchdays.
- Main logic: cron at 08:00/10:00/12:00; checks season + `isAfterMatchDay`; runs `syncLeagueEventResults(currentEvent.id)`.
- Potential issues: no lock; no retries beyond cron; repeated full syncs.
- Improvements: move to queue with backoff; add idempotent checks.

## Tournament Jobs (cron direct)

### tournament-event-picks-sync
- Location: `src/jobs/tournament-event-picks.jobs.ts`, `src/services/tournament-event-picks.service.ts`.
- Aim: sync tournament entry picks during selection windows.
- Main logic: cron every 5 minutes in 00:00-04:59 & 18:00-23:59; checks season + `isSelectTime`; runs `syncTournamentEventPicks(currentEvent.id)`.
- Potential issues: no lock; repeated full syncs; heavy if tournaments are large.
- Improvements: add lock; batch by tournament; move to queue with backoff.

### tournament-event-results-sync
- Location: `src/jobs/tournament-event-results.jobs.ts`, `src/services/tournament-event-results.service.ts`.
- Aim: sync tournament results after matchdays.
- Main logic: cron at 06:10/08:10/10:10; checks season + `isAfterMatchDay`; runs `syncTournamentEventResults(currentEvent.id)`.
- Potential issues: no lock; no retries beyond cron.
- Improvements: move to queue; add idempotent checks + alerting.

### tournament-event-transfers-pre-sync
- Location: `src/jobs/tournament-event-transfers.jobs.ts`, `src/services/tournament-event-transfers.service.ts`.
- Aim: snapshot tournament transfers during selection windows.
- Main logic: cron every 5 minutes in selection windows; checks season + `isSelectTime`; runs `syncTournamentEventTransfersPre(currentEvent.id)`.
- Potential issues: no lock; repeated full syncs; no retry/backoff.
- Improvements: add lock + queue; batch by tournament.

### tournament-event-transfers-post-sync
- Location: `src/jobs/tournament-event-transfers.jobs.ts`, `src/services/tournament-event-transfers.service.ts`.
- Aim: update tournament transfers after matchdays.
- Main logic: cron at 06:45/08:45/10:45; checks season + `isAfterMatchDay`; runs `syncTournamentEventTransfersPost(currentEvent.id)`.
- Potential issues: no lock; no retries beyond cron.
- Improvements: move to queue; add retry/backoff and job dedupe.

### tournament-event-cup-results-sync
- Location: `src/jobs/tournament-event-cup-results.jobs.ts`, `src/services/tournament-event-cup-results.service.ts`.
- Aim: sync tournament cup results after matchdays.
- Main logic: cron at 06:55/08:55/10:55; checks season + `isAfterMatchDay`; runs `syncTournamentEventCupResults(currentEvent.id)`.
- Potential issues: no lock; no retries beyond cron.
- Improvements: move to queue; add idempotent checks + alerts.

### tournament-info-sync
- Location: `src/jobs/tournament-info.jobs.ts`, `src/services/tournament-info.service.ts`.
- Aim: refresh tournament names and metadata daily.
- Main logic: cron 10:45; checks season; runs `syncTournamentInfo()`.
- Potential issues: no lock; no retries beyond cron; no validation of results.
- Improvements: add lock + retries; add change detection to skip if unchanged.

### tournament-points-race-results-sync
- Location: `src/jobs/tournament-points-race-results.jobs.ts`, `src/services/tournament-points-race-results.service.ts`.
- Aim: sync points race standings after matchdays.
- Main logic: cron at 06:20/08:20/10:20; checks season + `isAfterMatchDay`; runs `syncTournamentPointsRaceResults(currentEvent.id)`.
- Potential issues: no lock; no retries; repeated full syncs.
- Improvements: move to queue; batch by tournament group.

### tournament-battle-race-results-sync
- Location: `src/jobs/tournament-battle-race-results.jobs.ts`, `src/services/tournament-battle-race-results.service.ts`.
- Aim: sync battle race standings after matchdays.
- Main logic: cron at 06:30/08:30/10:30; checks season + `isAfterMatchDay`; runs `syncTournamentBattleRaceResults(currentEvent.id)`.
- Potential issues: no lock; no retries; repeated full syncs.
- Improvements: move to queue; batch by tournament group.

### tournament-knockout-results-sync
- Location: `src/jobs/tournament-knockout-results.jobs.ts`, `src/services/tournament-knockout-results.service.ts`.
- Aim: sync knockout matchups after matchdays.
- Main logic: cron at 06:40/08:40/10:40; checks season + `isAfterMatchDay`; runs `syncTournamentKnockoutResults(currentEvent.id)`.
- Potential issues: no lock; no retries; repeated full syncs.
- Improvements: move to queue; batch by tournament group.

## Standings Jobs (cron direct)

### event-standings-sync
- Location: `src/jobs/event-standings.jobs.ts`, `src/services/event-standings.service.ts`.
- Aim: sync Premier League standings after matchdays.
- Main logic: cron 12:00; checks season + `isAfterMatchDay`; runs `syncEventStandings(currentEvent.id)`.
- Potential issues: no lock; no retries beyond cron; repeated full syncs.
- Improvements: move to queue; add idempotent checks + alerts.
