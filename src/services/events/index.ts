// Event Service Entry Module
// Provides the main entry point for the event service layer.
// Handles service composition and dependency injection,
// wiring together all required dependencies.

import type { BootstrapApi } from '../../domains/bootstrap/operations';
import { eventRepository } from '../../domains/events/repository';
import type { BootStrapResponse } from '../../types/bootstrap.type';
import { createEventService as createEventServiceImpl } from './service';
import type { EventService } from './types';

// Creates a fully configured event service instance.
export const createEventService = (
  bootstrapApi: BootstrapApi & {
    getBootstrapEvents: () => Promise<BootStrapResponse['events']>;
  },
): EventService => createEventServiceImpl(bootstrapApi, eventRepository);

export type { EventService } from './types';
