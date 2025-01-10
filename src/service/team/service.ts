// Team Service Module
// Provides business logic for Team operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createTeamOperations } from '../../domain/team/operation';
import { TeamCache, TeamOperations } from '../../domain/team/types';
import { APIError, ServiceError } from '../../types/error.type';
import {
  Team,
  TeamId,
  TeamRepository,
  TeamResponse,
  Teams,
  toDomainTeam,
} from '../../types/team.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  TeamService,
  TeamServiceDependencies,
  TeamServiceOperations,
  TeamServiceWithWorkflows,
} from './types';
import { teamWorkflows } from './workflow';

// Implementation of service operations
const teamServiceOperations = (domainOps: TeamOperations): TeamServiceOperations => ({
  findAllTeams: () =>
    pipe(domainOps.getAllTeams(), TE.mapLeft(mapDomainError)) as TE.TaskEither<ServiceError, Teams>,

  findTeamById: (id: TeamId) =>
    pipe(domainOps.getTeamById(id), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Team | null
    >,

  syncTeamsFromApi: (bootstrapApi: TeamServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapTeams(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch teams from API',
          cause: error,
        }),
      ),
      TE.chain((teams: readonly TeamResponse[]) =>
        pipe(
          TE.right(teams.map(toDomainTeam)),
          TE.chain((domainTeams) =>
            pipe(
              domainOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() => pipe(domainOps.createTeams(domainTeams), TE.mapLeft(mapDomainError))),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, Teams>,
});

export const createTeamService = (
  bootstrapApi: TeamServiceDependencies['bootstrapApi'],
  repository: TeamRepository,
  cache: TeamCache = {
    getAllTeams: () => TE.right([]),
    getTeam: () => TE.right(null),
    warmUp: () => TE.right(undefined),
    cacheTeam: () => TE.right(undefined),
    cacheTeams: () => TE.right(undefined),
  },
): TeamServiceWithWorkflows => {
  const domainOps = createTeamOperations(repository, cache);
  const ops = teamServiceOperations(domainOps);

  const service: TeamService = {
    getTeams: () => ops.findAllTeams(),
    getTeam: (id: TeamId) => ops.findTeamById(id),
    saveTeams: (teams: Teams) => pipe(domainOps.createTeams(teams), TE.mapLeft(mapDomainError)),
    syncTeamsFromApi: () => ops.syncTeamsFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: teamWorkflows(service),
  };
};
