import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { entryEventTransfers, type DbEntryEventTransferInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { RawFPLEntryTransfersResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export class EntryEventTransfersRepository {
  private db?: DatabaseInstance;
  constructor(dbInstance?: DatabaseInstance) {
    this.db = dbInstance;
  }

  private async getDbInstance() {
    return this.db || (await getDb());
  }

  async replaceForEvent(
    entryId: number,
    eventId: number,
    transfers: RawFPLEntryTransfersResponse,
    pointsByElement?: Map<number, number>,
  ): Promise<void> {
    try {
      const db = await this.getDbInstance();
      const byEvent = transfers.filter((t) => t.event === eventId);
      if (byEvent.length === 0) {
        logInfo('No transfers to insert for event', { entryId, eventId });
        return;
      }

      // Choose the most recent transfer within the event
      const latest = byEvent.reduce((acc, t) => (new Date(t.time) > new Date(acc.time) ? t : acc), byEvent[0]);

      const inPts = pointsByElement?.get(latest.element_in) ?? null;
      const outPts = pointsByElement?.get(latest.element_out) ?? null;

      const row: DbEntryEventTransferInsert = {
        entryId,
        eventId,
        elementInId: latest.element_in,
        elementInCost: latest.element_in_cost ?? null,
        elementInPoints: inPts,
        elementOutId: latest.element_out,
        elementOutCost: latest.element_out_cost ?? null,
        elementOutPoints: outPts,
        transferTime: new Date(latest.time),
      };

      await db
        .insert(entryEventTransfers)
        .values(row)
        .onConflictDoUpdate({
          target: [entryEventTransfers.entryId, entryEventTransfers.eventId],
          set: {
            elementInId: row.elementInId,
            elementInCost: row.elementInCost,
            elementInPoints: row.elementInPoints,
            elementOutId: row.elementOutId,
            elementOutCost: row.elementOutCost,
            elementOutPoints: row.elementOutPoints,
            transferTime: row.transferTime,
          },
        });

      logInfo('Upserted latest entry event transfer', { entryId, eventId });
    } catch (error) {
      logError('Failed to upsert entry event transfers', error, { entryId, eventId });
      throw new DatabaseError(
        'Failed to upsert entry event transfers',
        'ENTRY_EVENT_TRANSFERS_UPSERT_ERROR',
        error as Error,
      );
    }
  }
}

export const entryEventTransfersRepository = new EntryEventTransfersRepository();
