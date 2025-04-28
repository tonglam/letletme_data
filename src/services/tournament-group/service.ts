import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TournamentGroupRepository } from 'repositories/tournament-group/types';
import {
  TournamentGroupService,
  TournamentGroupServiceOperations,
} from 'services/tournament-group/types';
import { TournamentGroups } from 'types/domain/tournament-group.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDomainError, DomainErrorCode, ServiceError } from 'types/error.type';
import { mapDomainErrorToServiceError, mapDBErrorToServiceError } from 'utils/error.util';

const tournamentGroupServiceOperations = (
  repository: TournamentGroupRepository,
): TournamentGroupServiceOperations => {
  const findGroupsByTournamentId = (
    id: TournamentId,
  ): TE.TaskEither<ServiceError, TournamentGroups> =>
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
      )((tournamentGroups): Option<TournamentGroups> => O.fromNullable(tournamentGroups)),
    );

  return {
    findGroupsByTournamentId,
  };
};

export const createTournamentGroupService = (
  repository: TournamentGroupRepository,
): TournamentGroupService => {
  const ops = tournamentGroupServiceOperations(repository);

  return {
    getGroupsByTournamentId: (id: TournamentId): TE.TaskEither<ServiceError, TournamentGroups> =>
      ops.findGroupsByTournamentId(id),
  };
};
