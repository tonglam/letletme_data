import { and, eq, inArray } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventTransfers,
  type DbEntryEventTransfer,
  type DbEntryEventTransferInsert,
} from '../db/schemas/index.schema';
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
    options?: {
      elementInPlayed?: boolean | null;
      defaultPoints?: number | null;
      onConflict?: 'update' | 'ignore';
    },
  ): Promise<void> {
    try {
      const db = await this.getDbInstance();
      const byEvent = transfers.filter((t) => t.event === eventId);
      if (byEvent.length === 0) {
        logInfo('No transfers to insert for event', { entryId, eventId });
        return;
      }

      // Choose the most recent transfer within the event
      const latest = byEvent.reduce(
        (acc, t) => (new Date(t.time) > new Date(acc.time) ? t : acc),
        byEvent[0],
      );

      const fallbackPoints = options?.defaultPoints ?? null;
      const inPts = pointsByElement?.get(latest.element_in) ?? fallbackPoints;
      const outPts = pointsByElement?.get(latest.element_out) ?? fallbackPoints;
      const elementInPlayed = options?.elementInPlayed ?? null;

      const row: DbEntryEventTransferInsert = {
        entryId,
        eventId,
        elementInId: latest.element_in,
        elementInCost: latest.element_in_cost ?? null,
        elementInPoints: inPts,
        elementInPlayed,
        elementOutId: latest.element_out,
        elementOutCost: latest.element_out_cost ?? null,
        elementOutPoints: outPts,
        transferTime: new Date(latest.time),
      };

      const insertQuery = db.insert(entryEventTransfers).values(row);
      if (options?.onConflict === 'ignore') {
        await insertQuery.onConflictDoNothing({
          target: [entryEventTransfers.entryId, entryEventTransfers.eventId],
        });
      } else {
        await insertQuery.onConflictDoUpdate({
          target: [entryEventTransfers.entryId, entryEventTransfers.eventId],
          set: {
            elementInId: row.elementInId,
            elementInCost: row.elementInCost,
            elementInPoints: row.elementInPoints,
            elementInPlayed: row.elementInPlayed,
            elementOutId: row.elementOutId,
            elementOutCost: row.elementOutCost,
            elementOutPoints: row.elementOutPoints,
            transferTime: row.transferTime,
          },
        });
      }

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

  async findByEventAndEntryIds(
    eventId: number,
    entryIds: number[],
  ): Promise<DbEntryEventTransfer[]> {
    if (entryIds.length === 0) {
      return [];
    }

    try {
      const db = await this.getDbInstance();
      const uniqueEntryIds = Array.from(new Set(entryIds));
      const chunks: number[][] = [];
      for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
        chunks.push(uniqueEntryIds.slice(index, index + 1000));
      }

      const results: DbEntryEventTransfer[] = [];
      for (const chunk of chunks) {
        const rows = await db
          .select()
          .from(entryEventTransfers)
          .where(
            and(
              eq(entryEventTransfers.eventId, eventId),
              inArray(entryEventTransfers.entryId, chunk),
            ),
          );
        results.push(...rows);
      }

      logInfo('Retrieved entry event transfers', { eventId, count: results.length });
      return results;
    } catch (error) {
      logError('Failed to retrieve entry event transfers', error, { eventId });
      throw new DatabaseError(
        'Failed to retrieve entry event transfers',
        'ENTRY_EVENT_TRANSFERS_FIND_ERROR',
        error as Error,
      );
    }
  }

  async updateBatchById(
    updates: Array<{
      id: number;
      elementInPoints: number | null;
      elementOutPoints: number | null;
      elementInPlayed: boolean | null;
    }>,
  ): Promise<number> {
    if (updates.length === 0) {
      return 0;
    }

    try {
      const db = await this.getDbInstance();
      await db.transaction(async (tx) => {
        for (const update of updates) {
          await tx
            .update(entryEventTransfers)
            .set({
              elementInPoints: update.elementInPoints,
              elementOutPoints: update.elementOutPoints,
              elementInPlayed: update.elementInPlayed,
            })
            .where(eq(entryEventTransfers.id, update.id));
        }
      });

      logInfo('Updated entry event transfers', { count: updates.length });
      return updates.length;
    } catch (error) {
      logError('Failed to update entry event transfers', error, { count: updates.length });
      throw new DatabaseError(
        'Failed to update entry event transfers',
        'ENTRY_EVENT_TRANSFERS_UPDATE_ERROR',
        error as Error,
      );
    }
  }
}

export const entryEventTransfersRepository = new EntryEventTransfersRepository();
