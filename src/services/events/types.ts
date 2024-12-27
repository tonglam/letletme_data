import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { EventCache } from '../../domains/events/cache';
import { eventRepository } from '../../domains/events/repository';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Event, EventId } from '../../types/events.type';

export type EventServiceError = APIError & {
  code: 'CACHE_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'SYNC_ERROR';
  details?: Record<string, unknown>;
};

export interface EventService {
  readonly syncEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getEvents: () => TE.TaskEither<APIError, readonly Event[]>;
  readonly getEvent: (id: EventId) => TE.TaskEither<APIError, Event | null>;
  readonly getCurrentEvent: () => TE.TaskEither<APIError, Event | null>;
  readonly getNextEvent: () => TE.TaskEither<APIError, Event | null>;
}

export type EventServiceDependencies = {
  readonly bootstrapApi: BootstrapApi;
  readonly eventCache?: EventCache;
  readonly eventRepository: typeof eventRepository;
};
