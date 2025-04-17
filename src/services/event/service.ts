import { createEventOperations } from 'domains/event/operation';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { EventService, EventServiceOperations } from './types';
import { FplBootstrapDataService } from '../../data/types';
import { EventCache, EventOperations, EventRepository } from '../../domains/event/types';
import { PrismaEventCreate } from '../../repositories/event/type';
import { Event, EventId, Events } from '../../types/domain/event.type';
import { DataLayerError, ServiceError } from '../../types/error.type';
import {
  createServiceIntegrationError,
  mapDomainErrorToServiceError,
} from '../../utils/error.util';

const eventServiceOperations = (
  domainOps: EventOperations,
  fplDataService: FplBootstrapDataService,
): EventServiceOperations => ({
  findAllEvents: () =>
    pipe(domainOps.getAllEvents(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Events
    >,

  findEventById: (id: EventId) =>
    pipe(domainOps.getEventById(id), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  findCurrentEvent: () =>
    pipe(domainOps.getCurrentEvent(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  findNextEvent: () =>
    pipe(domainOps.getNextEvent(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Event | null
    >,

  syncEventsFromApi: () =>
    pipe(
      fplDataService.getEvents(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map events via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map((rawData) => mapRawDataToEventCreateArray(rawData)),
      TE.chain((eventCreateData) =>
        pipe(domainOps.saveEvents(eventCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
    ) as TE.TaskEither<ServiceError, Events>,
});

const mapRawDataToEventCreateArray = (rawData: Events): PrismaEventCreate[] => {
  return rawData.map((event) => event as PrismaEventCreate);
};

export const createEventService = (
  fplDataService: FplBootstrapDataService,
  repository: EventRepository,
  cache: EventCache,
): EventService => {
  const domainOps = createEventOperations(repository, cache);
  const ops = eventServiceOperations(domainOps, fplDataService);

  return {
    getEvents: () => ops.findAllEvents(),
    getEvent: (id: EventId) => ops.findEventById(id),
    getCurrentEvent: () => ops.findCurrentEvent(),
    getNextEvent: () => ops.findNextEvent(),
    syncEventsFromApi: () => ops.syncEventsFromApi(),
  };
};
