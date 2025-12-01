import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from './data-sync.queue';
import { logError, logInfo } from '../utils/logger';

/**
 * Data Sync Cron Jobs
 *
 * Handles scheduled synchronization of core FPL data:
 * - Events sync (6:30 AM daily)
 * - Teams sync (6:34 AM daily)
 * - Players sync (6:36 AM daily)
 * - Phases sync (6:38 AM daily)
 *
 * All jobs run in the early morning to get fresh data before the day starts.
 */

export function registerDataSyncJobs(app: Elysia) {
  return (
    app
      // Events sync - Daily at 6:30 AM
      .use(
        cron({
          name: 'events-sync',
          pattern: '30 6 * * *',
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

      // Teams sync - Daily at 6:34 AM
      .use(
        cron({
          name: 'teams-sync',
          pattern: '34 6 * * *',
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

      // Players sync - Daily at 6:36 AM
      .use(
        cron({
          name: 'players-sync',
          pattern: '36 6 * * *',
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

      // Phases sync - Daily at 6:38 AM
      .use(
        cron({
          name: 'phases-sync',
          pattern: '38 6 * * *',
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
  );
}
