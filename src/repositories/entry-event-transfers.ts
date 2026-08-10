import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  entriesInCompetition,
  entryEventTransfersInCompetition,
  type DbEntryEventTransfer,
  type DbEntryEventTransferInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type TransactionHandle } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryTransfersResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export const ENTRY_SEASON_SYNC_LOCK_NAMESPACE = 1_102_204_716;

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

function mapTransfer(
  row: typeof entryEventTransfersInCompetition.$inferSelect,
): DbEntryEventTransfer {
  return { ...row, id: row.transferId };
}

export async function acquireEntrySeasonWriteFence(
  tx: TransactionHandle,
  season: FplSeasonRef,
  entryIds: readonly number[],
): Promise<void> {
  const uniqueEntryIds = [...new Set(entryIds)].sort((left, right) => left - right);
  for (const entryId of uniqueEntryIds) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
        ${ENTRY_SEASON_SYNC_LOCK_NAMESPACE},
        hashint8((${season.seasonId}::bigint << 32) + ${entryId}::bigint)
      )`,
    );
  }
}

async function lockEntry(
  tx: TransactionHandle,
  season: FplSeasonRef,
  entryId: number,
): Promise<void> {
  await acquireEntrySeasonWriteFence(tx, season, [entryId]);
  const rows = await tx
    .select({ entryId: entriesInCompetition.entryId })
    .from(entriesInCompetition)
    .where(
      and(
        eq(entriesInCompetition.seasonId, season.seasonId),
        eq(entriesInCompetition.entryId, entryId),
      ),
    )
    .for('update');
  if (rows.length !== 1) {
    throw new Error(`Entry ${entryId} is not persisted for explicit season ${season.seasonCode}`);
  }
}

export async function withEntrySeasonSyncTransaction<T>(
  season: FplSeasonRef,
  entryId: number,
  operation: (tx: TransactionHandle) => Promise<T>,
): Promise<T> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await lockEntry(tx, season, entryId);
    return operation(tx);
  });
}

export function buildTransferReplacementRows({
  season,
  entryId,
  eventId,
  transfers,
  existing,
  pointsByElement,
  elementInPlayed,
  defaultPoints = null,
}: {
  season: FplSeasonRef;
  entryId: number;
  eventId: number;
  transfers: RawFPLEntryTransfersResponse;
  existing: readonly DbEntryEventTransfer[];
  pointsByElement?: Map<number, number>;
  elementInPlayed?: boolean | null;
  defaultPoints?: number | null;
}): DbEntryEventTransferInsert[] {
  const existingBySignature = new Map(existing.map((row) => [transferSignature(row), row]));

  return transfers
    .map((transfer): DbEntryEventTransferInsert => {
      const transferTime = new Date(transfer.time);
      if (!Number.isFinite(transferTime.getTime())) {
        throw new Error(`Invalid transfer timestamp for entry ${entryId}`);
      }
      const previous = existingBySignature.get(
        transferSignature({
          eventId: transfer.event,
          elementInId: transfer.element_in,
          elementOutId: transfer.element_out,
          transferTime,
        }),
      );
      const isTargetEvent = transfer.event === eventId;

      return {
        seasonId: season.seasonId,
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
    .sort((left, right) => {
      const timeDifference =
        (left.transferTime as Date).getTime() - (right.transferTime as Date).getTime();
      if (timeDifference !== 0) return timeDifference;
      return left.eventId - right.eventId;
    });
}

export const createEntryEventTransfersRepository = (dbInstance?: DbHandle) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findEntryIdsNeedingSync: async (
      season: FplSeasonRef,
      entryIds: number[],
      targetEventId: number,
    ): Promise<number[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const results: number[] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const rows = await db
            .select({
              entryId: entriesInCompetition.entryId,
              syncedThroughEventId: entriesInCompetition.transfersSyncedThroughEventId,
            })
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                inArray(entriesInCompetition.entryId, chunk),
              ),
            );
          const checkpoints = new Map(
            rows.map((row) => [row.entryId, row.syncedThroughEventId] as const),
          );
          results.push(
            ...chunk.filter((entryId) => {
              const checkpoint = checkpoints.get(entryId);
              return checkpoint === undefined || checkpoint === null || checkpoint < targetEventId;
            }),
          );
        }
        return results;
      } catch (error) {
        logError('Failed to find entry transfer sync gaps', error, {
          season: season.seasonCode,
          count: entryIds.length,
          targetEventId,
        });
        throw new DatabaseError(
          'Failed to find entry transfer sync gaps',
          'ENTRY_EVENT_TRANSFERS_SYNC_GAPS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    replaceForEvent: async (
      season: FplSeasonRef,
      entryId: number,
      eventId: number,
      transfers: RawFPLEntryTransfersResponse,
      pointsByElement?: Map<number, number>,
      options?: {
        elementInPlayed?: boolean | null;
        defaultPoints?: number | null;
        checkpointThroughEventId?: number;
        sourceCheckedAt: string | Date;
        persistEventData?: (tx: TransactionHandle) => Promise<void>;
      },
    ): Promise<boolean> => {
      try {
        const db = await getDbInstance();
        const checkpointThroughEventId = options?.checkpointThroughEventId ?? eventId;
        if (
          !Number.isInteger(checkpointThroughEventId) ||
          checkpointThroughEventId < 0 ||
          checkpointThroughEventId > eventId
        ) {
          throw new Error('Transfer checkpoint event must be between zero and the synced event');
        }
        const sourceCheckedAt =
          options?.sourceCheckedAt instanceof Date
            ? options.sourceCheckedAt
            : options?.sourceCheckedAt
              ? new Date(options.sourceCheckedAt)
              : null;
        if (!sourceCheckedAt || !Number.isFinite(sourceCheckedAt.getTime())) {
          throw new Error('A valid transfer source checkpoint is required');
        }

        const accepted = await db.transaction(async (tx) => {
          await lockEntry(tx, season, entryId);
          const [sourceOrder] = await tx
            .select({ sourceCheckedAt: entriesInCompetition.transfersSourceCheckedAt })
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                eq(entriesInCompetition.entryId, entryId),
              ),
            );
          if (sourceOrder?.sourceCheckedAt && sourceOrder.sourceCheckedAt >= sourceCheckedAt) {
            logInfo('Rejected stale entry transfer history replacement', {
              season: season.seasonCode,
              entryId,
              eventId,
              sourceCheckedAt: sourceCheckedAt.toISOString(),
              winnerSourceCheckedAt: sourceOrder.sourceCheckedAt.toISOString(),
            });
            return false;
          }

          await options?.persistEventData?.(tx);
          const transferScope = and(
            eq(entryEventTransfersInCompetition.seasonId, season.seasonId),
            eq(entryEventTransfersInCompetition.entryId, entryId),
          );
          const existingRows = await tx
            .select()
            .from(entryEventTransfersInCompetition)
            .where(transferScope);
          const existing = existingRows.map(mapTransfer);
          await tx.delete(entryEventTransfersInCompetition).where(transferScope);

          const rows = buildTransferReplacementRows({
            season,
            entryId,
            eventId,
            transfers,
            existing,
            pointsByElement,
            elementInPlayed: options?.elementInPlayed,
            defaultPoints: options?.defaultPoints ?? null,
          });
          if (rows.length > 0) {
            await tx.insert(entryEventTransfersInCompetition).values(rows);
          }

          const persisted = await tx
            .select({
              eventId: entryEventTransfersInCompetition.eventId,
              elementInId: entryEventTransfersInCompetition.elementInId,
              elementOutId: entryEventTransfersInCompetition.elementOutId,
              transferTime: entryEventTransfersInCompetition.transferTime,
            })
            .from(entryEventTransfersInCompetition)
            .where(transferScope);
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
            throw new Error('Full transfer history failed canonical replacement verification');
          }

          await tx
            .update(entriesInCompetition)
            .set({
              transfersSyncedThroughEventId: sql`GREATEST(
                  COALESCE(${entriesInCompetition.transfersSyncedThroughEventId}, 0),
                  ${checkpointThroughEventId}
                )`,
              transfersSourceCheckedAt: sourceCheckedAt,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                eq(entriesInCompetition.entryId, entryId),
              ),
            );
          return true;
        });

        logInfo('Replaced entry event transfers', {
          season: season.seasonCode,
          entryId,
          eventId,
          accepted,
        });
        return accepted;
      } catch (error) {
        logError('Failed to upsert entry event transfers', error, {
          season: season.seasonCode,
          entryId,
          eventId,
        });
        throw new DatabaseError(
          'Failed to upsert entry event transfers',
          'ENTRY_EVENT_TRANSFERS_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByEventAndEntryIds: async (
      season: FplSeasonRef,
      eventId: number,
      entryIds: number[],
    ): Promise<DbEntryEventTransfer[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueEntryIds = Array.from(new Set(entryIds));
        const results: DbEntryEventTransfer[] = [];
        for (let index = 0; index < uniqueEntryIds.length; index += 1000) {
          const chunk = uniqueEntryIds.slice(index, index + 1000);
          const rows = await db
            .select()
            .from(entryEventTransfersInCompetition)
            .where(
              and(
                eq(entryEventTransfersInCompetition.seasonId, season.seasonId),
                eq(entryEventTransfersInCompetition.eventId, eventId),
                inArray(entryEventTransfersInCompetition.entryId, chunk),
              ),
            );
          results.push(...rows.map(mapTransfer));
        }
        return results;
      } catch (error) {
        logError('Failed to retrieve entry event transfers', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to retrieve entry event transfers',
          'ENTRY_EVENT_TRANSFERS_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    updateBatchById: async (
      season: FplSeasonRef,
      updates: Array<{
        id: number;
        entryId?: number;
        elementInPoints: number | null;
        elementOutPoints: number | null;
        elementInPlayed: boolean | null;
      }>,
    ): Promise<number> => {
      if (updates.length === 0) return 0;

      try {
        const db = await getDbInstance();
        const payload = JSON.stringify(
          updates.map((update) => ({
            id: update.id,
            in_points: update.elementInPoints,
            out_points: update.elementOutPoints,
            in_played_flag: update.elementInPlayed === null ? null : update.elementInPlayed ? 1 : 0,
          })),
        );

        const updatedCount = await db.transaction(async (tx) => {
          const entryIds = updates
            .map((update) => update.entryId)
            .filter((entryId): entryId is number => entryId !== undefined);
          if (entryIds.length > 0) {
            await acquireEntrySeasonWriteFence(tx, season, entryIds);
          }
          const expectedIds = [...new Set(updates.map((update) => update.id))];
          const lockedRows = await tx
            .select({ transferId: entryEventTransfersInCompetition.transferId })
            .from(entryEventTransfersInCompetition)
            .where(
              and(
                eq(entryEventTransfersInCompetition.seasonId, season.seasonId),
                inArray(entryEventTransfersInCompetition.transferId, expectedIds),
              ),
            )
            .for('update');
          if (lockedRows.length !== expectedIds.length) {
            throw new Error('Entry event transfer rows changed while waiting for the write fence');
          }

          const updatedRows = (await tx.execute(sql`
            UPDATE ${entryEventTransfersInCompetition} AS transfer
            SET element_in_points = data.in_points,
                element_out_points = data.out_points,
                element_in_played = CASE
                  WHEN data.in_played_flag IS NULL THEN NULL
                  ELSE data.in_played_flag = 1
                END,
                updated_at = clock_timestamp()
            FROM (
              SELECT data.id, data.in_points, data.out_points, data.in_played_flag
              FROM jsonb_to_recordset(${payload}::jsonb) AS data(
                id int,
                in_points int,
                out_points int,
                in_played_flag int
              )
            ) AS data
            WHERE transfer.season_id = ${season.seasonId}
              AND transfer.transfer_id = data.id
            RETURNING transfer.transfer_id
          `)) as unknown as Array<{ transferId: number }>;
          if (updatedRows.length !== expectedIds.length) {
            throw new Error('Entry event transfer update lost canonical rows');
          }
          return updatedRows.length;
        });

        logInfo('Updated entry event transfers', {
          season: season.seasonCode,
          count: updates.length,
        });
        return updatedCount;
      } catch (error) {
        logError('Failed to update entry event transfers', error, {
          season: season.seasonCode,
          count: updates.length,
        });
        throw new DatabaseError(
          'Failed to update entry event transfers',
          'ENTRY_EVENT_TRANSFERS_UPDATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryEventTransfersRepository = createEntryEventTransfersRepository();
