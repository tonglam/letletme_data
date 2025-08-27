import { cron } from '@elysiajs/cron';
import { Elysia } from 'elysia';

import { syncEvents } from '../services/events.service';
import { syncPhases } from '../services/phases.service';
import { syncPlayers } from '../services/players.service';
import { syncTeams } from '../services/teams.service';
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
              const result = await syncEvents();
              logInfo('Cron job completed: events-sync', result);
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
              const result = await syncTeams();
              logInfo('Cron job completed: teams-sync', result);
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
              const result = await syncPlayers();
              logInfo('Cron job completed: players-sync', result);
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
              const result = await syncPhases();
              logInfo('Cron job completed: phases-sync', result);
            } catch (error) {
              logError('Cron job failed: phases-sync', error);
            }
          },
        }),
      )
  );
}
