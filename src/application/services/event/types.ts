import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { Event, EventId, Events } from 'types/domain/event.type';
import { ServiceError } from 'types/error.type';

export interface EventServiceOperations {
  readonly findEventById: (id: EventId) => TE.TaskEither<ServiceError, Event>;
  readonly findCurrentEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findLastEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findNextEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly findAllEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly findAllDeadlineDates: () => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EventService {
  readonly getEvent: (id: EventId) => TE.TaskEither<ServiceError, Event>;
  readonly getCurrentEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getLastEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getNextEvent: () => TE.TaskEither<ServiceError, Event>;
  readonly getEvents: () => TE.TaskEither<ServiceError, Events>;
  readonly getDeadlineDates: () => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly syncEventsFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface EventWorkflowOperations {
  readonly syncEvents: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
