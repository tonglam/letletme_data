import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TournamentKnockoutRepository } from 'repository/tournament-knockout/types';
import {
  TournamentKnockoutService,
  TournamentKnockoutServiceOperations,
} from 'service/tournament-knockout/types';
import { TournamentId } from 'types/domain/tournament-info.type';
import { TournamentKnockouts } from 'types/domain/tournament-knockout.type';
import { createDomainError, DomainErrorCode, ServiceError } from 'types/error.type';
import { mapCacheErrorToServiceError, mapDBErrorToServiceError } from 'utils/error.util';

const tournamentKnockoutServiceOperations = (
  repository: TournamentKnockoutRepository,
): TournamentKnockoutServiceOperations => {
  const findKnockoutsByTournamentId = (
    id: TournamentId,
  ): TE.TaskEither<ServiceError, TournamentKnockouts> =>
    pipe(
      repository.findByTournamentId(id),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.chainOptionK<ServiceError>(
        (): ServiceError =>
          mapCacheErrorToServiceError(
            createDomainError({
              code: DomainErrorCode.NOT_FOUND,
              message: `TournamentKnockout with ID ${id} not found.`,
            }),
          ),
      )((tournamentKnockouts): Option<TournamentKnockouts> => O.fromNullable(tournamentKnockouts)),
    );

  return {
    findKnockoutsByTournamentId,
  };
};

export const createTournamentKnockoutService = (
  repository: TournamentKnockoutRepository,
): TournamentKnockoutService => {
  const ops = tournamentKnockoutServiceOperations(repository);

  return {
    getKnockoutsByTournamentId: (
      id: TournamentId,
    ): TE.TaskEither<ServiceError, TournamentKnockouts> => ops.findKnockoutsByTournamentId(id),
  };
};
