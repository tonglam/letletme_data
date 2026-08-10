import { and, eq, inArray, or } from 'drizzle-orm';

import {
  entriesInCompetition,
  entryEventCupResultsInCompetition,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { acquireEntrySeasonWriteFence } from './entry-event-transfers';

export interface EntryEventCupResultInput {
  readonly entryId: number;
  readonly eventId: number;
  readonly opponentEntryId: number | null;
  readonly opponentName: string | null;
  readonly result: 'win' | 'loss';
  readonly entryPoints: number;
  readonly opponentPoints: number;
  readonly entryName: string | null;
  readonly playerName: string | null;
  readonly againstEntryName: string | null;
  readonly againstPlayerName: string | null;
  readonly eventPoints: number | null;
  readonly againstEntryId: number | null;
  readonly againstEventPoints: number | null;
}

export const createEntryEventCupResultsRepository = (dbInstance?: DbHandle) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    replaceBatch: async (
      season: FplSeasonRef,
      results: readonly EntryEventCupResultInput[],
    ): Promise<number> => {
      if (results.length === 0) return 0;

      try {
        const db = await getDbInstance();
        const persisted = await db.transaction(async (tx) => {
          const entryIds = [...new Set(results.map((result) => result.entryId))];
          await acquireEntrySeasonWriteFence(tx, season, entryIds);
          const existingEntries = await tx
            .select({ entryId: entriesInCompetition.entryId })
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                inArray(entriesInCompetition.entryId, entryIds),
              ),
            )
            .for('share');
          if (new Set(existingEntries.map((entry) => entry.entryId)).size !== entryIds.length) {
            throw new Error('Cup results contain entries outside the explicit season roster');
          }

          const uniqueScopes = [
            ...new Map(
              results.map((result) => [`${result.entryId}:${result.eventId}`, result] as const),
            ).values(),
          ];
          if (uniqueScopes.length !== results.length) {
            throw new Error('Cup results contain duplicate entry/event scopes');
          }
          await tx
            .delete(entryEventCupResultsInCompetition)
            .where(
              and(
                eq(entryEventCupResultsInCompetition.seasonId, season.seasonId),
                or(
                  ...uniqueScopes.map((result) =>
                    and(
                      eq(entryEventCupResultsInCompetition.entryId, result.entryId),
                      eq(entryEventCupResultsInCompetition.eventId, result.eventId),
                    ),
                  ),
                ),
              ),
            );

          const rows = await tx
            .insert(entryEventCupResultsInCompetition)
            .values(
              results.map((result) => ({
                seasonId: season.seasonId,
                entryId: result.entryId,
                eventId: result.eventId,
                opponentEntryId: result.opponentEntryId,
                opponentName: result.opponentName,
                result: result.result,
                entryPoints: result.entryPoints,
                opponentPoints: result.opponentPoints,
                entryName: result.entryName,
                playerName: result.playerName,
                againstEntryName: result.againstEntryName,
                againstPlayerName: result.againstPlayerName,
                eventPoints: result.eventPoints,
                againstEntryId: result.againstEntryId,
                againstEventPoints: result.againstEventPoints,
                sourceSeasonCode: season.seasonCode,
              })),
            )
            .returning({ sourceResultId: entryEventCupResultsInCompetition.sourceResultId });
          return rows.length;
        });

        logInfo('Replaced entry event cup results', {
          season: season.seasonCode,
          requested: results.length,
          persisted,
        });
        return persisted;
      } catch (error) {
        logError('Failed to replace entry event cup results', error, {
          season: season.seasonCode,
          count: results.length,
        });
        throw new DatabaseError(
          'Failed to replace entry event cup results',
          'ENTRY_EVENT_CUP_RESULTS_REPLACE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const entryEventCupResultsRepository = createEntryEventCupResultsRepository();
