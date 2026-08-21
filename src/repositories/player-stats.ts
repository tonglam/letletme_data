import { createHash } from 'node:crypto';

import { and, count, eq, notInArray, sql } from 'drizzle-orm';

import {
  playerEventSnapshotPublicationsInFpl,
  playerEventSnapshotsInFpl,
  playersInFpl,
  type DbPlayerStatInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { PlayerStat } from '../domain/player-stats';

const playerStatColumns = [
  'elementId',
  'elementType',
  'totalPoints',
  'form',
  'influence',
  'creativity',
  'threat',
  'ictIndex',
  'expectedGoals',
  'expectedAssists',
  'expectedGoalInvolvements',
  'expectedGoalsConceded',
  'minutes',
  'goalsScored',
  'assists',
  'cleanSheets',
  'goalsConceded',
  'ownGoals',
  'penaltiesSaved',
  'yellowCards',
  'redCards',
  'saves',
  'bonus',
  'bps',
  'starts',
  'transfersIn',
  'transfersInEvent',
  'transfersOut',
  'transfersOutEvent',
  'influenceRank',
  'influenceRankType',
  'creativityRank',
  'creativityRankType',
  'threatRank',
  'threatRankType',
  'ictIndexRank',
  'ictIndexRankType',
  'selectedByPercent',
] as const;

function toPlayerStatRows(
  season: FplSeasonRef,
  playerStatsList: PlayerStat[],
  now: Date,
): DbPlayerStatInsert[] {
  return playerStatsList.map((playerStat) => ({
    seasonId: season.seasonId,
    eventId: playerStat.eventId,
    elementId: playerStat.elementId,
    elementType: playerStat.elementType,
    totalPoints: playerStat.totalPoints,
    form: playerStat.form === null ? null : String(playerStat.form),
    influence: playerStat.influence ?? null,
    creativity: playerStat.creativity ?? null,
    threat: playerStat.threat ?? null,
    ictIndex: playerStat.ictIndex === null ? null : String(playerStat.ictIndex),
    expectedGoals: playerStat.expectedGoals === null ? null : String(playerStat.expectedGoals),
    expectedAssists:
      playerStat.expectedAssists === null ? null : String(playerStat.expectedAssists),
    expectedGoalInvolvements:
      playerStat.expectedGoalInvolvements === null
        ? null
        : String(playerStat.expectedGoalInvolvements),
    expectedGoalsConceded:
      playerStat.expectedGoalsConceded === null ? null : String(playerStat.expectedGoalsConceded),
    minutes: playerStat.minutes ?? null,
    goalsScored: playerStat.goalsScored ?? null,
    assists: playerStat.assists ?? null,
    cleanSheets: playerStat.cleanSheets ?? null,
    goalsConceded: playerStat.goalsConceded ?? null,
    ownGoals: playerStat.ownGoals ?? null,
    penaltiesSaved: playerStat.penaltiesSaved ?? null,
    yellowCards: playerStat.yellowCards ?? null,
    redCards: playerStat.redCards ?? null,
    saves: playerStat.saves ?? null,
    bonus: playerStat.bonus ?? null,
    bps: playerStat.bps ?? null,
    starts: playerStat.starts ?? null,
    transfersIn: playerStat.transfersIn ?? null,
    transfersInEvent: playerStat.transfersInEvent ?? null,
    transfersOut: playerStat.transfersOut ?? null,
    transfersOutEvent: playerStat.transfersOutEvent ?? null,
    influenceRank: playerStat.influenceRank ?? null,
    influenceRankType: playerStat.influenceRankType ?? null,
    creativityRank: playerStat.creativityRank ?? null,
    creativityRankType: playerStat.creativityRankType ?? null,
    threatRank: playerStat.threatRank ?? null,
    threatRankType: playerStat.threatRankType ?? null,
    ictIndexRank: playerStat.ictIndexRank ?? null,
    ictIndexRankType: playerStat.ictIndexRankType ?? null,
    selectedByPercent: playerStat.selectedByPercent ?? null,
    createdAt: now,
    updatedAt: now,
  }));
}

function hashPlayerStatRows(rows: DbPlayerStatInsert[]): string {
  const canonical = rows
    .slice()
    .sort((left, right) => left.elementId - right.elementId)
    .map((row) =>
      playerStatColumns.map((column) => [column, row[column as keyof DbPlayerStatInsert] ?? null]),
    );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export type PlayerStatsRepository = ReturnType<typeof createPlayerStatsRepository>;

export const createPlayerStatsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findPublication: async (season: FplSeasonRef, eventId: number) => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(playerEventSnapshotPublicationsInFpl)
        .where(
          and(
            eq(playerEventSnapshotPublicationsInFpl.seasonId, season.seasonId),
            eq(playerEventSnapshotPublicationsInFpl.eventId, eventId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    findCorePlayerIds: async (season: FplSeasonRef): Promise<number[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select({ elementId: playersInFpl.elementId })
        .from(playersInFpl)
        .where(eq(playersInFpl.seasonId, season.seasonId));
      return rows.map((row) => Number(row.elementId));
    },

    upsertBatch: async (
      season: FplSeasonRef,
      playerStatsList: PlayerStat[],
    ): Promise<{ count: number }> => {
      try {
        if (playerStatsList.length === 0) {
          return { count: 0 };
        }

        const rows: DbPlayerStatInsert[] = playerStatsList.map((playerStat) => ({
          seasonId: season.seasonId,
          eventId: playerStat.eventId,
          elementId: playerStat.elementId,
          elementType: playerStat.elementType,
          totalPoints: playerStat.totalPoints,
          form: playerStat.form === null ? null : String(playerStat.form),
          influence: playerStat.influence ?? null,
          creativity: playerStat.creativity ?? null,
          threat: playerStat.threat ?? null,
          ictIndex: playerStat.ictIndex === null ? null : String(playerStat.ictIndex),
          expectedGoals:
            playerStat.expectedGoals === null ? null : String(playerStat.expectedGoals),
          expectedAssists:
            playerStat.expectedAssists === null ? null : String(playerStat.expectedAssists),
          expectedGoalInvolvements:
            playerStat.expectedGoalInvolvements === null
              ? null
              : String(playerStat.expectedGoalInvolvements),
          expectedGoalsConceded:
            playerStat.expectedGoalsConceded === null
              ? null
              : String(playerStat.expectedGoalsConceded),
          minutes: playerStat.minutes ?? null,
          goalsScored: playerStat.goalsScored ?? null,
          assists: playerStat.assists ?? null,
          cleanSheets: playerStat.cleanSheets ?? null,
          goalsConceded: playerStat.goalsConceded ?? null,
          ownGoals: playerStat.ownGoals ?? null,
          penaltiesSaved: playerStat.penaltiesSaved ?? null,
          yellowCards: playerStat.yellowCards ?? null,
          redCards: playerStat.redCards ?? null,
          saves: playerStat.saves ?? null,
          bonus: playerStat.bonus ?? null,
          bps: playerStat.bps ?? null,
          starts: playerStat.starts ?? null,
          transfersIn: playerStat.transfersIn ?? null,
          transfersInEvent: playerStat.transfersInEvent ?? null,
          transfersOut: playerStat.transfersOut ?? null,
          transfersOutEvent: playerStat.transfersOutEvent ?? null,
          influenceRank: playerStat.influenceRank ?? null,
          influenceRankType: playerStat.influenceRankType ?? null,
          creativityRank: playerStat.creativityRank ?? null,
          creativityRankType: playerStat.creativityRankType ?? null,
          threatRank: playerStat.threatRank ?? null,
          threatRankType: playerStat.threatRankType ?? null,
          ictIndexRank: playerStat.ictIndexRank ?? null,
          ictIndexRankType: playerStat.ictIndexRankType ?? null,
          selectedByPercent: playerStat.selectedByPercent ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        const db = await getDbInstance();
        const result = await db
          .insert(playerEventSnapshotsInFpl)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              playerEventSnapshotsInFpl.seasonId,
              playerEventSnapshotsInFpl.eventId,
              playerEventSnapshotsInFpl.elementId,
            ],
            set: {
              totalPoints: sql`excluded.total_points`,
              form: sql`excluded.form`,
              influence: sql`excluded.influence`,
              creativity: sql`excluded.creativity`,
              threat: sql`excluded.threat`,
              ictIndex: sql`excluded.ict_index`,
              expectedGoals: sql`excluded.expected_goals`,
              expectedAssists: sql`excluded.expected_assists`,
              expectedGoalInvolvements: sql`excluded.expected_goal_involvements`,
              expectedGoalsConceded: sql`excluded.expected_goals_conceded`,
              minutes: sql`excluded.minutes`,
              goalsScored: sql`excluded.goals_scored`,
              assists: sql`excluded.assists`,
              cleanSheets: sql`excluded.clean_sheets`,
              goalsConceded: sql`excluded.goals_conceded`,
              ownGoals: sql`excluded.own_goals`,
              penaltiesSaved: sql`excluded.penalties_saved`,
              yellowCards: sql`excluded.yellow_cards`,
              redCards: sql`excluded.red_cards`,
              saves: sql`excluded.saves`,
              bonus: sql`excluded.bonus`,
              bps: sql`excluded.bps`,
              starts: sql`excluded.starts`,
              transfersIn: sql`excluded.transfers_in`,
              transfersInEvent: sql`excluded.transfers_in_event`,
              transfersOut: sql`excluded.transfers_out`,
              transfersOutEvent: sql`excluded.transfers_out_event`,
              influenceRank: sql`excluded.influence_rank`,
              influenceRankType: sql`excluded.influence_rank_type`,
              creativityRank: sql`excluded.creativity_rank`,
              creativityRankType: sql`excluded.creativity_rank_type`,
              threatRank: sql`excluded.threat_rank`,
              threatRankType: sql`excluded.threat_rank_type`,
              ictIndexRank: sql`excluded.ict_index_rank`,
              ictIndexRankType: sql`excluded.ict_index_rank_type`,
              selectedByPercent: sql`excluded.selected_by_percent`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning();

        logInfo('Batch upserted player stats', { count: result.length });
        return { count: result.length };
      } catch (error) {
        logError('Failed to batch upsert player stats', error, { count: playerStatsList.length });
        throw new DatabaseError(
          'Failed to batch upsert player stats',
          'BATCH_UPSERT_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    /**
     * Atomically replace one event's complete player set and publish its
     * quality header. The old rows and header remain visible if any check or
     * write fails because both are inside one database transaction.
     */
    replaceBatch: async (
      season: FplSeasonRef,
      playerStatsList: PlayerStat[],
      options: {
        sourceCheckedAt: Date;
        baselineVerifiedAt?: Date | null;
      },
    ): Promise<{
      count: number;
      expectedRowCount: number;
      revision: number;
      sourceCheckedAt: Date;
      publishedAt: Date;
      baselineVerifiedAt: Date | null;
      contentSha256: string;
    }> => {
      if (playerStatsList.length === 0) {
        throw new DatabaseError(
          'Cannot publish an empty player stats snapshot',
          'PLAYER_STATS_EMPTY_SNAPSHOT',
        );
      }

      const eventId = playerStatsList[0]?.eventId;
      if (!eventId || playerStatsList.some((playerStat) => playerStat.eventId !== eventId)) {
        throw new DatabaseError(
          'Player stats snapshot contains more than one event',
          'PLAYER_STATS_EVENT_MISMATCH',
        );
      }

      const elementIds = playerStatsList.map((playerStat) => playerStat.elementId);
      if (new Set(elementIds).size !== elementIds.length) {
        throw new DatabaseError(
          'Player stats snapshot contains duplicate player identifiers',
          'PLAYER_STATS_DUPLICATE_PLAYER',
        );
      }

      const now = new Date();
      const rows = toPlayerStatRows(season, playerStatsList, now);
      const contentSha256 = hashPlayerStatRows(rows);
      const expectedRowCount = rows.length;

      const persist = async (db: DbOrTransaction) => {
        const corePlayerRows = await db
          .select({ elementId: playersInFpl.elementId })
          .from(playersInFpl)
          .where(eq(playersInFpl.seasonId, season.seasonId));
        const corePlayerIds = corePlayerRows.map((row) => Number(row.elementId));
        const corePlayerSet = new Set(corePlayerIds);
        if (
          corePlayerIds.length !== expectedRowCount ||
          corePlayerSet.size !== expectedRowCount ||
          elementIds.some((elementId) => !corePlayerSet.has(elementId))
        ) {
          throw new DatabaseError(
            `Player stats snapshot does not match the canonical core player set: source=${expectedRowCount}, core=${corePlayerSet.size}`,
            'PLAYER_STATS_CORE_SET_MISMATCH',
          );
        }

        const previousPublication = await db
          .select({ baselineVerifiedAt: playerEventSnapshotPublicationsInFpl.baselineVerifiedAt })
          .from(playerEventSnapshotPublicationsInFpl)
          .where(
            and(
              eq(playerEventSnapshotPublicationsInFpl.seasonId, season.seasonId),
              eq(playerEventSnapshotPublicationsInFpl.eventId, eventId),
            ),
          )
          .limit(1);

        await db
          .delete(playerEventSnapshotsInFpl)
          .where(
            and(
              eq(playerEventSnapshotsInFpl.seasonId, season.seasonId),
              eq(playerEventSnapshotsInFpl.eventId, eventId),
              notInArray(playerEventSnapshotsInFpl.elementId, elementIds),
            ),
          );

        const savedRows = await db
          .insert(playerEventSnapshotsInFpl)
          .values(rows)
          .onConflictDoUpdate({
            target: [
              playerEventSnapshotsInFpl.seasonId,
              playerEventSnapshotsInFpl.eventId,
              playerEventSnapshotsInFpl.elementId,
            ],
            set: {
              totalPoints: sql`excluded.total_points`,
              form: sql`excluded.form`,
              influence: sql`excluded.influence`,
              creativity: sql`excluded.creativity`,
              threat: sql`excluded.threat`,
              ictIndex: sql`excluded.ict_index`,
              expectedGoals: sql`excluded.expected_goals`,
              expectedAssists: sql`excluded.expected_assists`,
              expectedGoalInvolvements: sql`excluded.expected_goal_involvements`,
              expectedGoalsConceded: sql`excluded.expected_goals_conceded`,
              minutes: sql`excluded.minutes`,
              goalsScored: sql`excluded.goals_scored`,
              assists: sql`excluded.assists`,
              cleanSheets: sql`excluded.clean_sheets`,
              goalsConceded: sql`excluded.goals_conceded`,
              ownGoals: sql`excluded.own_goals`,
              penaltiesSaved: sql`excluded.penalties_saved`,
              yellowCards: sql`excluded.yellow_cards`,
              redCards: sql`excluded.red_cards`,
              saves: sql`excluded.saves`,
              bonus: sql`excluded.bonus`,
              bps: sql`excluded.bps`,
              starts: sql`excluded.starts`,
              transfersIn: sql`excluded.transfers_in`,
              transfersInEvent: sql`excluded.transfers_in_event`,
              transfersOut: sql`excluded.transfers_out`,
              transfersOutEvent: sql`excluded.transfers_out_event`,
              influenceRank: sql`excluded.influence_rank`,
              influenceRankType: sql`excluded.influence_rank_type`,
              creativityRank: sql`excluded.creativity_rank`,
              creativityRankType: sql`excluded.creativity_rank_type`,
              threatRank: sql`excluded.threat_rank`,
              threatRankType: sql`excluded.threat_rank_type`,
              ictIndexRank: sql`excluded.ict_index_rank`,
              ictIndexRankType: sql`excluded.ict_index_rank_type`,
              selectedByPercent: sql`excluded.selected_by_percent`,
              updatedAt: sql`NOW()`,
            },
          })
          .returning({ elementId: playerEventSnapshotsInFpl.elementId });

        if (savedRows.length !== expectedRowCount) {
          throw new DatabaseError(
            `Player stats upsert returned ${savedRows.length} rows; expected ${expectedRowCount}`,
            'PLAYER_STATS_WRITE_INCOMPLETE',
          );
        }

        const persistedCountRows = await db
          .select({ count: count() })
          .from(playerEventSnapshotsInFpl)
          .where(
            and(
              eq(playerEventSnapshotsInFpl.seasonId, season.seasonId),
              eq(playerEventSnapshotsInFpl.eventId, eventId),
            ),
          );
        const persistedCount = Number(persistedCountRows[0]?.count ?? 0);
        if (persistedCount !== expectedRowCount) {
          throw new DatabaseError(
            `Player stats set contains ${persistedCount} rows; expected ${expectedRowCount}`,
            'PLAYER_STATS_SET_INCOMPLETE',
          );
        }

        const baselineVerifiedAt =
          options.baselineVerifiedAt ?? previousPublication[0]?.baselineVerifiedAt ?? null;
        const publicationRows = await db
          .insert(playerEventSnapshotPublicationsInFpl)
          .values({
            seasonId: season.seasonId,
            eventId,
            sourceCheckedAt: options.sourceCheckedAt,
            publishedAt: now,
            rowCount: persistedCount,
            expectedRowCount,
            contentSha256,
            baselineVerifiedAt,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              playerEventSnapshotPublicationsInFpl.seasonId,
              playerEventSnapshotPublicationsInFpl.eventId,
            ],
            set: {
              revision: sql`nextval('fpl.player_event_snapshot_publication_revision_seq'::regclass)`,
              sourceCheckedAt: options.sourceCheckedAt,
              publishedAt: now,
              rowCount: persistedCount,
              expectedRowCount,
              contentSha256,
              baselineVerifiedAt,
              updatedAt: now,
            },
          })
          .returning();
        const publication = publicationRows[0];
        if (!publication) {
          throw new DatabaseError(
            'Player stats publication header was not returned',
            'PLAYER_STATS_PUBLICATION_MISSING',
          );
        }

        return {
          count: persistedCount,
          expectedRowCount,
          revision: publication.revision,
          sourceCheckedAt: publication.sourceCheckedAt,
          publishedAt: publication.publishedAt,
          baselineVerifiedAt: publication.baselineVerifiedAt,
          contentSha256: publication.contentSha256,
        };
      };

      try {
        const db = await getDbInstance();
        const result = dbInstance
          ? await persist(db)
          : await (db as DbHandle).transaction((transaction) => persist(transaction));
        logInfo('Player stats snapshot replaced and published', {
          season: season.seasonCode,
          eventId,
          count: result.count,
          revision: result.revision,
          sourceCheckedAt: result.sourceCheckedAt.toISOString(),
          publishedAt: result.publishedAt.toISOString(),
        });
        return result;
      } catch (error) {
        logError('Failed to replace player stats snapshot', error, {
          season: season.seasonCode,
          eventId,
          count: expectedRowCount,
        });
        throw new DatabaseError(
          'Failed to replace player stats snapshot',
          'PLAYER_STATS_REPLACE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const playerStatsRepository = createPlayerStatsRepository();
