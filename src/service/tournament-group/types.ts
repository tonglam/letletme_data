import * as TE from 'fp-ts/TaskEither';
import { TournamentGroups } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { ServiceError } from 'types/error.type';

export interface TournamentGroupServiceOperations {
  readonly findGroupsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentGroups>;
}

export interface TournamentGroupService {
  readonly getGroupsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentGroups>;
}
