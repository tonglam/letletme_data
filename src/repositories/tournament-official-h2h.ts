import { and, eq, inArray, sql } from 'drizzle-orm';

import {
  tournamentBattleGroupResultsInCompetition,
  tournamentKnockoutResultsInCompetition,
  tournamentsInCompetition,
  tournamentOfficialH2HPageManifestsInCompetition,
  type DbTournamentBattleGroupResultInsert,
  type DbTournamentGroupInsert,
  type DbTournamentKnockoutInsert,
  type DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  missingLockedPageNumbers,
  type OfficialH2HPageManifest,
} from '../domain/official-h2h-manifest';
import type { RawFPLLeagueH2HMatch } from '../clients/fpl';

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
  pageManifests?: readonly OfficialH2HPageManifest[];
  /** A guarded full fetch must prove that no previously locked page vanished. */
  fullReconcile?: boolean;
};

function previousLockedAt(
  previous: { lockedAt: Date | null } | undefined,
  publication: Pick<OfficialH2HPublication, 'lockSchedule' | 'checkedAt'>,
): Date | null {
  return previous?.lockedAt ?? (publication.lockSchedule ? publication.checkedAt : null);
}

function sameNullable<T>(left: T | null | undefined, right: T | null | undefined): boolean {
  return (left ?? null) === (right ?? null);
}

