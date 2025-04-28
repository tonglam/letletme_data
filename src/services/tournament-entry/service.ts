import { FplClassicLeagueDataService, FplH2hLeagueDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TaskEither } from 'fp-ts/TaskEither';
import { TournamentEntryRepository } from 'repositories/tournament-entry/types';
import {
  TournamentEntryService,
  TournamentEntryServiceOperations,
} from 'services/tournament-entry/types';
import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { ClassicLeague, H2hLeague, LeagueId } from 'types/domain/league.type';
import { TournamentEntries, TournamentEntry } from 'types/domain/tournament-entry.type';
import { TournamentId } from 'types/domain/tournament-info.type';
import { createDomainError, DomainErrorCode, ServiceError } from 'types/error.type';
import {
  mapDomainErrorToServiceError,
  mapDataLayerErrorToServiceError,
  mapDBErrorToServiceError,
} from 'utils/error.util';

const tournamentEntryServiceOperations = (
  fplClassicLeagueDataService: FplClassicLeagueDataService,
  fplH2hLeagueDataService: FplH2hLeagueDataService,
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

  const findAllTournamentEntryIds = (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> =>
    pipe(
      repository.findAllTournamentEntryIds(),
      TE.mapLeft(mapDBErrorToServiceError),
      TE.map((entryIds) => entryIds.map((entryId) => entryId)),
    );

  const createTournamentEntriesFromApi = (
    id: TournamentId,
    leagueId: LeagueId,
    leagueType: LeagueType,
  ): TE.TaskEither<ServiceError, void> => {
    const fetchLeagueTask: TaskEither<ServiceError, ClassicLeague | H2hLeague> =
      leagueType === LeagueType.Classic
        ? pipe(
            fplClassicLeagueDataService.getClassicLeague(leagueId),
            TE.mapLeft(mapDataLayerErrorToServiceError),
          )
        : pipe(
            fplH2hLeagueDataService.getH2hLeague(leagueId),
            TE.mapLeft(mapDataLayerErrorToServiceError),
          );

    return pipe(
      fetchLeagueTask,
      TE.chain((league) => {
        const entriesToSave: TournamentEntry[] = league.standings.map((result) => ({
          tournamentId: id,
          leagueId,
          entryId: result.entryId,
        }));

        return pipe(
          repository.saveBatchByTournamentId(entriesToSave),
          TE.mapLeft(mapDBErrorToServiceError),
          TE.map(() => undefined),
        );
      }),
    );
  };

  return {
    findByTournamentId,
    findAllTournamentEntryIds,
    createTournamentEntriesFromApi,
  };
};

export const createTournamentEntryService = (
  fplClassicLeagueDataService: FplClassicLeagueDataService,
  fplH2hLeagueDataService: FplH2hLeagueDataService,
  repository: TournamentEntryRepository,
): TournamentEntryService => {
  const ops = tournamentEntryServiceOperations(
    fplClassicLeagueDataService,
    fplH2hLeagueDataService,
    repository,
  );

  return {
    getEntriesByTournamentId: (id: TournamentId): TE.TaskEither<ServiceError, TournamentEntries> =>
      ops.findByTournamentId(id),
    getAllTournamentEntryIds: (): TE.TaskEither<ServiceError, ReadonlyArray<EntryId>> =>
      ops.findAllTournamentEntryIds(),
    createTournamentEntriesFromApi: (
      id: TournamentId,
      leagueId: LeagueId,
      leagueType: LeagueType,
    ): TE.TaskEither<ServiceError, void> =>
      ops.createTournamentEntriesFromApi(id, leagueId, leagueType),
  };
};
