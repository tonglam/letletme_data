/**
 * Player Value Service Module
 * Exports the player value service interface and implementation.
 */

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createPlayerValueService } from './service';
import { PlayerValueService } from './types';

export const playerValueServiceFactory: ServiceFactory<PlayerValueService> = {
  create: ({ bootstrapApi, playerValueRepository }) =>
    TE.right(createPlayerValueService(bootstrapApi, playerValueRepository)),
  dependencies: ['bootstrapApi', 'playerValueRepository'],
};

registry.register(ServiceKey.PLAYER_VALUE, playerValueServiceFactory);

export * from './service';
export * from './types';
