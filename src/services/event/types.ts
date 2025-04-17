import * as TE from 'fp-ts/TaskEither';

import type { FplBootstrapDataService } from '../../data/types';
import type { Event, EventId, Events } from '../../types/domain/event.type';
import type { ServiceError } from '../../types/error.type';
import type { WorkflowResult } from '../types';

export interface EventService {
  readonly getEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, Events>;
}

export interface EventServiceWithWorkflows extends EventService {
  readonly workflows: {
    readonly syncEvents: () => TE.TaskEither<ServiceError, WorkflowResult<Events>>;
  };
}

export interface EventServiceDependencies {
  readonly fplDataService: FplBootstrapDataService;
}

export interface EventServiceOperations {
  readonly findAllEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly findEventById: (id: EventId) => TE.TaskEither<ServiceError, Event | null>;
  readonly findCurrentEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly findNextEvent: () => TE.TaskEither<ServiceError, Event | null>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, Events>;
}
