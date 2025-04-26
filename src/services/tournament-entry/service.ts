import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import {
  TournamentEntryService,
  TournamentEntryServiceOperations,
} from 'services/tournament-entry/types';
import { TournamentEntryRepository } from 'src/repositories/tournament-entry/types';
import { LeagueId } from 'src/types/domain/league.type';
import { TournamentEntries } from 'src/types/domain/tournament-entry.type';
import { TournamentId } from 'src/types/domain/tournament-info.type';

import { createDomainError, DomainErrorCode, ServiceError } from '../../types/error.type';
import { mapDBErrorToServiceError, mapDomainErrorToServiceError } from '../../utils/error.util';

const tournamentEntryServiceOperations = (
  repository: TournamentEntryRepository,
): TournamentEntryServiceOperations => {
  const findByTournamentId = (id: TournamentId): TE.TaskEither<ServiceError, TournamentEntries> =>
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
      )((tournamentEntries): Option<TournamentEntries> => O.fromNullable(tournamentEntries)),
    );

  const createTournamentEntriesFromApi = (id: LeagueId): TE.TaskEither<ServiceError, void> =>
    pipe();

  return {
    findByTournamentId,
    createTournamentEntriesFromApi,
  };
};

export const createTournamentEntryService = (
  repository: TournamentEntryRepository,
): TournamentEntryService => {
  const ops = tournamentEntryServiceOperations(repository);

  return {
    getEntriesByTournamentId: (id: TournamentId): TE.TaskEither<ServiceError, TournamentEntries> =>
      ops.findByTournamentId(id),
    createTournamentEntriesFromApi: (id: LeagueId): TE.TaskEither<ServiceError, void> =>
      ops.createTournamentEntriesFromApi(id),
  };
};
