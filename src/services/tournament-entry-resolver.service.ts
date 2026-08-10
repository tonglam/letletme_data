import type { TournamentInfoSummary } from '../repositories/tournament-infos';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import type { FplSeasonRef } from '../domain/fpl-season';
import { uniqueNumbers } from '../utils/async';

export interface TournamentEntryResolverDependencies {
  findStoredEntryIds: (season: FplSeasonRef, tournamentId: number) => Promise<number[]>;
}

const defaultDependencies: TournamentEntryResolverDependencies = {
  findStoredEntryIds: (season, tournamentId) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournamentId),
};

/** Tournament membership rows are the only source used by downstream jobs. */
export async function resolveTournamentEntryIds(
  season: FplSeasonRef,
  tournament: TournamentInfoSummary,
  dependencies: TournamentEntryResolverDependencies = defaultDependencies,
): Promise<number[]> {
  return uniqueNumbers(await dependencies.findStoredEntryIds(season, tournament.id));
}
