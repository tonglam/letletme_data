import * as TE from 'fp-ts/TaskEither';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockoutResults } from 'types/domain/tournament-knockout-result.type';

import type { ServiceError } from 'types/error.type';

export interface TournamentKnockoutResultServiceOperations {
  readonly findKnockoutResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentKnockoutResults>;
}

export interface TournamentKnockoutResultService {
  readonly getKnockoutResultsByTournamentId: (
    tournamentId: TournamentId,
  ) => TE.TaskEither<ServiceError, TournamentKnockoutResults>;
}
