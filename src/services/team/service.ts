import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { FplBootstrapDataService } from 'src/data/types';
import { PrismaTeamCreate } from 'src/repositories/team/type';

import { TeamService, TeamServiceOperations } from './types';
import { createTeamOperations } from '../../domains/team/operation';
import { TeamCache, TeamOperations, TeamRepository } from '../../domains/team/types';
import { Team, TeamId, Teams } from '../../types/domain/team.type';
import { DataLayerError, ServiceError } from '../../types/error.type';
import {
  createServiceIntegrationError,
  mapDomainErrorToServiceError,
} from '../../utils/error.util';

const teamServiceOperations = (
  domainOps: TeamOperations,
  fplDataService: FplBootstrapDataService,
): TeamServiceOperations => ({
  findAllTeams: () =>
    pipe(domainOps.getAllTeams(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Teams
    >,

  findTeamById: (id: TeamId) =>
    pipe(domainOps.getTeamById(id), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Team | null
    >,

  syncTeamsFromApi: () =>
    pipe(
      fplDataService.getTeams(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch teams from API',
          cause: error,
          details: error.details,
        }),
      ),
      TE.map((rawData) => mapRawDataToTeamCreateArray(rawData)),
      TE.chain((teamCreateData) =>
        pipe(domainOps.saveTeams(teamCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
    ) as TE.TaskEither<ServiceError, Teams>,
});

const mapRawDataToTeamCreateArray = (rawData: Teams): PrismaTeamCreate[] => {
  return rawData.map((team) => team as PrismaTeamCreate);
};

export const createTeamService = (
  fplDataService: FplBootstrapDataService,
  repository: TeamRepository,
  cache: TeamCache,
): TeamService => {
  const domainOps = createTeamOperations(repository, cache);
  const ops = teamServiceOperations(domainOps, fplDataService);

  return {
    getTeams: () => ops.findAllTeams(),
    getTeam: (id: TeamId) => ops.findTeamById(id),
    syncTeamsFromApi: () => ops.syncTeamsFromApi(),
  };
};
