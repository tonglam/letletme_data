import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from './data-sync.queue';
import { logError, logInfo } from '../utils/logger';

/**
 * Data Sync Cron Jobs
 *
 * Handles scheduled synchronization of core FPL data:
 * - Events sync (6:35 AM daily)
 * - Fixtures sync (6:37 AM daily)
 * - Teams sync (6:40 AM daily)
 * - Players sync (6:43 AM daily)
 * - Player stats sync (9:40 AM daily)
 * - Phases sync (6:45 AM daily)
 * - Player values sync (9:30 AM daily)
 *
 * All jobs run in the early morning to get fresh data before the day starts.
 */

export function registerDataSyncJobs(app: Elysia) {
  return (
    app
      // Events sync - Daily at 6:35 AM
      .use(
        cron({
          name: 'events-sync',
          pattern: '35 6 * * *',
          async run() {
            logInfo('Cron job started: events-sync');
            try {
              const job = await enqueueEventsSyncJob('cron');
              logInfo('Events sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: events-sync', error);
            }
          },
        }),
      )

      // Fixtures sync - Daily at 6:37 AM
      .use(
        cron({
          name: 'fixtures-sync',
          pattern: '37 6 * * *',
          async run() {
            logInfo('Cron job started: fixtures-sync');
            try {
              const job = await enqueueFixturesSyncJob('cron');
              logInfo('Fixtures sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: fixtures-sync', error);
            }
          },
        }),
      )

      // Teams sync - Daily at 6:40 AM
      .use(
        cron({
          name: 'teams-sync',
          pattern: '40 6 * * *',
          async run() {
            logInfo('Cron job started: teams-sync');
            try {
              const job = await enqueueTeamsSyncJob('cron');
              logInfo('Teams sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: teams-sync', error);
            }
          },
        }),
      )

      // Players sync - Daily at 6:43 AM
      .use(
        cron({
          name: 'players-sync',
          pattern: '43 6 * * *',
          async run() {
            logInfo('Cron job started: players-sync');
            try {
              const job = await enqueuePlayersSyncJob('cron');
              logInfo('Players sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: players-sync', error);
            }
          },
        }),
      )

      // Player stats sync - Daily at 9:40 AM
      .use(
        cron({
          name: 'player-stats-sync',
          pattern: '40 9 * * *',
          async run() {
            logInfo('Cron job started: player-stats-sync');
            try {
              const job = await enqueuePlayerStatsSyncJob('cron');
              logInfo('Player stats sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: player-stats-sync', error);
            }
          },
        }),
      )

      // Phases sync - Daily at 6:45 AM
      .use(
        cron({
          name: 'phases-sync',
          pattern: '45 6 * * *',
          async run() {
            logInfo('Cron job started: phases-sync');
            try {
              const job = await enqueuePhasesSyncJob('cron');
              logInfo('Phases sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: phases-sync', error);
            }
          },
        }),
      )

      // Player values sync - Daily at 9:30 AM
      .use(
        cron({
          name: 'player-values-sync',
          pattern: '30 9 * * *',
          async run() {
            logInfo('Cron job started: player-values-sync');
            try {
              const job = await enqueuePlayerValuesSyncJob('cron');
              logInfo('Player values sync job enqueued via cron', { jobId: job.id });
            } catch (error) {
              logError('Cron job failed: player-values-sync', error);
            }
          },
        }),
      )
  );
}
