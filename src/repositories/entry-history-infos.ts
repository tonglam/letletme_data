import { and, eq, inArray } from 'drizzle-orm';

import {
  entriesInCompetition,
  entryPastSeasonsInCompetition,
  seasonsInFpl,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { explicitSeasonRef, type FplSeasonRef } from '../domain/fpl-season';
import type { RawFPLEntryHistoryResponse } from '../types';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

function seasonLabelToCode(label: string): string {
  const match = /^(\d{4})\/(\d{2})$/.exec(label);
  if (!match) throw new Error(`Unsupported FPL history season label: ${label}`);
  return `${match[1].slice(2)}${match[2]}`;
}

function seasonCodeToLabel(code: string): string {
  if (!/^\d{4}$/.test(code)) throw new Error(`Unsupported FPL season code: ${code}`);
  return `20${code.slice(0, 2)}/${code.slice(2)}`;
}

export const createEntryHistoryInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    upsertFromHistory: async (
      requestSeason: FplSeasonRef,
      entryId: number,
      history: RawFPLEntryHistoryResponse,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const rows = history.past.map((past) => {
          const historicalSeason = explicitSeasonRef(seasonLabelToCode(past.season_name));
          const totalPoints = past.total_points;
          const overallRank = past.rank;
          if (!Number.isInteger(totalPoints) || totalPoints < 0) {
            throw new Error(`Invalid total_points for history season ${past.season_name}`);
          }
          if (!Number.isInteger(overallRank) || overallRank < 0) {
            throw new Error(`Invalid rank for history season ${past.season_name}`);
          }
          return {
            entrySeasonId: requestSeason.seasonId,
            entryId,
            sourceSeasonId: historicalSeason.seasonId,
            sourceSeasonLabel: past.season_name,
            totalPoints,
            overallRank,
          };
        });
        const seasonIds = rows.map((row) => row.sourceSeasonId);
        if (new Set(seasonIds).size !== seasonIds.length) {
          throw new Error('Entry history contains duplicate source seasons');
        }
        const knownSeasons =
          seasonIds.length === 0
            ? []
            : await db
                .select({ seasonId: seasonsInFpl.seasonId, seasonCode: seasonsInFpl.seasonCode })
                .from(seasonsInFpl)
                .where(inArray(seasonsInFpl.seasonId, seasonIds));
        if (new Set(knownSeasons.map((season) => season.seasonId)).size !== seasonIds.length) {
          throw new Error('Entry history contains a season absent from fpl.seasons');
        }
        const knownSeasonCodes = new Map(
          knownSeasons.map((season) => [season.seasonId, season.seasonCode] as const),
        );
        for (const row of rows) {
          const sourceSeasonCode = knownSeasonCodes.get(row.sourceSeasonId);
          if (!sourceSeasonCode || seasonCodeToLabel(sourceSeasonCode) !== row.sourceSeasonLabel) {
            throw new Error(
              `Entry history season label does not match fpl.seasons for ${row.sourceSeasonId}`,
            );
          }
        }

        const parentEntry = await db
          .select({ entryId: entriesInCompetition.entryId })
          .from(entriesInCompetition)
          .where(
            and(
              eq(entriesInCompetition.seasonId, requestSeason.seasonId),
              eq(entriesInCompetition.entryId, entryId),
            ),
          );
        if (parentEntry.length !== 1) {
          throw new Error('Entry history parent entry was not found');
        }

        await db
          .delete(entryPastSeasonsInCompetition)
          .where(
            and(
              eq(entryPastSeasonsInCompetition.entrySeasonId, requestSeason.seasonId),
              eq(entryPastSeasonsInCompetition.entryId, entryId),
            ),
          );

        if (rows.length > 0) {
          await db.insert(entryPastSeasonsInCompetition).values(rows);
        }

        const updatedEntries = await db
          .update(entriesInCompetition)
          .set({
            pastSeasonsCheckedAt: new Date(),
            pastSeasonsCount: rows.length,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(entriesInCompetition.seasonId, requestSeason.seasonId),
              eq(entriesInCompetition.entryId, entryId),
            ),
          )
          .returning({ entryId: entriesInCompetition.entryId });
        if (updatedEntries.length !== 1) {
          throw new Error('Entry history parent entry was not found');
        }

        logInfo('Upserted entry history past seasons', {
          requestSeason: requestSeason.seasonCode,
          entryId,
          count: rows.length,
        });
      } catch (error) {
        logError('Failed to upsert entry history info', error, {
          requestSeason: requestSeason.seasonCode,
          entryId,
        });
        throw new DatabaseError(
          'Failed to upsert entry history info',
          'ENTRY_HISTORY_INFO_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findByEntry: async (season: FplSeasonRef, entryId: number) => {
      const db = await getDbInstance();
      return db
        .select()
        .from(entryPastSeasonsInCompetition)
        .where(
          and(
            eq(entryPastSeasonsInCompetition.entrySeasonId, season.seasonId),
            eq(entryPastSeasonsInCompetition.entryId, entryId),
          ),
        )
        .orderBy(entryPastSeasonsInCompetition.sourceSeasonId);
    },
  };
};

export const entryHistoryInfoRepository = createEntryHistoryInfoRepository();
