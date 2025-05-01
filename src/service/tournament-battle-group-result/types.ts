import * as TE from 'fp-ts/TaskEither';
import { TournamentBattleGroupResults } from 'types/domain/tournament-battle-group-result.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { ServiceError } from 'types/error.type';

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
