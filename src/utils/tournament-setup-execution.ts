import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentSetupLifecycleScope } from '../domain/mutation-scope';
import {
  tournamentInfoRepository,
  type TournamentSetupExecution,
} from '../repositories/tournament-infos';
import { ConflictError } from './errors';
import { withMutationScopes } from './mutation-scopes';

/** Each phase owns only its canonical writes; provider work belongs before it. */
export function withTournamentSetupPhase<T>(
  season: FplSeasonRef,
  tournamentId: number,
  execution: TournamentSetupExecution,
  phase: string,
  scopes: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  return withMutationScopes(
    {
      queueName: 'tournament-setup',
      jobName: phase,
      tournamentId,
      scopes: [tournamentSetupLifecycleScope(tournamentId), ...scopes],
    },
    async () => {
      if (!(await tournamentInfoRepository.lockSetupExecution(season, tournamentId, execution))) {
        throw new ConflictError(
          'Tournament setup execution was superseded.',
          'TOURNAMENT_SETUP_EXECUTION_STALE',
        );
      }
      return operation();
    },
  );
}
