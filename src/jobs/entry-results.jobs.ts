import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { syncEntryEventResults } from '../services/entries.service';
import { getDb } from '../db/singleton';
import { entryInfos } from '../db/schemas/index.schema';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Results Cron Jobs
 *
 * Syncs per-GW results (points, ranks, captain, etc.) for current event.
 */
export function registerEntryResultsJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-results-daily',
      pattern: '46 6 * * *', // Daily 06:46 AM
      async run() {
        logInfo('Cron job started: entry-event-results-daily');
        try {
          const db = await getDb();
          const ids = await db.select({ id: entryInfos.id }).from(entryInfos);
          logInfo('Found entries for results sync', { count: ids.length });
          for (const { id } of ids) {
            try {
              await syncEntryEventResults(id);
            } catch (err) {
              logError('Results sync failed for entry', err, { entryId: id });
            }
          }
          logInfo('Cron job completed: entry-event-results-daily', { synced: ids.length });
        } catch (error) {
          logError('Cron job failed: entry-event-results-daily', error);
        }
      },
    }),
  );
}

