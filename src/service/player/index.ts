/**
 * Player Service Module
 * Exports the player service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { TeamId } from '../../types/team.type';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createPlayerService } from './service';
import { PlayerService } from './types';

export const playerServiceFactory: ServiceFactory<PlayerService> = {
  create: ({ bootstrapApi, playerRepository, teamService }) =>
    TE.right(
      createPlayerService(bootstrapApi, playerRepository, {
        bootstrapApi,
        teamService: {
          getTeam: (id: number) => teamService.getTeam(id as TeamId),
        },
      }),
    ),
  dependencies: ['bootstrapApi', 'playerRepository', 'teamService'],
};

registry.register(ServiceKey.PLAYER, playerServiceFactory);

export * from './service';
export * from './types';
