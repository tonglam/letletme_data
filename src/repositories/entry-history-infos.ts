import { and, eq, inArray, sql } from 'drizzle-orm';

import { entrySeasonHistoriesInCompetition, seasonsInFpl } from '../db/schemas/index.schema';
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

export const createEntryHistoryInfoRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    upsertFromHistory: async (
      requestSeason: FplSeasonRef,
      entryId: number,
      history: RawFPLEntryHistoryResponse,
    ): Promise<void> => {
      if (history.past.length === 0) return;

      try {
        const db = await getDbInstance();
        const rows = history.past.map((past) => {
          const historicalSeason = explicitSeasonRef(seasonLabelToCode(past.season_name));
          return {
            seasonId: historicalSeason.seasonId,
            entryId,
            sourceSeasonLabel: past.season_name,
            totalPoints: past.total_points ?? 0,
            overallRank: past.rank ?? 0,
          };
        });
        const seasonIds = [...new Set(rows.map((row) => row.seasonId))];
        const knownSeasons = await db
          .select({ seasonId: seasonsInFpl.seasonId })
          .from(seasonsInFpl)
          .where(inArray(seasonsInFpl.seasonId, seasonIds));
        if (new Set(knownSeasons.map((season) => season.seasonId)).size !== seasonIds.length) {
          throw new Error('Entry history contains a season absent from fpl.seasons');
        }

        await db
          .insert(entrySeasonHistoriesInCompetition)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              entrySeasonHistoriesInCompetition.seasonId,
              entrySeasonHistoriesInCompetition.entryId,
            ],
            set: {
              sourceSeasonLabel: sql`excluded.source_season_label`,
              totalPoints: sql`excluded.total_points`,
              overallRank: sql`excluded.overall_rank`,
              updatedAt: new Date(),
            },
          });

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
        .from(entrySeasonHistoriesInCompetition)
        .where(
          and(
            eq(entrySeasonHistoriesInCompetition.seasonId, season.seasonId),
            eq(entrySeasonHistoriesInCompetition.entryId, entryId),
          ),
        );
    },
  };
};

export const entryHistoryInfoRepository = createEntryHistoryInfoRepository();
