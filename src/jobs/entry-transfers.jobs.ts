import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { syncEntryEventTransfers } from '../services/entries.service';
import { getDb } from '../db/singleton';
import { entryInfos } from '../db/schemas/index.schema';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Transfers Cron Jobs
 *
 * Syncs transfers for all known entries in the current event.
 */
export function registerEntryTransfersJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-transfers-daily',
      pattern: '44 6 * * *', // Daily 06:44 AM
      async run() {
        logInfo('Cron job started: entry-event-transfers-daily');
        try {
          const db = await getDb();
          const ids = await db.select({ id: entryInfos.id }).from(entryInfos);
          logInfo('Found entries for transfers sync', { count: ids.length });
          for (const { id } of ids) {
            try {
              await syncEntryEventTransfers(id);
            } catch (err) {
              logError('Transfers sync failed for entry', err, { entryId: id });
            }
          }
          logInfo('Cron job completed: entry-event-transfers-daily', { synced: ids.length });
        } catch (error) {
          logError('Cron job failed: entry-event-transfers-daily', error);
        }
      },
    }),
  );
}

