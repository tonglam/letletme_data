import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  tournamentBattleGroupResultsInCompetition,
  tournamentKnockoutResultsInCompetition,
  tournamentsInCompetition,
  type DbTournamentBattleGroupResultInsert,
  type DbTournamentGroupInsert,
  type DbTournamentKnockoutInsert,
  type DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import { createTournamentGroupRepository } from './tournament-groups';
import { createTournamentKnockoutsRepository } from './tournament-knockouts';

export type OfficialH2HPublication = {
  scheduleHash: string;
  checkedAt: Date;
  lockSchedule: boolean;
  battleRows: DbTournamentBattleGroupResultInsert[];
  knockoutRows: DbTournamentKnockoutResultInsert[];
  bracketRows: DbTournamentKnockoutInsert[];
  groupRows: DbTournamentGroupInsert[];
};

export const tournamentOfficialH2HRepository = {
  async publish(
    season: FplSeasonRef,
    tournamentId: number,
    publication: OfficialH2HPublication,
  ): Promise<{ battleRows: number; knockoutRows: number; groupRows: number }> {
    try {
      const db = await getDb();
      return await db.transaction(async (tx) => {
        const currentRows = await tx
          .select({
            scheduleHash: tournamentsInCompetition.officialScheduleHash,
            scheduleLockedAt: tournamentsInCompetition.officialScheduleLockedAt,
          })
          .from(tournamentsInCompetition)
          .where(
            and(
              eq(tournamentsInCompetition.seasonId, season.seasonId),
              eq(tournamentsInCompetition.tournamentId, tournamentId),
            ),
          )
          .for('update')
          .limit(1);
        const current = currentRows[0];
        if (!current) {
          throw new DatabaseError(
            'Tournament no longer exists.',
            'TOURNAMENT_OFFICIAL_H2H_NOT_FOUND',
          );
        }
        if (
          current.scheduleLockedAt &&
          current.scheduleHash &&
          current.scheduleHash !== publication.scheduleHash
        ) {
          throw new ConflictError(
            'Official H2H schedule changed after it was locked.',
            'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_CHANGED',
          );
        }

        if (publication.battleRows.length > 0) {
          await tx
            .insert(tournamentBattleGroupResultsInCompetition)
            .values(
              publication.battleRows.map((row) => ({
                ...row,
                seasonId: season.seasonId,
              })),
            )
            .onConflictDoUpdate({
              target: [
                tournamentBattleGroupResultsInCompetition.tournamentId,
                tournamentBattleGroupResultsInCompetition.officialMatchId,
              ],
              targetWhere: sql`${tournamentBattleGroupResultsInCompetition.officialMatchId} IS NOT NULL`,
              set: {
                groupId: sql`excluded.group_id`,
                eventId: sql`excluded.event_id`,
                homeIndex: sql`excluded.home_index`,
                homeEntryId: sql`excluded.home_entry_id`,
                homeNetPoints: sql`excluded.home_net_points`,
                homeRank: sql`excluded.home_rank`,
                homeMatchPoints: sql`excluded.home_match_points`,
                awayIndex: sql`excluded.away_index`,
                awayEntryId: sql`excluded.away_entry_id`,
                awayNetPoints: sql`excluded.away_net_points`,
                awayRank: sql`excluded.away_rank`,
                awayMatchPoints: sql`excluded.away_match_points`,
                sourceOrder: sql`excluded.source_order`,
                homeIsAverage: sql`excluded.home_is_average`,
                awayIsAverage: sql`excluded.away_is_average`,
                isBye: sql`excluded.is_bye`,
                sourceCheckedAt: sql`excluded.source_checked_at`,
                updatedAt: publication.checkedAt,
              },
            });
        }

        if (publication.knockoutRows.length > 0) {
          const officialMatchIds = publication.knockoutRows.flatMap((row) =>
            typeof row.officialMatchId === 'number' ? [row.officialMatchId] : [],
          );
          const existingRows =
            officialMatchIds.length === 0
              ? []
              : await tx
                  .select({
                    officialMatchId: tournamentKnockoutResultsInCompetition.officialMatchId,
                    eventId: tournamentKnockoutResultsInCompetition.eventId,
                    matchId: tournamentKnockoutResultsInCompetition.matchId,
                    playAgainstId: tournamentKnockoutResultsInCompetition.playAgainstId,
                    homeEntryId: tournamentKnockoutResultsInCompetition.homeEntryId,
                    awayEntryId: tournamentKnockoutResultsInCompetition.awayEntryId,
                    sourceOrder: tournamentKnockoutResultsInCompetition.sourceOrder,
                    knockoutName: tournamentKnockoutResultsInCompetition.knockoutName,
                  })
                  .from(tournamentKnockoutResultsInCompetition)
                  .where(
                    and(
                      eq(tournamentKnockoutResultsInCompetition.seasonId, season.seasonId),
                      eq(tournamentKnockoutResultsInCompetition.tournamentId, tournamentId),
                      inArray(
                        tournamentKnockoutResultsInCompetition.officialMatchId,
                        officialMatchIds,
                      ),
                    ),
                  );
          const incomingByMatchId = new Map(
            publication.knockoutRows.flatMap((row) =>
              typeof row.officialMatchId === 'number' ? [[row.officialMatchId, row] as const] : [],
            ),
          );
          for (const existing of existingRows) {
            if (existing.officialMatchId === null) continue;
            const incoming = incomingByMatchId.get(existing.officialMatchId);
            if (!incoming) continue;
            const changed =
              existing.eventId !== incoming.eventId ||
              existing.matchId !== incoming.matchId ||
              existing.playAgainstId !== incoming.playAgainstId ||
              existing.sourceOrder !== incoming.sourceOrder ||
              (existing.homeEntryId !== null && existing.homeEntryId !== incoming.homeEntryId) ||
              (existing.awayEntryId !== null && existing.awayEntryId !== incoming.awayEntryId) ||
              (existing.knockoutName !== null && existing.knockoutName !== incoming.knockoutName);
            if (changed) {
              throw new ConflictError(
                `Official H2H knockout match ${existing.officialMatchId} changed after import.`,
                'TOURNAMENT_OFFICIAL_H2H_KNOCKOUT_CHANGED',
              );
            }
          }
          await tx
            .insert(tournamentKnockoutResultsInCompetition)
            .values(
              publication.knockoutRows.map((row) => ({
                ...row,
                seasonId: season.seasonId,
              })),
            )
            .onConflictDoUpdate({
              target: [
                tournamentKnockoutResultsInCompetition.tournamentId,
                tournamentKnockoutResultsInCompetition.officialMatchId,
              ],
              targetWhere: sql`${tournamentKnockoutResultsInCompetition.officialMatchId} IS NOT NULL`,
              set: {
                eventId: sql`excluded.event_id`,
                matchId: sql`excluded.match_id`,
                playAgainstId: sql`excluded.play_against_id`,
                homeEntryId: sql`excluded.home_entry_id`,
                homeNetPoints: sql`excluded.home_net_points`,
                awayEntryId: sql`excluded.away_entry_id`,
                awayNetPoints: sql`excluded.away_net_points`,
                matchWinner: sql`excluded.match_winner`,
                sourceOrder: sql`excluded.source_order`,
                knockoutName: sql`excluded.knockout_name`,
                tiebreak: sql`excluded.tiebreak`,
                sourceCheckedAt: sql`excluded.source_checked_at`,
                updatedAt: publication.checkedAt,
              },
            });
        }

        const groups = createTournamentGroupRepository(tx);
        const knockouts = createTournamentKnockoutsRepository(tx);
        const groupCount = await groups.upsertBatch(season, publication.groupRows);
        await knockouts.upsertBatch(season, publication.bracketRows);

        const updateRows = await tx
          .update(tournamentsInCompetition)
          .set({
            officialScheduleHash: publication.scheduleHash,
            officialScheduleSyncedAt: publication.checkedAt,
            officialScheduleLockedAt:
              current.scheduleLockedAt ?? (publication.lockSchedule ? publication.checkedAt : null),
            updatedAt: publication.checkedAt,
          })
          .where(
            and(
              eq(tournamentsInCompetition.seasonId, season.seasonId),
              eq(tournamentsInCompetition.tournamentId, tournamentId),
            ),
          )
          .returning({ tournamentId: tournamentsInCompetition.tournamentId });
        if (updateRows.length !== 1) {
          throw new DatabaseError(
            'Tournament disappeared during official H2H publication.',
            'TOURNAMENT_OFFICIAL_H2H_UPDATE_MISSING',
          );
        }

        logInfo('Published official H2H snapshot', {
          tournamentId,
          battleRows: publication.battleRows.length,
          knockoutRows: publication.knockoutRows.length,
          groupRows: groupCount,
          scheduleLocked: Boolean(
            current.scheduleLockedAt ?? (publication.lockSchedule ? publication.checkedAt : null),
          ),
        });
        return {
          battleRows: publication.battleRows.length,
          knockoutRows: publication.knockoutRows.length,
          groupRows: groupCount,
        };
      });
    } catch (error) {
      if (error instanceof ConflictError || error instanceof DatabaseError) throw error;
      logError('Failed to publish official H2H snapshot', error, { tournamentId });
      throw new DatabaseError(
        'Failed to publish official H2H snapshot',
        'TOURNAMENT_OFFICIAL_H2H_PUBLISH_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },
};
