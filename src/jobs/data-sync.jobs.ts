import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from './data-sync.queue';
import { isFPLSeason } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';

function shouldRunDataSync(jobName: string) {
  const now = new Date();
  if (!isFPLSeason(now)) {
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
          logInfo('Cron job started: events-sync');
          if (!shouldRunDataSync('events-sync')) {
            return;
          }
          try {
            const job = await enqueueEventsSyncJob('cron');
            logInfo('Events sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: events-sync', error);
          }
        },
      }),
    )
    .use(
      cron({
        name: 'fixtures-sync',
        pattern: '37 6 * * *',
        async run() {
          logInfo('Cron job started: fixtures-sync');
          if (!shouldRunDataSync('fixtures-sync')) {
            return;
          }
          try {
            const job = await enqueueFixturesSyncJob('cron');
            logInfo('Fixtures sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: fixtures-sync', error);
          }
        },
      }),
    )
    .use(
      cron({
        name: 'teams-sync',
        pattern: '40 6 * * *',
        async run() {
          logInfo('Cron job started: teams-sync');
          if (!shouldRunDataSync('teams-sync')) {
            return;
          }
          try {
            const job = await enqueueTeamsSyncJob('cron');
            logInfo('Teams sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: teams-sync', error);
          }
        },
      }),
    )
    .use(
      cron({
        name: 'players-sync',
        pattern: '43 6 * * *',
        async run() {
          logInfo('Cron job started: players-sync');
          if (!shouldRunDataSync('players-sync')) {
            return;
          }
          try {
            const job = await enqueuePlayersSyncJob('cron');
            logInfo('Players sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: players-sync', error);
          }
        },
      }),
    )
    .use(
      cron({
        name: 'player-stats-sync',
        pattern: '40 9 * * *',
        async run() {
          logInfo('Cron job started: player-stats-sync');
          if (!shouldRunDataSync('player-stats-sync')) {
            return;
          }
          try {
            const job = await enqueuePlayerStatsSyncJob('cron');
            logInfo('Player stats sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: player-stats-sync', error);
          }
        },
      }),
    )
    .use(
      cron({
        name: 'phases-sync',
        pattern: '45 6 * * *',
        async run() {
          logInfo('Cron job started: phases-sync');
          if (!shouldRunDataSync('phases-sync')) {
            return;
          }
          try {
            const job = await enqueuePhasesSyncJob('cron');
            logInfo('Phases sync job enqueued via cron', { jobId: job.id });
          } catch (error) {
            logError('Cron job failed: phases-sync', error);
          }
        },
      }),
    );
}
