import * as TE from 'fp-ts/TaskEither';
import { TournamentBattleGroupResults } from 'src/types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import type { ServiceError } from '../../types/error.type';

export interface TournamentBattleGroupResultServiceOperations {
  readonly findBattleGroupResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentBattleGroupResults>;
}

export interface TournamentBattleGroupResultService {
  readonly getBattleGroupResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentBattleGroupResults>;
}
