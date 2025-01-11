/**
 * Player Stat Service Module
 * Exports the player stat service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createPlayerStatService } from './service';
import { PlayerStatService } from './types';

export const playerStatServiceFactory: ServiceFactory<PlayerStatService> = {
  create: ({ bootstrapApi, playerStatRepository, eventOperations }) =>
    TE.right(createPlayerStatService(bootstrapApi, playerStatRepository, eventOperations)),
  dependencies: ['bootstrapApi', 'playerStatRepository', 'eventOperations'],
};

registry.register(ServiceKey.PLAYER_STAT, playerStatServiceFactory);

export * from './service';
export * from './types';
