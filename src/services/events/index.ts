import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCacheOperations } from '../../domains/events/cache';
import { eventRepository } from '../../domains/events/repository';
import { initializeEventCache } from './cache';
import { createEventServiceImpl } from './service';
import type { EventService } from './types';

export const createEventService = (bootstrapApi: BootstrapApi): EventService => {
  const eventCache: EventCacheOperations | undefined = initializeEventCache(bootstrapApi);

  return createEventServiceImpl({
    bootstrapApi,
    eventCache,
    eventRepository,
  });
};

export type { EventService } from './types';
