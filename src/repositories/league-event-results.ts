import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { leagueEventResults, type DbLeagueEventResultInsert } from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const createLeagueEventResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    upsertBatch: async (results: DbLeagueEventResultInsert[]): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        const db = await getDbInstance();
        await db
          .insert(leagueEventResults)
          .values(results)
          .onConflictDoUpdate({
            target: [
              leagueEventResults.leagueId,
              leagueEventResults.leagueType,
              leagueEventResults.eventId,
              leagueEventResults.entryId,
            ],
            set: {
              entryName: sql`excluded.entry_name`,
              playerName: sql`excluded.player_name`,
              overallPoints: sql`excluded.overall_points`,
              overallRank: sql`excluded.overall_rank`,
              teamValue: sql`excluded.team_value`,
              bank: sql`excluded.bank`,
              eventPoints: sql`excluded.event_points`,
              eventTransfers: sql`excluded.event_transfers`,
              eventTransfersCost: sql`excluded.event_transfers_cost`,
              eventNetPoints: sql`excluded.event_net_points`,
              eventBenchPoints: sql`excluded.event_bench_points`,
              eventAutoSubPoints: sql`excluded.event_auto_sub_points`,
              eventRank: sql`excluded.event_rank`,
              eventChip: sql`excluded.event_chip`,
              captainId: sql`excluded.captain_id`,
              captainPoints: sql`excluded.captain_points`,
              captainBlank: sql`excluded.captain_blank`,
              viceCaptainId: sql`excluded.vice_captain_id`,
              viceCaptainPoints: sql`excluded.vice_captain_points`,
              viceCaptainBlank: sql`excluded.vice_captain_blank`,
              playedCaptainId: sql`excluded.played_captain_id`,
              highestScoreElementId: sql`excluded.highest_score_element_id`,
              highestScorePoints: sql`excluded.highest_score_points`,
              highestScoreBlank: sql`excluded.highest_score_blank`,
              updatedAt: new Date(),
            },
          });

        logInfo('Upserted league event results', { count: results.length });
        return results.length;
      } catch (error) {
        logError('Failed to upsert league event results', error, { count: results.length });
        throw new DatabaseError(
          'Failed to upsert league event results',
          'LEAGUE_EVENT_RESULTS_UPSERT_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const leagueEventResultsRepository = createLeagueEventResultsRepository();
