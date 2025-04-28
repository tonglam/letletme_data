import * as TE from 'fp-ts/TaskEither';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockouts } from 'types/domain/tournament-knockout.type';

import type { ServiceError } from 'types/error.type';

export interface TournamentKnockoutServiceOperations {
  readonly findKnockoutsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentKnockouts>;
}

export interface TournamentKnockoutService {
  readonly getKnockoutsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentKnockouts>;
}
