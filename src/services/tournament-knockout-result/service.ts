import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentKnockoutResultService,
  TournamentKnockoutResultServiceOperations,
} from 'services/tournament-knockout-result/types';
import { TournamentKnockoutResultRepository } from 'src/repositories/tournament-knockout-result/types';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentKnockoutResults } from 'src/types/domain/tournament-knockout-result.type';

import { createDomainError, DomainErrorCode, ServiceError } from '../../types/error.type';
import { mapDomainErrorToServiceError, mapDBErrorToServiceError } from '../../utils/error.util';

const tournamentKnockoutResultServiceOperations = (
  repository: TournamentKnockoutResultRepository,
): TournamentKnockoutResultServiceOperations => {
  const findKnockoutResultsByTournamentId = (
    id: TournamentId,
  ): TE.TaskEither<ServiceError, TournamentKnockoutResults> =>
    pipe(
      repository.findByTournamentId(id),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapDomainErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `TournamentKnockoutResult with ID ${id} not found.`,
            }),
          ),
      )(
        (tournamentKnockoutResults): Option<TournamentKnockoutResults> =>
          O.fromNullable(tournamentKnockoutResults),
      ),
    );

  return {
    findKnockoutResultsByTournamentId,
  };
};

export const createTournamentKnockoutResultService = (
  repository: TournamentKnockoutResultRepository,
): TournamentKnockoutResultService => {
  const ops = tournamentKnockoutResultServiceOperations(repository);

  return {
    getKnockoutResultsByTournamentId: (
      id: TournamentId,
    ): TE.TaskEither<ServiceError, TournamentKnockoutResults> =>
      ops.findKnockoutResultsByTournamentId(id),
  };
};
