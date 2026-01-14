import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventCupResults,
  type DbEntryEventCupResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EntryEventCupResultsRepository {
  private db?: DatabaseInstance;

  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async upsertBatch(results: DbEntryEventCupResultInsert[]): Promise<number> {
    if (results.length === 0) {
      return 0;
    }

    try {
      const db = await this.getDbInstance();
      await db
        .insert(entryEventCupResults)
        .values(results)
        .onConflictDoUpdate({
          target: [entryEventCupResults.entryId, entryEventCupResults.eventId],
          set: {
            entryName: sql`excluded.entry_name`,
            playerName: sql`excluded.player_name`,
            eventPoints: sql`excluded.event_points`,
            againstEntryId: sql`excluded.against_entry_id`,
            againstEntryName: sql`excluded.against_entry_name`,
            againstPlayerName: sql`excluded.against_player_name`,
            againstEventPoints: sql`excluded.against_event_points`,
            result: sql`excluded.result`,
            updatedAt: new Date(),
          },
        });

      logInfo('Upserted entry event cup results', { count: results.length });
      return results.length;
    } catch (error) {
      logError('Failed to upsert entry event cup results', error, { count: results.length });
      throw new DatabaseError(
        'Failed to upsert entry event cup results',
        'ENTRY_EVENT_CUP_RESULTS_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryEventCupResultsRepository = new EntryEventCupResultsRepository();
