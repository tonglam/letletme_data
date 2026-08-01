import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from './data-sync-enqueue';
import { shouldRunCurrentEventJob } from './current-event-gate';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';
import { CRON_TIMEZONE } from '../utils/timezone';

/**
 * Core entity syncs (events/teams/fixtures/players/phases) run year-round so a
 * newly published FPL season is picked up before the calendar season window
 * opens. Services short-circuit on empty pre-season payloads. Player-stats
 * remains gated by the season window and the presence of a current event.
 */
export function registerDataSyncJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'events-sync',
        pattern: '35 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('events-sync', async () => {
              const job = await enqueueEventsSyncJob('cron');
              logInfo('Events sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'teams-sync',
        pattern: '37 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('teams-sync', async () => {
              const job = await enqueueTeamsSyncJob('cron');
              logInfo('Teams sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'fixtures-sync',
        pattern: '40 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('fixtures-sync', async () => {
              const job = await enqueueFixturesSyncJob('cron');
              logInfo('Fixtures sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'players-sync',
        pattern: '43 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('players-sync', async () => {
              const job = await enqueuePlayersSyncJob('cron');
              logInfo('Players sync job enqueued via cron', { jobId: job.id });
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
        pattern: '40 9 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('player-stats-sync', async () => {
              if (!(await shouldRunCurrentEventJob('player-stats-sync'))) {
                return;
              }
              const job = await enqueuePlayerStatsSyncJob('cron');
              logInfo('Player stats sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    )
    .use(
      cron({
        name: 'phases-sync',
        pattern: '45 6 * * *',
        timezone: CRON_TIMEZONE,
        async run() {
          try {
            await executeTrackedCron('phases-sync', async () => {
              const job = await enqueuePhasesSyncJob('cron');
              logInfo('Phases sync job enqueued via cron', { jobId: job.id });
            });
          } catch {
            // Failure details are already emitted by runTrackedJob.
          }
        },
      }),
    );
}
