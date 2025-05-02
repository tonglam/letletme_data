import * as TE from 'fp-ts/TaskEither';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentPointsGroupResults } from 'types/domain/tournament-points-group-result.type';
import { ServiceError } from 'types/error.type';

export interface TournamentPointsGroupResultServiceOperations {
  readonly findPointsGroupResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentPointsGroupResults>;
}

export interface TournamentPointsGroupResultService {
  readonly getPointsGroupResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentPointsGroupResults>;
}