export const tournamentOfficialH2HRepository = {
  /** Rehydrate the last complete schedule so a locked minute refresh can
   * replace only the page containing the current event. Scores are refreshed
   * from the provider; immutable sides/order remain database evidence. */
  async findPersistedMatches(
    season: FplSeasonRef,
    tournamentId: number,
  ): Promise<Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>> {
    const db = await getDb();
    const [battleRows, knockoutRows] = await Promise.all([
      db
        .select()
        .from(tournamentBattleGroupResultsInCompetition)
        .where(
          and(
            eq(tournamentBattleGroupResultsInCompetition.seasonId, season.seasonId),
            eq(tournamentBattleGroupResultsInCompetition.tournamentId, tournamentId),
          ),
        ),
      db
        .select()
        .from(tournamentKnockoutResultsInCompetition)
        .where(
          and(
            eq(tournamentKnockoutResultsInCompetition.seasonId, season.seasonId),
            eq(tournamentKnockoutResultsInCompetition.tournamentId, tournamentId),
          ),
        ),
    ]);
    const regular = battleRows
      .filter((row) => row.officialMatchId !== null && row.sourceOrder !== null)
      .map((row) => ({
        id: row.officialMatchId!,
        event: row.eventId,
        entry_1_entry: row.homeEntryId,
        entry_1_name: null,
        entry_1_player_name: null,
        entry_1_points: row.homeNetPoints,
        entry_1_total: row.homeMatchPoints ?? undefined,
        entry_2_entry: row.awayEntryId,
        entry_2_name: null,
        entry_2_player_name: null,
        entry_2_points: row.awayNetPoints,
        entry_2_total: row.awayMatchPoints ?? undefined,
        winner:
          row.homeMatchPoints === 3
            ? row.homeEntryId
            : row.awayMatchPoints === 3
              ? row.awayEntryId
              : null,
        is_bye: row.isBye,
        is_knockout: false,
        knockout_name: null,
        tiebreak: null,
        sourceOrder: row.sourceOrder!,
      })) satisfies Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
    const knockout = knockoutRows
      .filter((row) => row.officialMatchId !== null && row.sourceOrder !== null)
      .map((row) => ({
        id: row.officialMatchId!,
        event: row.eventId,
        entry_1_entry: row.homeEntryId,
        entry_1_name: null,
        entry_1_player_name: null,
        entry_1_points: row.homeNetPoints,
        entry_2_entry: row.awayEntryId,
        entry_2_name: null,
        entry_2_player_name: null,
        entry_2_points: row.awayNetPoints,
        winner: row.matchWinner,
        is_bye: row.homeEntryId === null || row.awayEntryId === null,
        is_knockout: true,
        knockout_name: row.knockoutName,
        tiebreak: row.tiebreak,
        sourceOrder: row.sourceOrder!,
      })) satisfies Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
    return [...regular, ...knockout].sort((a, b) => a.sourceOrder - b.sourceOrder);
  },

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

        if (
          publication.fullReconcile === true &&
          current.scheduleLockedAt &&
          (!publication.pageManifests || publication.pageManifests.length === 0)
        ) {
          throw new ConflictError(
            'Official H2H full reconciliation did not return page manifests.',
            'TOURNAMENT_OFFICIAL_H2H_PAGE_MISSING',
          );
        }
        if (publication.pageManifests && publication.pageManifests.length > 0) {
          const existingManifests = await tx
            .select()
            .from(tournamentOfficialH2HPageManifestsInCompetition)
            .where(
              and(
                eq(tournamentOfficialH2HPageManifestsInCompetition.seasonId, season.seasonId),
                eq(tournamentOfficialH2HPageManifestsInCompetition.tournamentId, tournamentId),
              ),
            );
          const existingByPage = new Map(
            existingManifests.map((manifest) => [manifest.pageNumber, manifest]),
          );
          if (publication.fullReconcile === true && current.scheduleLockedAt) {
            const missingLockedPages = missingLockedPageNumbers(
              existingManifests,
              publication.pageManifests,
            );
            if (missingLockedPages.length > 0) {
              throw new ConflictError(
                `Official H2H locked page(s) missing from full reconciliation: ${missingLockedPages.join(',')}.`,
                'TOURNAMENT_OFFICIAL_H2H_PAGE_MISSING',
              );
            }
          }
          for (const manifest of publication.pageManifests) {
            const previous = existingByPage.get(manifest.pageNumber);
            if (
              previous?.lockedAt &&
              (previous.scheduleHash !== manifest.scheduleHash ||
                previous.immutablePageHash !== manifest.immutablePageHash ||
                previous.matchIds.join(',') !== manifest.matchIds.join(',') ||
                previous.eventIds.join(',') !== manifest.eventIds.join(','))
            ) {
              throw new ConflictError(
                `Official H2H page ${manifest.pageNumber} changed after it was locked.`,
                'TOURNAMENT_OFFICIAL_H2H_PAGE_CHANGED',
              );
            }
          }
          await tx
            .insert(tournamentOfficialH2HPageManifestsInCompetition)
            .values(
              publication.pageManifests.map((manifest) => ({
                seasonId: season.seasonId,
                tournamentId,
                pageNumber: manifest.pageNumber,
                scheduleHash: manifest.scheduleHash,
                matchIds: [...manifest.matchIds],
                eventIds: [...manifest.eventIds],
                immutablePageHash: manifest.immutablePageHash,
                capturedAt: new Date(manifest.capturedAt),
                lockedAt: previousLockedAt(existingByPage.get(manifest.pageNumber), publication),
              })),
            )
            .onConflictDoUpdate({
              target: [
                tournamentOfficialH2HPageManifestsInCompetition.seasonId,
                tournamentOfficialH2HPageManifestsInCompetition.tournamentId,
                tournamentOfficialH2HPageManifestsInCompetition.pageNumber,
              ],
              set: {
                scheduleHash: sql`excluded.schedule_hash`,
                matchIds: sql`excluded.match_ids`,
                eventIds: sql`excluded.event_ids`,
                immutablePageHash: sql`excluded.immutable_page_hash`,
                capturedAt: sql`excluded.captured_at`,
                lockedAt: sql`COALESCE(${tournamentOfficialH2HPageManifestsInCompetition.lockedAt}, excluded.locked_at)`,
              },
            });
        }

        if (publication.battleRows.length > 0) {
          const battlePayloadUnchanged = sql`
            ${tournamentBattleGroupResultsInCompetition.groupId} IS NOT DISTINCT FROM excluded.group_id
            AND ${tournamentBattleGroupResultsInCompetition.eventId} IS NOT DISTINCT FROM excluded.event_id
            AND ${tournamentBattleGroupResultsInCompetition.homeIndex} IS NOT DISTINCT FROM excluded.home_index
            AND ${tournamentBattleGroupResultsInCompetition.homeEntryId} IS NOT DISTINCT FROM excluded.home_entry_id
            AND ${tournamentBattleGroupResultsInCompetition.homeNetPoints} IS NOT DISTINCT FROM excluded.home_net_points
            AND ${tournamentBattleGroupResultsInCompetition.homeRank} IS NOT DISTINCT FROM excluded.home_rank
            AND ${tournamentBattleGroupResultsInCompetition.homeMatchPoints} IS NOT DISTINCT FROM excluded.home_match_points
            AND ${tournamentBattleGroupResultsInCompetition.awayIndex} IS NOT DISTINCT FROM excluded.away_index
            AND ${tournamentBattleGroupResultsInCompetition.awayEntryId} IS NOT DISTINCT FROM excluded.away_entry_id
            AND ${tournamentBattleGroupResultsInCompetition.awayNetPoints} IS NOT DISTINCT FROM excluded.away_net_points
            AND ${tournamentBattleGroupResultsInCompetition.awayRank} IS NOT DISTINCT FROM excluded.away_rank
            AND ${tournamentBattleGroupResultsInCompetition.awayMatchPoints} IS NOT DISTINCT FROM excluded.away_match_points
            AND ${tournamentBattleGroupResultsInCompetition.sourceOrder} IS NOT DISTINCT FROM excluded.source_order
            AND ${tournamentBattleGroupResultsInCompetition.homeIsAverage} IS NOT DISTINCT FROM excluded.home_is_average
            AND ${tournamentBattleGroupResultsInCompetition.awayIsAverage} IS NOT DISTINCT FROM excluded.away_is_average
            AND ${tournamentBattleGroupResultsInCompetition.isBye} IS NOT DISTINCT FROM excluded.is_bye
          `;
          await tx
            .insert(tournamentBattleGroupResultsInCompetition)
            .values(
              publication.battleRows.map((row) => ({
                ...row,
                seasonId: season.seasonId,
                updatedAt: publication.checkedAt,
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
                sourceCheckedAt: sql`CASE
                  WHEN ${battlePayloadUnchanged}
                   AND ${tournamentBattleGroupResultsInCompetition.sourceCheckedAt} IS NOT NULL
                    THEN ${tournamentBattleGroupResultsInCompetition.sourceCheckedAt}
                  ELSE excluded.source_checked_at
                END`,
                updatedAt: sql`CASE
                  WHEN ${battlePayloadUnchanged}
                    THEN ${tournamentBattleGroupResultsInCompetition.updatedAt}
                  ELSE excluded.updated_at
                END`,
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
              !sameNullable(existing.sourceOrder, incoming.sourceOrder) ||
              !sameNullable(existing.homeEntryId, incoming.homeEntryId) ||
              !sameNullable(existing.awayEntryId, incoming.awayEntryId) ||
              !sameNullable(existing.knockoutName, incoming.knockoutName);
            if (changed) {
              throw new ConflictError(
                `Official H2H knockout match ${existing.officialMatchId} changed after import.`,
                'TOURNAMENT_OFFICIAL_H2H_KNOCKOUT_CHANGED',
              );
            }
          }
          const knockoutPayloadUnchanged = sql`
            ${tournamentKnockoutResultsInCompetition.eventId} IS NOT DISTINCT FROM excluded.event_id
            AND ${tournamentKnockoutResultsInCompetition.matchId} IS NOT DISTINCT FROM excluded.match_id
            AND ${tournamentKnockoutResultsInCompetition.playAgainstId} IS NOT DISTINCT FROM excluded.play_against_id
            AND ${tournamentKnockoutResultsInCompetition.homeEntryId} IS NOT DISTINCT FROM excluded.home_entry_id
            AND ${tournamentKnockoutResultsInCompetition.homeNetPoints} IS NOT DISTINCT FROM excluded.home_net_points
            AND ${tournamentKnockoutResultsInCompetition.homeGoalsScored} IS NOT DISTINCT FROM excluded.home_goals_scored
            AND ${tournamentKnockoutResultsInCompetition.homeGoalsConceded} IS NOT DISTINCT FROM excluded.home_goals_conceded
            AND ${tournamentKnockoutResultsInCompetition.awayEntryId} IS NOT DISTINCT FROM excluded.away_entry_id
            AND ${tournamentKnockoutResultsInCompetition.awayNetPoints} IS NOT DISTINCT FROM excluded.away_net_points
            AND ${tournamentKnockoutResultsInCompetition.awayGoalsScored} IS NOT DISTINCT FROM excluded.away_goals_scored
            AND ${tournamentKnockoutResultsInCompetition.awayGoalsConceded} IS NOT DISTINCT FROM excluded.away_goals_conceded
            AND ${tournamentKnockoutResultsInCompetition.matchWinner} IS NOT DISTINCT FROM excluded.match_winner
            AND ${tournamentKnockoutResultsInCompetition.sourceOrder} IS NOT DISTINCT FROM excluded.source_order
            AND ${tournamentKnockoutResultsInCompetition.knockoutName} IS NOT DISTINCT FROM excluded.knockout_name
            AND ${tournamentKnockoutResultsInCompetition.tiebreak} IS NOT DISTINCT FROM excluded.tiebreak
          `;
          await tx
            .insert(tournamentKnockoutResultsInCompetition)
            .values(
              publication.knockoutRows.map((row) => ({
                ...row,
                seasonId: season.seasonId,
                updatedAt: publication.checkedAt,
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
                sourceCheckedAt: sql`CASE
                  WHEN ${knockoutPayloadUnchanged}
                   AND ${tournamentKnockoutResultsInCompetition.sourceCheckedAt} IS NOT NULL
                    THEN ${tournamentKnockoutResultsInCompetition.sourceCheckedAt}
                  ELSE excluded.source_checked_at
                END`,
                updatedAt: sql`CASE
                  WHEN ${knockoutPayloadUnchanged}
                    THEN ${tournamentKnockoutResultsInCompetition.updatedAt}
                  ELSE excluded.updated_at
                END`,
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
