/**
 * Player Service Module
 * Exports the player service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import {
  createPlayerCommandOperations,
  createPlayerQueryOperations,
} from '../../domain/player/operation';
import { DBError, DBErrorCode, ServiceError } from '../../types/error.type';
import { Team, TeamId } from '../../types/team.type';
import { TeamRepository } from '../../types/team/repository.type';
import { ServiceKey } from '../index';
import { registry, ServiceDependencies, ServiceFactory } from '../registry';
import { createPlayerService } from './service';
import { PlayerService } from './types';

const mapServiceErrorToDBError = (error: ServiceError): DBError => ({
  name: 'DBError',
  code: DBErrorCode.OPERATION_ERROR,
  message: error.message,
  timestamp: new Date(),
  cause: error.cause,
});

const createTeamRepositoryAdapter = (deps: ServiceDependencies): TeamRepository => ({
  findById: (id: TeamId) =>
    pipe(deps.teamService.getTeam(id), TE.mapLeft(mapServiceErrorToDBError)),
  findAll: () =>
    pipe(
      deps.teamService.getTeams(),
      TE.mapLeft(mapServiceErrorToDBError),
      TE.map((teams) => Array.from(teams) as Team[]),
    ),
});

export const playerServiceFactory: ServiceFactory<PlayerService> = {
  create: (deps: ServiceDependencies) => {
    // Create domain operations
    const teamRepository = createTeamRepositoryAdapter(deps);
    const queryOps = createPlayerQueryOperations(deps.playerRepository, teamRepository);
    const commandOps = createPlayerCommandOperations(deps.playerRepository);

    // Create and return the service
    return TE.right(createPlayerService(deps.bootstrapApi, queryOps, commandOps));
  },
  dependencies: ['bootstrapApi', 'playerRepository', 'teamService'],
};

registry.register(ServiceKey.PLAYER, playerServiceFactory);

export * from './service';
export * from './types';
