import type { TournamentInfoSummary } from '../repositories/tournament-infos';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import type { FplSeasonRef } from '../domain/fpl-season';
import { uniqueNumbers } from '../utils/async';
import { fetchLeagueParticipantsById } from './tournament-league-members.service';

export interface TournamentEntryResolverDependencies {
  findStoredEntryIds: (season: FplSeasonRef, tournamentId: number) => Promise<number[]>;
  fetchAuthoritativeEntryIds: (tournament: TournamentInfoSummary) => Promise<number[]>;
}

const defaultDependencies: TournamentEntryResolverDependencies = {
  findStoredEntryIds: (season, tournamentId) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournamentId),
  fetchAuthoritativeEntryIds: async (tournament) => {
    const source = await fetchLeagueParticipantsById(tournament.leagueId, tournament.leagueType);
    return source.participants.map((participant) => Number(participant.id));
  },
};

/**
 * Tournament membership rows are canonical. The bounded official-league
 * fallback exists only for legacy tournaments created before those rows were
 * guaranteed; an upstream failure never replaces or partially mutates them.
 */
export async function resolveTournamentEntryIds(
  season: FplSeasonRef,
  tournament: TournamentInfoSummary,
  dependencies: TournamentEntryResolverDependencies = defaultDependencies,
): Promise<number[]> {
  const storedEntries = uniqueNumbers(await dependencies.findStoredEntryIds(season, tournament.id));
  if (storedEntries.length > 0) return storedEntries;

  const authoritative = uniqueNumbers(await dependencies.fetchAuthoritativeEntryIds(tournament));
  const maxEntries = tournament.totalTeamNum > 0 ? tournament.totalTeamNum : undefined;
  return maxEntries ? authoritative.slice(0, maxEntries) : authoritative;
}
