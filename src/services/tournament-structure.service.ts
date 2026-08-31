import type {
  DbTournamentGroupInsert,
  DbTournamentKnockoutInsert,
  DbTournamentKnockoutResultInsert,
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
  const localResultSourceCheckedAt = new Date();
  const knockoutResults: DbTournamentKnockoutResultInsert[] = knockoutRows.results.map((row) => ({
    tournamentId: row.tournament_id,
    eventId: row.event_id,
    matchId: row.match_id,
    playAgainstId: row.play_against_id,
    homeEntryId: row.home_entry_id,
    awayEntryId: row.away_entry_id,
    // These rows are locally computed fixtures. Keep a durable computation
    // timestamp from the moment the structure is materialised; the result
    // sync refreshes it after finalized event inputs are available.
    sourceCheckedAt: localResultSourceCheckedAt,
  }));
  const publishedKnockoutResults = isOfficialH2HTournament(tournament) ? [] : knockoutResults;

  const db = await getDb();
  await db.transaction(async (tx) => {
    const groups = createTournamentGroupRepository(tx);
    const points = createTournamentPointsGroupResultsRepository(tx);
    const battles = createTournamentBattleGroupResultsRepository(tx);
    const knockouts = createTournamentKnockoutsRepository(tx);
    const knockoutResultsRepository = createTournamentKnockoutResultsRepository(tx);

    await knockoutResultsRepository.deleteByTournament(season, tournament.id);
    await knockouts.deleteByTournament(season, tournament.id);
    await points.deleteByTournament(season, tournament.id);
    await battles.deleteByTournament(season, tournament.id);
    await groups.deleteByTournament(season, tournament.id);

    await groups.upsertBatch(season, groupRows);
    await knockouts.upsertBatch(season, knockoutMatches);
    await knockoutResultsRepository.upsertBatch(season, publishedKnockoutResults);
  });
}
