import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import {
  entryInfos,
  leagueEventResults,
  type DbLeagueEventResultInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import { acquireEntrySeasonWriteFence } from './entry-event-transfers';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;
export type LeagueEventResultEvidenceInsert = DbLeagueEventResultInsert & {
  sourceCheckedAt: Date;
};

export const createLeagueEventResultsRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findEntryIdsByLeagueEvent: async (
      leagueId: number,
      leagueType: DbLeagueEventResultInsert['leagueType'],
      eventId: number,
      entryIds: number[],
      freshAfter?: Date,
    ): Promise<number[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(entryIds));
        const results: number[] = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          const chunk = uniqueIds.slice(index, index + 1000);
          const conditions = [
            eq(leagueEventResults.leagueId, leagueId),
            eq(leagueEventResults.leagueType, leagueType),
            eq(leagueEventResults.eventId, eventId),
            inArray(leagueEventResults.entryId, chunk),
          ];
          if (freshAfter) conditions.push(gte(leagueEventResults.sourceCheckedAt, freshAfter));
          const rows = await db
            .select({ entryId: leagueEventResults.entryId })
            .from(leagueEventResults)
            .where(and(...conditions));
          results.push(...rows.map((row) => row.entryId));
        }
        return results;
      } catch (error) {
        logError('Failed to find league event result checkpoints', error, {
          leagueId,
          leagueType,
          eventId,
          count: entryIds.length,
        });
        throw new DatabaseError(
          'Failed to find league event result checkpoints',
          'LEAGUE_EVENT_RESULTS_FIND_ERROR',
          error as Error,
        );
      }
    },

    upsertBatch: async (
      results: LeagueEventResultEvidenceInsert[],
      checkpointSeason?: string,
    ): Promise<number> => {
      if (results.length === 0) {
        return 0;
      }

      try {
        if (checkpointSeason !== undefined && !/^\d{4}$/.test(checkpointSeason)) {
          throw new Error('A valid four-digit checkpoint season is required');
        }

        const persist = async (db: DbOrTransaction, values: LeagueEventResultEvidenceInsert[]) => {
          if (values.length === 0) return 0;
          await db
            .insert(leagueEventResults)
            .values(values)
            .onConflictDoUpdate({
              target: [
                leagueEventResults.leagueId,
                leagueEventResults.leagueType,
                leagueEventResults.eventId,
                leagueEventResults.entryId,
              ],
              // A slower run may finish after a newer run has already written
              // corrected source data. Never let that older evidence overwrite
              // the newer canonical row or advance its checkpoint backwards.
              where: sql`
                ${leagueEventResults.sourceCheckedAt} IS NULL
                OR ${leagueEventResults.sourceCheckedAt} <= excluded.source_checked_at
              `,
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
                sourceCheckedAt: sql`excluded.source_checked_at`,
                updatedAt: new Date(),
              },
            });
          return values.length;
        };

        const db = await getDbInstance();
        let persisted = results.length;
        if (checkpointSeason !== undefined) {
          persisted = await db.transaction(async (tx) => {
            const entryIds = [...new Set(results.map((result) => result.entryId))];
            await acquireEntrySeasonWriteFence(tx, entryIds, checkpointSeason);
            const eligibleEntries = await tx
              .select({ id: entryInfos.id })
              .from(entryInfos)
              .where(
                and(
                  inArray(entryInfos.id, entryIds),
                  eq(entryInfos.entrySnapshotSyncedSeason, checkpointSeason),
                ),
              )
              .for('share');
            const eligibleIds = new Set(eligibleEntries.map((entry) => entry.id));
            return persist(
              tx,
              results.filter((result) => eligibleIds.has(result.entryId)),
            );
          });
        } else {
          persisted = await persist(db as DbOrTransaction, results);
        }

        logInfo('Upserted league event results', { count: persisted });
        return persisted;
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
