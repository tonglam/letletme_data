import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventTransfers,
  type DbEntryEventTransfer,
  type DbEntryEventTransferInsert,
} from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type { RawFPLEntryTransfersResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createEntryEventTransfersRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    replaceForEvent: async (
      entryId: number,
      eventId: number,
      transfers: RawFPLEntryTransfersResponse,
      pointsByElement?: Map<number, number>,
      options?: {
        elementInPlayed?: boolean | null;
        defaultPoints?: number | null;
        onConflict?: 'update' | 'ignore';
      },
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const byEvent = transfers.filter((t) => t.event === eventId);
        if (byEvent.length === 0) {
          logInfo('Replacing event transfers with an empty set', { entryId, eventId });
        }

        const fallbackPoints = options?.defaultPoints ?? null;
        const elementInPlayed = options?.elementInPlayed ?? null;

        // Replace the complete event atomically.  FPL returns the full
        // transfer history, so keeping only the latest row silently loses
        // wildcard/multiple-transfer activity and corrupts transfer costs.
        const rows: DbEntryEventTransferInsert[] = byEvent
          .slice()
          .sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime())
          .map((transfer) => ({
            entryId,
            eventId,
            elementInId: transfer.element_in,
            elementInCost: transfer.element_in_cost ?? null,
            elementInPoints: pointsByElement?.get(transfer.element_in) ?? fallbackPoints,
            elementInPlayed,
            elementOutId: transfer.element_out,
            elementOutCost: transfer.element_out_cost ?? null,
            elementOutPoints: pointsByElement?.get(transfer.element_out) ?? fallbackPoints,
            transferTime: new Date(transfer.time),
          }));

        // Keep a computed played flag when a later sync has no value to add.
        // The delete/insert runs in one transaction so readers see either
        // the previous complete set or the new complete set.
        await db.transaction(async (tx) => {
          const existing = await tx
            .select({
              transferTime: entryEventTransfers.transferTime,
              elementInId: entryEventTransfers.elementInId,
              elementOutId: entryEventTransfers.elementOutId,
              elementInPlayed: entryEventTransfers.elementInPlayed,
            })
            .from(entryEventTransfers)
            .where(
              and(
                eq(entryEventTransfers.entryId, entryId),
                eq(entryEventTransfers.eventId, eventId),
              ),
            );
          const existingPlayed = new Map(
            existing.map((row) => [
              `${row.transferTime.toISOString()}|${row.elementInId}|${row.elementOutId}`,
              row.elementInPlayed,
            ]),
          );
          const rowsWithPreservedFlags = rows.map((row) => ({
            ...row,
            elementInPlayed:
              row.elementInPlayed ??
              existingPlayed.get(
                `${row.transferTime.toISOString()}|${row.elementInId}|${row.elementOutId}`,
              ) ??
              null,
          }));
          await tx
            .delete(entryEventTransfers)
            .where(
              and(
                eq(entryEventTransfers.entryId, entryId),
                eq(entryEventTransfers.eventId, eventId),
              ),
            );
          if (rowsWithPreservedFlags.length === 0) return;
          const insertQuery = tx.insert(entryEventTransfers).values(rowsWithPreservedFlags);
          if (options?.onConflict === 'ignore') {
            await insertQuery.onConflictDoNothing({
              target: [
                entryEventTransfers.entryId,
                entryEventTransfers.eventId,
                entryEventTransfers.transferTime,
                entryEventTransfers.elementInId,
                entryEventTransfers.elementOutId,
              ],
            });
          } else {
            await insertQuery.onConflictDoUpdate({
              target: [
                entryEventTransfers.entryId,
                entryEventTransfers.eventId,
                entryEventTransfers.transferTime,
                entryEventTransfers.elementInId,
                entryEventTransfers.elementOutId,
              ],
              set: {
                elementInCost: sql`excluded.element_in_cost`,
                elementInPoints: sql`excluded.element_in_points`,
                elementInPlayed: sql`COALESCE(excluded.element_in_played, entry_event_transfers.element_in_played)`,
                elementOutCost: sql`excluded.element_out_cost`,
                elementOutPoints: sql`excluded.element_out_points`,
                updatedAt: new Date(),
              },
            });
          }
        });

        logInfo('Replaced entry event transfers', { entryId, eventId, count: rows.length });
      } catch (error) {
        logError('Failed to upsert entry event transfers', error, { entryId, eventId });
        throw new DatabaseError(
          'Failed to upsert entry event transfers',
          'ENTRY_EVENT_TRANSFERS_UPSERT_ERROR',
          error as Error,
        );
      }
    },

    findByEventAndEntryIds: async (
      eventId: number,
      entryIds: number[],
    ): Promise<DbEntryEventTransfer[]> => {
      if (entryIds.length === 0) {
        return [];
      }

      try {
        const db = await getDbInstance();
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
    },

    updateBatchById: async (
      updates: Array<{
        id: number;
        elementInPoints: number | null;
        elementOutPoints: number | null;
        elementInPlayed: boolean | null;
      }>,
    ): Promise<number> => {
      if (updates.length === 0) {
        return 0;
      }

      try {
        const client = await getDbClient();
        const ids = updates.map((u) => u.id);
        const inPoints = updates.map((u) => u.elementInPoints);
        const outPoints = updates.map((u) => u.elementOutPoints);
        const playedFlags = updates.map((u) =>
          u.elementInPlayed === null ? null : u.elementInPlayed ? 1 : 0,
        );

        await client`
          update entry_event_transfers as eet
          set element_in_points = data.in_points,
              element_out_points = data.out_points,
              element_in_played = case
                when data.in_played_flag is null then null
                else data.in_played_flag = 1
              end
          from (
            select
              unnest(${ids}::int[]) as id,
              unnest(${inPoints}::int[]) as in_points,
              unnest(${outPoints}::int[]) as out_points,
              unnest(${playedFlags}::int[]) as in_played_flag
          ) as data
          where eet.id = data.id
        `;

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
    },
  };
};

export const entryEventTransfersRepository = createEntryEventTransfersRepository();
