import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';

import type { Event, EventId, Events } from '../../types/domain/event.type';
import type { ServiceError } from '../../types/error.type';

export interface EventServiceOperations {
  readonly findEventById: (id: EventId) => TE.TaskEither<ServiceError, Event>;
  readonly findCurrentEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findLastEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findNextEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findAllEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, void>;
  readonly isMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isAfterMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isMatchTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isSelectTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly findAllDeadlineDates: () => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly findAllMatchDays: (eventId: EventId) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly findAllAfterMatchDays: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
}

export interface EventService {
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getLastEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, void>;
  readonly isMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isAfterMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isMatchTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isSelectTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly getDeadlineDates: () => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly getMatchDays: (eventId: EventId) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly getAfterMatchDays: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
}

export interface EventWorkflowOperations {
  readonly syncEvents: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
