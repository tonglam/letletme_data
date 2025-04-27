import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentPointsGroupResultService,
  TournamentPointsGroupResultServiceOperations,
} from 'services/tournament-points-group-result/types';
import { TournamentPointsGroupResultRepository } from 'src/repositories/tournament-points-group-result/types';
import { TournamentId } from 'src/types/domain/tournament-info.type';
import { TournamentPointsGroupResults } from 'src/types/domain/tournament-points-group-result.type';

import { createDomainError, DomainErrorCode, ServiceError } from '../../types/error.type';
import { mapDomainErrorToServiceError, mapDBErrorToServiceError } from '../../utils/error.util';

const tournamentPointsGroupResultServiceOperations = (
  repository: TournamentPointsGroupResultRepository,
): TournamentPointsGroupResultServiceOperations => {
  const findPointsGroupResultsByTournamentId = (
    id: TournamentId,
  ): TE.TaskEither<ServiceError, TournamentPointsGroupResults> =>
    pipe(
      repository.findByTournamentId(id),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapDomainErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `TournamentEntry with ID ${id} not found.`,
            }),
          ),
      )(
        (tournamentPointsGroupResults): Option<TournamentPointsGroupResults> =>
          O.fromNullable(tournamentPointsGroupResults),
      ),
    );

  return {
    findPointsGroupResultsByTournamentId,
  };
};

export const createTournamentPointsGroupResultService = (
  repository: TournamentPointsGroupResultRepository,
): TournamentPointsGroupResultService => {
  const ops = tournamentPointsGroupResultServiceOperations(repository);

  return {
    getPointsGroupResultsByTournamentId: (
      id: TournamentId,
    ): TE.TaskEither<ServiceError, TournamentPointsGroupResults> =>
      ops.findPointsGroupResultsByTournamentId(id),
  };
};
