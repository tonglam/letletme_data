/**
 * Event Service Entry Module
 *
 * Provides the main entry point for the event service layer.
 * Handles service composition and dependency injection.
 *
 * Features:
 * - Service factory with dependency injection
 * - Integration with Bootstrap API
 * - Automatic cache configuration
 * - Repository integration
 *
 * This module serves as the composition root for the event service,
 * wiring together all required dependencies and providing a clean
 * interface for service consumption.
 */

import type { BootstrapApi } from '../../domains/bootstrap/operations';
import { eventRepository } from '../../domains/events/repository';
import type { BootStrapResponse } from '../../types/bootstrap.type';
import { createEventCache } from './cache';
import { createEventServiceImpl } from './service';
import type { EventService } from './types';

/**
 * Creates a fully configured event service instance.
 * Composes all required dependencies and configurations.
 *
 * @param bootstrapApi - Bootstrap API client with event fetching capability
 * @returns Configured event service instance
 */
export const createEventService = (
  bootstrapApi: BootstrapApi & {
    getBootstrapEvents: () => Promise<BootStrapResponse['events']>;
  },
): EventService => {
  const eventCache = createEventCache(bootstrapApi);

  return createEventServiceImpl({
    bootstrapApi,
    eventCache,
    eventRepository,
  });
};

export type { EventService } from './types';
