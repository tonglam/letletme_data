// Event Service Entry Module
// Provides the main entry point for the event service layer.
// Handles service composition and dependency injection.

import * as TE from 'fp-ts/TaskEither';
import { ServiceKey } from '../index';
import { registry, ServiceFactory } from '../registry';
import { createEventService } from './service';
import { EventService } from './types';

export const eventServiceFactory: ServiceFactory<EventService> = {
  create: ({ bootstrapApi, eventRepository }) =>
    TE.right(createEventService(bootstrapApi, eventRepository)),
  dependencies: ['bootstrapApi', 'eventRepository'],
};

registry.register(ServiceKey.EVENT, eventServiceFactory);

export * from './service';
export * from './types';
