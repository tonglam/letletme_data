import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import {
  tournamentSetupIssueRepository,
  type TournamentRepairState,
} from '../repositories/tournament-setup-issues';
import { ConflictError } from './errors';
import { withMutationScopes } from './mutation-scopes';

/** Validate the observed issue and tournament before a short canonical phase. */
export function withTournamentRepairPhase<T>(
  season: FplSeasonRef,
  issueId: number,
  owner: TournamentRepairState,
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return withMutationScopes(
    {
      queueName: 'tournament-repair',
      jobName: 'repair-phase',
      tournamentId: owner.tournamentId,
      scopes: [tournamentSetupLifecycleScope(owner.tournamentId), ...scopes],
    },
    async () => {
      const current = await tournamentSetupIssueRepository.lockRepairState(season, issueId);
      if (
        !current ||
        current.issueRevision !== owner.issueRevision ||
        current.tournamentState !== owner.tournamentState
      ) {
        throw new ConflictError('Tournament repair was superseded.', 'TOURNAMENT_REPAIR_STALE');
      }
      return operation();
    },
  );
}
