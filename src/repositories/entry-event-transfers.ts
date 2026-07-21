import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryEventTransfers,
  type DbEntryEventTransfer,
  type DbEntryEventTransferInsert,
} from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type { RawFPLEntryTransfersResponse } from '../types';
import { getConfig } from '../utils/config';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

const TRANSFER_LOCK_NAMESPACE = 1_102_204_716;

function transferSignature(transfer: {
  eventId: number;
  elementInId: number | null;
  elementOutId: number | null;
  transferTime: Date;
}): string {
  return [
    transfer.eventId,
    transfer.elementInId ?? '',
    transfer.elementOutId ?? '',
    transfer.transferTime.toISOString(),
  ].join(':');
}

export type TransferSyncMode = 'latest' | 'all';

export function buildTransferReplacementRows({
  entryId,
  eventId,
  transfers,
  existing,
  pointsByElement,
  elementInPlayed,
  defaultPoints = null,
  syncMode,
}: {
  entryId: number;
  eventId: number;
  transfers: RawFPLEntryTransfersResponse;
  existing: readonly DbEntryEventTransfer[];
  pointsByElement?: Map<number, number>;
  elementInPlayed?: boolean | null;
  defaultPoints?: number | null;
  syncMode: TransferSyncMode;
}): DbEntryEventTransferInsert[] {
  const byEvent = transfers.filter((transfer) => transfer.event === eventId);
  const selected =
    syncMode === 'all'
      ? transfers
      : byEvent.length === 0
        ? []
        : [
            byEvent.reduce((latest, candidate) =>
              new Date(candidate.time) > new Date(latest.time) ? candidate : latest,
            ),
          ];
  const existingBySignature = new Map(existing.map((row) => [transferSignature(row), row]));

  return selected
    .map((transfer): DbEntryEventTransferInsert => {
      const transferTime = new Date(transfer.time);
      const signature = transferSignature({
        eventId: transfer.event,
        elementInId: transfer.element_in,
        elementOutId: transfer.element_out,
        transferTime,
      });
      const previous = existingBySignature.get(signature);
      const isTargetEvent = transfer.event === eventId;

      return {
        entryId,
        eventId: transfer.event,
        elementInId: transfer.element_in,
        elementInCost: transfer.element_in_cost ?? null,
        elementInPoints:
          (isTargetEvent ? pointsByElement?.get(transfer.element_in) : undefined) ??
          transfer.element_in_points ??
          previous?.elementInPoints ??
          defaultPoints,
        elementInPlayed:
          (isTargetEvent ? elementInPlayed : undefined) ?? previous?.elementInPlayed ?? null,
        elementOutId: transfer.element_out,
        elementOutCost: transfer.element_out_cost ?? null,
        elementOutPoints:
          (isTargetEvent ? pointsByElement?.get(transfer.element_out) : undefined) ??
          transfer.element_out_points ??
          previous?.elementOutPoints ??
          defaultPoints,
        transferTime,
      };
    })
    .sort((a, b) => (a.transferTime as Date).getTime() - (b.transferTime as Date).getTime());
}

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
        syncMode?: 'latest' | 'all';
      },
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const syncMode = options?.syncMode ?? getConfig().TRANSFER_SYNC_MODE;
        const fallbackPoints = options?.defaultPoints ?? null;

        await db.transaction(async (tx) => {
          // Serialize replacement for one entry without blocking unrelated entries.
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${TRANSFER_LOCK_NAMESPACE}, ${entryId})`,
          );

          const existing = await tx
            .select()
            .from(entryEventTransfers)
            .where(
              syncMode === 'all'
                ? eq(entryEventTransfers.entryId, entryId)
                : and(
                    eq(entryEventTransfers.entryId, entryId),
                    eq(entryEventTransfers.eventId, eventId),
                  ),
            );
          await tx
            .delete(entryEventTransfers)
            .where(
              syncMode === 'all'
                ? eq(entryEventTransfers.entryId, entryId)
                : and(
                    eq(entryEventTransfers.entryId, entryId),
                    eq(entryEventTransfers.eventId, eventId),
                  ),
            );

          const rows = buildTransferReplacementRows({
            entryId,
            eventId,
            transfers,
            existing,
            pointsByElement,
            elementInPlayed: options?.elementInPlayed,
            defaultPoints: fallbackPoints,
            syncMode,
          });

          if (rows.length > 0) {
            // No explicit conflict target keeps latest-mode compatible before and
            // after the widened V2 unique index is deployed.
            await tx.insert(entryEventTransfers).values(rows).onConflictDoNothing();
          }

          if (syncMode === 'all') {
            const persisted = await tx
              .select({
                eventId: entryEventTransfers.eventId,
                elementInId: entryEventTransfers.elementInId,
                elementOutId: entryEventTransfers.elementOutId,
                transferTime: entryEventTransfers.transferTime,
              })
              .from(entryEventTransfers)
              .where(eq(entryEventTransfers.entryId, entryId));
            const expected = new Set(
              rows.map((row) =>
                transferSignature({
                  eventId: row.eventId,
                  elementInId: row.elementInId ?? null,
                  elementOutId: row.elementOutId ?? null,
                  transferTime: row.transferTime as Date,
                }),
              ),
            );
            const actual = new Set(persisted.map(transferSignature));
            if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
              throw new Error(
                'TRANSFER_SYNC_MODE=all requires the widened entry transfer unique index',
              );
            }
          }
        });

        logInfo('Replaced entry event transfers', {
          entryId,
          eventId,
          syncMode,
          count:
            syncMode === 'all'
              ? transfers.length
              : Number(transfers.some((transfer) => transfer.event === eventId)),
        });
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
