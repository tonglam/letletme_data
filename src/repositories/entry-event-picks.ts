import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { entryEventPicks, type DbEntryEventPickInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryEventPicksResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

function mapChip(
  chip: RawFPLEntryEventPicksResponse['active_chip'],
): 'n/a' | 'wildcard' | 'freehit' | 'bboost' | '3xc' | 'manager' {
  return chip ?? 'n/a';
}

export class EntryEventPicksRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async upsertFromPicks(
    entryId: number,
    eventId: number,
    picks: RawFPLEntryEventPicksResponse,
  ): Promise<void> {
    try {
      const db = await this.getDbInstance();
      const insert: DbEntryEventPickInsert = {
        entryId,
        eventId,
        chip: mapChip(picks.active_chip),
        picks: picks.picks as unknown,
        transfers: picks.entry_history.event_transfers,
        transfersCost: picks.entry_history.event_transfers_cost,
      };

      await db
        .insert(entryEventPicks)
        .values(insert)
        .onConflictDoUpdate({
          target: [entryEventPicks.entryId, entryEventPicks.eventId],
          set: {
            chip: insert.chip,
            picks: insert.picks,
            transfers: insert.transfers,
            transfersCost: insert.transfersCost,
          },
        });
      logInfo('Upserted entry event picks', { entryId, eventId, chip: insert.chip });
    } catch (error) {
      logError('Failed to upsert entry event picks', error, { entryId, eventId });
      throw new DatabaseError(
        'Failed to upsert entry event picks',
        'ENTRY_EVENT_PICKS_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryEventPicksRepository = new EntryEventPicksRepository();
