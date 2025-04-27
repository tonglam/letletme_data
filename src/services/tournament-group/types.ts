import * as TE from 'fp-ts/TaskEither';
import { TournamentGroups } from 'src/types/domain/tournament-group.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import type { ServiceError } from '../../types/error.type';

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
