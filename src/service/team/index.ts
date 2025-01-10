/**
 * Team Service Module
 * Exports the team service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createTeamService } from './service';
import { TeamService } from './types';

export const teamServiceFactory: ServiceFactory<TeamService> = {
  create: ({ bootstrapApi, teamRepository }) =>
    TE.right(createTeamService(bootstrapApi, teamRepository)),
  dependencies: ['bootstrapApi', 'teamRepository'],
};

registry.register(ServiceKey.TEAM, teamServiceFactory);

export * from './service';
export * from './types';
