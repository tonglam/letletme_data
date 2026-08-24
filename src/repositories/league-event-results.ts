import { and, eq, gte, inArray, sql } from 'drizzle-orm';

import { entriesInCompetition, leagueEventResultsInCompetition } from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { acquireEntrySeasonWriteFence } from './entry-event-transfers';

type LeagueEventResultInsert = typeof leagueEventResultsInCompetition.$inferInsert;

export type LeagueEventResultEvidenceInsert = Omit<
  LeagueEventResultInsert,
  'seasonId' | 'sourceResultId' | 'sourceCheckedAt'
> & {
  readonly sourceCheckedAt: Date | string;
};

function sourceTimestamp(value: Date | string): Date {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error('A valid league result source timestamp is required');
  }
  return timestamp;
}

export const createLeagueEventResultsRepository = (dbInstance?: DbHandle) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const persist = async (
    db: DbOrTransaction,
    season: FplSeasonRef,
    values: readonly LeagueEventResultEvidenceInsert[],
  ): Promise<number> => {
    if (values.length === 0) return 0;
    await db
      .insert(leagueEventResultsInCompetition)
      .values(
        values.map((value) => ({
          ...value,
          seasonId: season.seasonId,
          sourceCheckedAt: sourceTimestamp(value.sourceCheckedAt),
        })),
      )
      .onConflictDoUpdate({
        target: [
          leagueEventResultsInCompetition.seasonId,
          leagueEventResultsInCompetition.leagueId,
          leagueEventResultsInCompetition.leagueType,
          leagueEventResultsInCompetition.entryId,
          leagueEventResultsInCompetition.eventId,
        ],
        where: sql`
          ${leagueEventResultsInCompetition.sourceCheckedAt} IS NULL
          OR ${leagueEventResultsInCompetition.sourceCheckedAt} < excluded.source_checked_at
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
          captainElementId: sql`excluded.captain_element_id`,
          captainPoints: sql`excluded.captain_points`,
          captainBlank: sql`excluded.captain_blank`,
          viceCaptainElementId: sql`excluded.vice_captain_element_id`,
          viceCaptainPoints: sql`excluded.vice_captain_points`,
          viceCaptainBlank: sql`excluded.vice_captain_blank`,
          playedCaptainElementId: sql`excluded.played_captain_element_id`,
          highestScoreElementId: sql`excluded.highest_score_element_id`,
          highestScorePoints: sql`excluded.highest_score_points`,
          highestScoreBlank: sql`excluded.highest_score_blank`,
          sourceCheckedAt: sql`excluded.source_checked_at`,
          updatedAt: new Date(),
        },
      });
    return values.length;
  };

  return {
    findEntryIdsByLeagueEvent: async (
      season: FplSeasonRef,
      leagueId: number,
      leagueType: LeagueEventResultInsert['leagueType'],
      eventId: number,
      entryIds: number[],
      freshAfter?: Date | string,
    ): Promise<number[]> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const threshold = freshAfter ? sourceTimestamp(freshAfter) : null;
        const uniqueIds = Array.from(new Set(entryIds));
        const results: number[] = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          const chunk = uniqueIds.slice(index, index + 1000);
          const rows = await db
            .select({ entryId: leagueEventResultsInCompetition.entryId })
            .from(leagueEventResultsInCompetition)
            .where(
              and(
                eq(leagueEventResultsInCompetition.seasonId, season.seasonId),
                eq(leagueEventResultsInCompetition.leagueId, leagueId),
                eq(leagueEventResultsInCompetition.leagueType, leagueType),
                eq(leagueEventResultsInCompetition.eventId, eventId),
                inArray(leagueEventResultsInCompetition.entryId, chunk),
                threshold
                  ? gte(leagueEventResultsInCompetition.sourceCheckedAt, threshold)
                  : undefined,
              ),
            );
          results.push(...rows.map((row) => row.entryId));
        }
        return results;
      } catch (error) {
        logError('Failed to find league event result checkpoints', error, {
          season: season.seasonCode,
          leagueId,
          leagueType,
          eventId,
        });
        throw new DatabaseError(
          'Failed to find league event result checkpoints',
          'LEAGUE_EVENT_RESULTS_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findSourceCheckpointsByLeagueEvent: async (
      season: FplSeasonRef,
      leagueId: number,
      leagueType: LeagueEventResultInsert['leagueType'],
      eventId: number,
      entryIds: number[],
    ): Promise<Array<{ entryId: number; sourceCheckedAt: Date | null }>> => {
      if (entryIds.length === 0) return [];

      try {
        const db = await getDbInstance();
        const uniqueIds = Array.from(new Set(entryIds));
        const results: Array<{ entryId: number; sourceCheckedAt: Date | null }> = [];
        for (let index = 0; index < uniqueIds.length; index += 1000) {
          const chunk = uniqueIds.slice(index, index + 1000);
          const rows = await db
            .select({
              entryId: leagueEventResultsInCompetition.entryId,
              sourceCheckedAt: leagueEventResultsInCompetition.sourceCheckedAt,
            })
            .from(leagueEventResultsInCompetition)
            .where(
              and(
                eq(leagueEventResultsInCompetition.seasonId, season.seasonId),
                eq(leagueEventResultsInCompetition.leagueId, leagueId),
                eq(leagueEventResultsInCompetition.leagueType, leagueType),
                eq(leagueEventResultsInCompetition.eventId, eventId),
                inArray(leagueEventResultsInCompetition.entryId, chunk),
              ),
            );
          results.push(...rows);
        }
        return results;
      } catch (error) {
        logError('Failed to find league event result source checkpoints', error, {
          season: season.seasonCode,
          leagueId,
          leagueType,
          eventId,
        });
        throw new DatabaseError(
          'Failed to find league event result source checkpoints',
          'LEAGUE_EVENT_RESULTS_SOURCE_CHECKPOINT_FIND_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    upsertBatch: async (
      season: FplSeasonRef,
      results: readonly LeagueEventResultEvidenceInsert[],
    ): Promise<number> => {
      if (results.length === 0) return 0;

      try {
        const db = await getDbInstance();
        const persisted = await db.transaction(async (tx) => {
          const entryIds = [...new Set(results.map((result) => result.entryId))];
          await acquireEntrySeasonWriteFence(tx, season, entryIds);
          const eligibleEntries = await tx
            .select({ entryId: entriesInCompetition.entryId })
            .from(entriesInCompetition)
            .where(
              and(
                eq(entriesInCompetition.seasonId, season.seasonId),
                inArray(entriesInCompetition.entryId, entryIds),
              ),
            )
            .for('share');
          const eligibleIds = new Set(eligibleEntries.map((entry) => entry.entryId));
          return persist(
            tx,
            season,
            results.filter((result) => eligibleIds.has(result.entryId)),
          );
        });

        logInfo('Upserted league event results', {
          season: season.seasonCode,
          requested: results.length,
          persisted,
        });
        return persisted;
      } catch (error) {
        logError('Failed to upsert league event results', error, {
          season: season.seasonCode,
          count: results.length,
        });
        throw new DatabaseError(
          'Failed to upsert league event results',
          'LEAGUE_EVENT_RESULTS_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const leagueEventResultsRepository = createLeagueEventResultsRepository();
