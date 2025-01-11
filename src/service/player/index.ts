/**
 * Player Service Module
 * Exports the player service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createPlayerService } from './service';
import { PlayerService } from './types';

export const playerServiceFactory: ServiceFactory<PlayerService> = {
  create: ({ bootstrapApi, playerRepository }) =>
    TE.right(createPlayerService(bootstrapApi, playerRepository)),
  dependencies: ['bootstrapApi', 'playerRepository'],
};

registry.register(ServiceKey.PLAYER, playerServiceFactory);

export * from './service';
export * from './types';
