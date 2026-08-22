import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import {
  enqueueCoreSnapshotJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerPricesSyncJob,
} from './data-sync-enqueue';
import {
  PLAYER_STATS_ACTIVE_CRON_PATTERN,
  PLAYER_PRICES_REPLAY_CRON_PATTERN,
  PLAYER_STATS_CRON_PATTERN,
} from '../domain/job-schedules';
import { decideLiveLifecycle } from '../services/live-lifecycle-orchestrator';
import { resolvePlayerSyncEvent } from '../services/player-sync-event.service';
import { seasonRepository } from '../repositories/seasons';
import { fixtureRepository } from '../repositories/fixtures';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { CRON_TIMEZONE, formatCronDateKey } from '../utils/timezone';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';

/**
 * The complete core snapshot runs year-round so a newly published FPL season
 * is picked up before the calendar season window opens. Player-specific jobs
 * use current ?? next so GW1 data is refreshed before the first kickoff.
 */
export function registerDataSyncJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'core-snapshot-sync',
        pattern: '35 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('core-snapshot-sync', async () => {
              if (isStandaloneSchedulerEnabled()) return;
              const season = await seasonRepository.findCurrent();
              const job = await enqueueCoreSnapshotJob(season, 'cron');
              logInfo('Core snapshot job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'player-stats-active-sync',
        pattern: PLAYER_STATS_ACTIVE_CRON_PATTERN,
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('player-stats-active-sync', async () => {
              if (isStandaloneSchedulerEnabled()) return;
              const season = await seasonRepository.findCurrent();
              const syncEvent = await resolvePlayerSyncEvent(season);
              if (!syncEvent || syncEvent.phase !== 'current') return;

              const fixtures = await fixtureRepository.findByEvent(season, syncEvent.event.id);
              const decision = decideLiveLifecycle(syncEvent.event, fixtures);
              const liveWindow =
                decision.state === 'LIVE_ACTIVE' || decision.state === 'DAY_SETTLING';
              const now = new Date();
              if (!liveWindow && now.getUTCMinutes() % 5 !== 0) return;

              const bucket = Math.floor(now.getTime() / 60_000);
              const job = await enqueuePlayerStatsSyncJob(season, 'cron', {
                eventId: syncEvent.event.id,
                jobId: `player-stats-e${syncEvent.event.id}-m${bucket}`,
                removeOnSettle: true,
              });
              logInfo('Player stats cadence job enqueued', {
                jobId: job.id,
                eventId: syncEvent.event.id,
                state: decision.state,
                cadence: liveWindow ? '1m' : '5m',
              });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'player-prices-sync',
        pattern: PLAYER_PRICES_REPLAY_CRON_PATTERN,
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('player-prices-sync', async () => {
              if (isStandaloneSchedulerEnabled()) return;
              const season = await seasonRepository.findCurrent();
              if (!(await resolvePlayerSyncEvent(season))) {
                return;
              }
              const changeDate = formatCronDateKey();
              const job = await enqueuePlayerPricesSyncJob(season, 'cron', {
                changeDate,
                jobId: `player-prices-${changeDate}-replay`,
                removeOnSettle: true,
              });
              logInfo('Player prices replay job enqueued via cron', { jobId: job.id, changeDate });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'player-stats-sync',
        pattern: PLAYER_STATS_CRON_PATTERN,
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('player-stats-sync', async () => {
              if (isStandaloneSchedulerEnabled()) return;
              const season = await seasonRepository.findCurrent();
              if (season.lifecycleState !== 'preseason') return;
              if (!(await resolvePlayerSyncEvent(season))) {
                return;
              }
              const job = await enqueuePlayerStatsSyncJob(season, 'cron');
              logInfo('Player stats sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    );
}
