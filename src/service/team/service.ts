import { TeamCache } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TeamCreateInputs, TeamRepository } from 'repository/team/types';
import { TeamService, TeamServiceOperations } from 'service/team/types';
import { Team, TeamId, Teams } from 'types/domain/team.type';
import { CacheErrorCode, createCacheError, ServiceError } from 'types/error.type';
import {
  mapCacheErrorToServiceError,
  mapDBErrorToServiceError,
  mapDataLayerErrorToServiceError,
} from 'utils/error.util';

const teamServiceOperations = (
  fplDataService: FplBootstrapDataService,
  repository: TeamRepository,
  cache: TeamCache,
): TeamServiceOperations => {
  const findTeamById = (id: TeamId): TE.TaskEither<ServiceError, Team> =>
    pipe(
      cache.getAllTeams(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainOptionK(() =>
        mapCacheErrorToServiceError(
          createCacheError({
            code: CacheErrorCode.NOT_FOUND,
            message: `Team with ID ${id} not found in cache after fetching all.`,
          }),
        ),
      )((teams) => O.fromNullable(teams.find((team) => team.id === id))),
    );

  const findAllTeams = (): TE.TaskEither<ServiceError, Teams> =>
    pipe(cache.getAllTeams(), TE.mapLeft(mapCacheErrorToServiceError));

  const syncTeamsFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getTeams(),
      TE.mapLeft(mapDataLayerErrorToServiceError),
      TE.chainW((teamsCreateData: TeamCreateInputs) =>
        pipe(
          teamsCreateData.length > 0
            ? repository.saveBatch(teamsCreateData)
            : TE.right([] as Teams),
          TE.mapLeft(mapDBErrorToServiceError),
        ),
      ),
      TE.chainFirstW((savedTeams: Teams) =>
        pipe(cache.setAllTeams(savedTeams), TE.mapLeft(mapCacheErrorToServiceError)),
      ),
      TE.map(() => undefined),
    );

  return {
    findTeamById,
    findAllTeams,
    syncTeamsFromApi,
  };
};

export const createTeamService = (
  fplDataService: FplBootstrapDataService,
  repository: TeamRepository,
  cache: TeamCache,
): TeamService => {
  const ops = teamServiceOperations(fplDataService, repository, cache);

  return {
    getTeam: (id: TeamId): TE.TaskEither<ServiceError, Team> => ops.findTeamById(id),
    getTeams: (): TE.TaskEither<ServiceError, Teams> => ops.findAllTeams(),
    syncTeamsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncTeamsFromApi(),
  };
};
