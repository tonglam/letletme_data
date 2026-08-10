import { eq } from 'drizzle-orm';

import { playerSeasonSummariesInReporting } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

export type PlayerSeasonSummary = Readonly<typeof playerSeasonSummariesInReporting.$inferSelect>;

export const createPlayerSeasonSummaryRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findAll: async (season: FplSeasonRef): Promise<PlayerSeasonSummary[]> => {
      try {
        const db = await getDbInstance();
        return await db
          .select()
          .from(playerSeasonSummariesInReporting)
          .where(eq(playerSeasonSummariesInReporting.seasonId, season.seasonId))
          .orderBy(playerSeasonSummariesInReporting.elementId);
      } catch (error) {
        logError('Failed to retrieve player season summaries', error, {
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to retrieve player season summaries',
          'FIND_PLAYER_SEASON_SUMMARIES_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const playerSeasonSummaryRepository = createPlayerSeasonSummaryRepository();
