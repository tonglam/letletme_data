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
import { isFPLSeason } from '../utils/conditions';
import { executeTrackedCron } from '../utils/job-run-logger';
import { logInfo } from '../utils/logger';

async function shouldRunDataSync(jobName: string) {
  const now = new Date();
  if (!(await isFPLSeason(now))) {
    logInfo('Skipping data sync job - not FPL season', {
      jobName,
      month: now.getMonth() + 1,
    });
    return false;
  }

  return true;
}

export function registerDataSyncJobs(app: Elysia) {
  return app
    .use(
      cron({
        name: 'events-sync',
        pattern: '35 6 * * *',
        async run() {
          try {
            await executeTrackedCron('events-sync', async () => {
              if (!(await shouldRunDataSync('events-sync'))) {
                return;
              }
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
        async run() {
          try {
            await executeTrackedCron('teams-sync', async () => {
              if (!(await shouldRunDataSync('teams-sync'))) {
                return;
              }
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
        async run() {
          try {
            await executeTrackedCron('fixtures-sync', async () => {
              if (!(await shouldRunDataSync('fixtures-sync'))) {
                return;
              }
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
        async run() {
          try {
            await executeTrackedCron('players-sync', async () => {
              if (!(await shouldRunDataSync('players-sync'))) {
                return;
              }
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
        async run() {
          try {
            await executeTrackedCron('player-stats-sync', async () => {
              if (!(await shouldRunDataSync('player-stats-sync'))) {
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
        async run() {
          try {
            await executeTrackedCron('phases-sync', async () => {
              if (!(await shouldRunDataSync('phases-sync'))) {
                return;
              }
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
