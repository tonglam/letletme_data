import { cron } from '@elysiajs/cron';
import type { Elysia } from 'elysia';

import { syncEntryEventPicks } from '../services/entries.service';
import { getDb } from '../db/singleton';
import { entryInfos } from '../db/schemas/index.schema';
import { logError, logInfo } from '../utils/logger';

/**
 * Entry Event Picks Cron Jobs
 *
 * Syncs latest picks for all known entries in `entry_infos` for the current event.
 * Scheduled daily after core data syncs.
 */
export function registerEntryPicksJobs(app: Elysia) {
  return app.use(
    cron({
      name: 'entry-event-picks-daily',
      pattern: '42 6 * * *', // Daily 06:42 AM (after other syncs)
      async run() {
        logInfo('Cron job started: entry-event-picks-daily');
        try {
          const db = await getDb();
          const ids = await db.select({ id: entryInfos.id }).from(entryInfos);
          logInfo('Found entries for picks sync', { count: ids.length });
          for (const { id } of ids) {
            try {
              await syncEntryEventPicks(id);
            } catch (err) {
              logError('Picks sync failed for entry', err, { entryId: id });
            }
          }
          logInfo('Cron job completed: entry-event-picks-daily', { synced: ids.length });
        } catch (error) {
          logError('Cron job failed: entry-event-picks-daily', error);
        }
      },
    }),
  );
}
