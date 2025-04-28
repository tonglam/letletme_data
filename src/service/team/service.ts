import { createTeamOperations } from 'domain/team/operation';
import { TeamCache, TeamOperations } from 'domain/team/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { TeamCreateInputs, TeamRepository } from 'repository/team/types';
import { TeamService, TeamServiceOperations } from 'service/team/types';
import { Team, TeamId, Teams } from 'types/domain/team.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const teamServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: TeamOperations,
  cache: TeamCache,
): TeamServiceOperations => {
  const findTeamById = (id: TeamId): TE.TaskEither<ServiceError, Team> =>
    pipe(
      cache.getAllTeams(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Team with ID ${id} not found in cache after fetching all.`,
          }),
        ),
      )((teams) => O.fromNullable(teams.find((team) => team.id === id))),
    );

  const findAllTeams = (): TE.TaskEither<ServiceError, Teams> =>
    pipe(cache.getAllTeams(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncTeamsFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getTeams(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch teams from API',
          cause: error,
          details: error.details,
        }),
      ),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteAllTeams(), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((teamsCreateData: TeamCreateInputs) =>
        pipe(domainOps.saveTeams(teamsCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainFirstW((savedTeams: Teams) =>
        pipe(cache.setAllTeams(savedTeams), TE.mapLeft(mapDomainErrorToServiceError)),
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
  const domainOps = createTeamOperations(repository);
  const ops = teamServiceOperations(fplDataService, domainOps, cache);

  return {
    getTeam: (id: TeamId): TE.TaskEither<ServiceError, Team> => ops.findTeamById(id),
    getTeams: (): TE.TaskEither<ServiceError, Teams> => ops.findAllTeams(),
    syncTeamsFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncTeamsFromApi(),
  };
};
