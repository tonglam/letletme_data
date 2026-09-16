import type {
  DbTournamentGroupInsert,
  DbTournamentKnockoutInsert,
  DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import { sql } from 'drizzle-orm';
import {
  tournamentBattleGroupResultsInCompetition,
  tournamentGroupsInCompetition,
  tournamentKnockoutResultsInCompetition,
  tournamentKnockoutsInCompetition,
  tournamentPointsGroupResultsInCompetition,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  buildGroupRows,
  buildKnockoutRows,
  isOfficialH2HTournament,
  seedBracketEntries,
  sortEntrySeeds,
  type EntrySeed,
  type TournamentConfig,
} from '../domain/tournament';
import { createTournamentBattleGroupResultsRepository } from '../repositories/tournament-battle-group-results';
import { createTournamentGroupRepository } from '../repositories/tournament-groups';
import { createTournamentKnockoutResultsRepository } from '../repositories/tournament-knockout-results';
import { createTournamentKnockoutsRepository } from '../repositories/tournament-knockouts';
import { createTournamentPointsGroupResultsRepository } from '../repositories/tournament-points-group-results';

export type DerivedResultRepairSnapshot = {
  points: Array<{ sourceResultId: number; updatedAt: Date }>;
  battle: Array<{ sourceResultId: number; updatedAt: Date }>;
  knockout: Array<{ sourceResultId: number; updatedAt: Date }>;
};

function groupInsert(row: Record<string, number | string | null>): DbTournamentGroupInsert {
  return {
    tournamentId: Number(row.tournament_id),
    groupId: Number(row.group_id),
    groupName: String(row.group_name),
    groupIndex: Number(row.group_index),
    entryId: Number(row.entry_id),
    startedEventId: Number(row.started_event_id),
    endedEventId: Number(row.ended_event_id),
    groupPoints: Number(row.group_points),
    groupRank: row.group_rank === null ? null : Number(row.group_rank),
    played: Number(row.played),
    won: Number(row.won),
    drawn: Number(row.drawn),
    lost: Number(row.lost),
    totalPoints: Number(row.total_points),
    totalTransfersCost: Number(row.total_transfers_cost),
    totalNetPoints: Number(row.total_net_points),
    qualified: Number(row.qualified),
    overallRank: row.overall_rank === null ? null : Number(row.overall_rank),
  };
}

export async function rebuildTournamentStructure(
  season: FplSeasonRef,
  tournament: TournamentConfig,
  entrySeeds: EntrySeed[],
  options: Readonly<{ preserveDerivedResults?: boolean }> = {},
): Promise<void> {
  const entryIds = sortEntrySeeds(entrySeeds).map((entry) => entry.entryId);
  const shouldSeedRoundOneImmediately =
    tournament.knockoutMode !== 'no_knockout' && tournament.groupMode === 'no_group';
  const seededRoundOne =
    shouldSeedRoundOneImmediately && tournament.knockoutTeamNum
      ? seedBracketEntries(entryIds, tournament.knockoutTeamNum)
      : null;
  const groupRows =
    tournament.groupMode === 'no_group'
      ? []
      : buildGroupRows(tournament, entrySeeds).map(groupInsert);
  const knockoutRows =
    tournament.knockoutMode === 'no_knockout'
      ? { matches: [], results: [] }
      : buildKnockoutRows(tournament, seededRoundOne);
  const knockoutMatches: DbTournamentKnockoutInsert[] = knockoutRows.matches.map((row) => ({
    tournamentId: row.tournament_id,
    round: row.round,
    startedEventId: row.started_event_id,
    endedEventId: row.ended_event_id,
    matchId: row.match_id,
    nextMatchId: row.next_match_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
  }));
  const knockoutResults: DbTournamentKnockoutResultInsert[] = knockoutRows.results.map((row) => ({
    tournamentId: row.tournament_id,
    eventId: row.event_id,
    matchId: row.match_id,
    playAgainstId: row.play_against_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    // Structure creation is not source evidence. Leave the watermark empty
    // until a finalized event result has actually been observed; a local
    // wall-clock timestamp could be newer than the provider timestamp and
    // block that first real result under the stale-input guard.
    sourceCheckedAt: null,
  }));
  const publishedKnockoutResults = isOfficialH2HTournament(tournament) ? [] : knockoutResults;

  const db = await getDb();
  await db.transaction(async (tx) => {
    const groups = createTournamentGroupRepository(tx);
    const points = createTournamentPointsGroupResultsRepository(tx);
    const battles = createTournamentBattleGroupResultsRepository(tx);
    const knockouts = createTournamentKnockoutsRepository(tx);
    const knockoutResultsRepository = createTournamentKnockoutResultsRepository(tx);

    await knockouts.deleteByTournament(season, tournament.id);
    if (!options.preserveDerivedResults) {
      await knockoutResultsRepository.deleteByTournament(season, tournament.id);
      await points.deleteByTournament(season, tournament.id);
      await battles.deleteByTournament(season, tournament.id);
    }
    await groups.deleteByTournament(season, tournament.id);

    await groups.upsertBatch(season, groupRows);
    await knockouts.upsertBatch(season, knockoutMatches);
    await knockoutResultsRepository.upsertBatch(season, publishedKnockoutResults);
  });
}

/**
 * Capture only derived rows that were already invalid against the canonical
 * topology before a structure repair. The snapshot is used after the
 * replacement/backfill phase so a failed repair never clears visible history,
 * and a row rewritten by the new calculation is not mistaken for stale data.
 */
export async function snapshotDerivedResultsInvalidBeforeStructureRepair(
  season: FplSeasonRef,
  tournamentId: number,
): Promise<DerivedResultRepairSnapshot> {
  const db = await getDb();
  const [groups, points, battles, knockoutResults, knockouts] = await Promise.all([
    db
      .select({
        groupId: tournamentGroupsInCompetition.groupId,
        entryId: tournamentGroupsInCompetition.entryId,
        startedEventId: tournamentGroupsInCompetition.startedEventId,
        endedEventId: tournamentGroupsInCompetition.endedEventId,
      })
      .from(tournamentGroupsInCompetition)
      .where(
        sql`${tournamentGroupsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentGroupsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentPointsGroupResultsInCompetition.sourceResultId,
        groupId: tournamentPointsGroupResultsInCompetition.groupId,
        eventId: tournamentPointsGroupResultsInCompetition.eventId,
        entryId: tournamentPointsGroupResultsInCompetition.entryId,
        updatedAt: tournamentPointsGroupResultsInCompetition.updatedAt,
      })
      .from(tournamentPointsGroupResultsInCompetition)
      .where(
        sql`${tournamentPointsGroupResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentPointsGroupResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentBattleGroupResultsInCompetition.sourceResultId,
        groupId: tournamentBattleGroupResultsInCompetition.groupId,
        eventId: tournamentBattleGroupResultsInCompetition.eventId,
        homeEntryId: tournamentBattleGroupResultsInCompetition.homeEntryId,
        awayEntryId: tournamentBattleGroupResultsInCompetition.awayEntryId,
        updatedAt: tournamentBattleGroupResultsInCompetition.updatedAt,
      })
      .from(tournamentBattleGroupResultsInCompetition)
      .where(
        sql`${tournamentBattleGroupResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentBattleGroupResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        sourceResultId: tournamentKnockoutResultsInCompetition.sourceResultId,
        eventId: tournamentKnockoutResultsInCompetition.eventId,
        matchId: tournamentKnockoutResultsInCompetition.matchId,
        playAgainstId: tournamentKnockoutResultsInCompetition.playAgainstId,
        updatedAt: tournamentKnockoutResultsInCompetition.updatedAt,
      })
      .from(tournamentKnockoutResultsInCompetition)
      .where(
        sql`${tournamentKnockoutResultsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentKnockoutResultsInCompetition.tournamentId} = ${tournamentId}`,
      ),
    db
      .select({
        matchId: tournamentKnockoutsInCompetition.matchId,
        startedEventId: tournamentKnockoutsInCompetition.startedEventId,
        endedEventId: tournamentKnockoutsInCompetition.endedEventId,
      })
      .from(tournamentKnockoutsInCompetition)
      .where(
        sql`${tournamentKnockoutsInCompetition.seasonId} = ${season.seasonId}
          AND ${tournamentKnockoutsInCompetition.tournamentId} = ${tournamentId}`,
      ),
  ]);

  const ownsGroupEntry = (groupId: number, entryId: number, eventId: number): boolean =>
    groups.some(
      (group) =>
        group.groupId === groupId &&
        group.entryId === entryId &&
        group.startedEventId !== null &&
        group.endedEventId !== null &&
        eventId >= group.startedEventId &&
        eventId <= group.endedEventId,
    );
  const ownsGroup = (groupId: number, eventId: number): boolean =>
    groups.some(
      (group) =>
        group.groupId === groupId &&
        group.startedEventId !== null &&
        group.endedEventId !== null &&
        eventId >= group.startedEventId &&
        eventId <= group.endedEventId,
    );

  return {
    points: points
      .filter((result) => !ownsGroupEntry(result.groupId, result.entryId, result.eventId))
      .map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
    battle: battles
      .filter(
        (result) =>
          !ownsGroup(result.groupId, result.eventId) ||
          (result.homeEntryId !== null &&
            !ownsGroupEntry(result.groupId, result.homeEntryId, result.eventId)) ||
          (result.awayEntryId !== null &&
            !ownsGroupEntry(result.groupId, result.awayEntryId, result.eventId)),
      )
      .map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
    knockout: knockoutResults
      .filter((result) => {
        const match = knockouts.find((candidate) => candidate.matchId === result.matchId);
        return (
          !match ||
          match.startedEventId === null ||
          result.eventId < match.startedEventId ||
          (match.endedEventId !== null && result.eventId > match.endedEventId) ||
          result.playAgainstId !== result.eventId - match.startedEventId + 1
        );
      })
      .map(({ sourceResultId, updatedAt }) => ({ sourceResultId, updatedAt })),
  };
}

/**
 * Remove only derived rows that no longer have a canonical topology owner.
 * Structure repair keeps the old derived set while the history backfill runs;
 * this cleanup is called only after that backfill converges, so a failed
 * candidate never turns a visible history into an empty set.
 */
export async function pruneTournamentDerivedResultsOutsideStructure(
  season: FplSeasonRef,
  tournamentId: number,
  snapshot: DerivedResultRepairSnapshot = { points: [], battle: [], knockout: [] },
): Promise<void> {
  const db = await getDb();
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM ${tournamentPointsGroupResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND NOT EXISTS (
          SELECT 1
          FROM ${tournamentGroupsInCompetition} AS group_row
          WHERE group_row.season_id = result.season_id
            AND group_row.tournament_id = result.tournament_id
            AND group_row.group_id = result.group_id
            AND group_row.entry_id = result.entry_id
            AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
        )
    `);
    await tx.execute(sql`
      DELETE FROM ${tournamentBattleGroupResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND (
          NOT EXISTS (
            SELECT 1
            FROM ${tournamentGroupsInCompetition} AS group_row
            WHERE group_row.season_id = result.season_id
              AND group_row.tournament_id = result.tournament_id
              AND group_row.group_id = result.group_id
              AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
          )
          OR (
            result.home_entry_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
                WHERE group_row.season_id = result.season_id
                  AND group_row.tournament_id = result.tournament_id
                  AND group_row.group_id = result.group_id
                  AND group_row.entry_id = result.home_entry_id
                  AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
          OR (
            result.away_entry_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM ${tournamentGroupsInCompetition} AS group_row
                WHERE group_row.season_id = result.season_id
                  AND group_row.tournament_id = result.tournament_id
                  AND group_row.group_id = result.group_id
                  AND group_row.entry_id = result.away_entry_id
                  AND result.event_id BETWEEN group_row.started_event_id AND group_row.ended_event_id
            )
          )
        )
    `);
    await tx.execute(sql`
      DELETE FROM ${tournamentKnockoutResultsInCompetition} AS result
      WHERE result.season_id = ${season.seasonId}
        AND result.tournament_id = ${tournamentId}
        AND NOT EXISTS (
          SELECT 1
            FROM ${tournamentKnockoutsInCompetition} AS knockout
            WHERE knockout.season_id = result.season_id
              AND knockout.tournament_id = result.tournament_id
              AND knockout.match_id = result.match_id
              AND knockout.started_event_id IS NOT NULL
              AND result.event_id >= knockout.started_event_id
              AND (knockout.ended_event_id IS NULL OR result.event_id <= knockout.ended_event_id)
              AND result.play_against_id = result.event_id - knockout.started_event_id + 1
        )
    `);

    const deleteUnchangedRows = async <T extends { sourceResultId: number; updatedAt: Date }>(
      table:
        | typeof tournamentPointsGroupResultsInCompetition
        | typeof tournamentBattleGroupResultsInCompetition
        | typeof tournamentKnockoutResultsInCompetition,
      rows: T[],
    ) => {
      for (const row of rows) {
        await tx.execute(sql`
          DELETE FROM ${table}
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
            AND source_result_id = ${row.sourceResultId}
            AND updated_at = ${row.updatedAt}
        `);
      }
    };

    await deleteUnchangedRows(tournamentPointsGroupResultsInCompetition, snapshot.points);
    await deleteUnchangedRows(tournamentBattleGroupResultsInCompetition, snapshot.battle);
    await deleteUnchangedRows(tournamentKnockoutResultsInCompetition, snapshot.knockout);
  });
}
