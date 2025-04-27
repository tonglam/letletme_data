import * as TE from 'fp-ts/TaskEither';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import type { ServiceError } from '../../types/error.type';

export interface TournamentServiceOperations {
  readonly drawTournamentGroups: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
  readonly drawTournamentKnockouts: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
  readonly initializeTournament: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
}

export interface TournamentService {
  readonly drawTournamentGroups: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
  readonly drawTournamentKnockouts: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
  readonly initializeTournament: (id: TournamentId) => TE.TaskEither<ServiceError, void>;
}
