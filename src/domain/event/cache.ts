import { Event, Events } from '@app/domain/event/model';
import { EventID } from '@app/domain/shared/types/id.types';
import { CacheError } from '@app/types/error.types';
import * as TE from 'fp-ts/TaskEither';

export interface EventCachePort {
  readonly getCurrentEvent: () => TE.TaskEither<CacheError, Event>;
  readonly setCurrentEvent: (event: Event) => TE.TaskEither<CacheError, void>;
  readonly clearCurrentEvent: () => TE.TaskEither<CacheError, void>;
  readonly getEvent: (id: EventID) => TE.TaskEither<CacheError, Event>;
  readonly getAllEvents: () => TE.TaskEither<CacheError, Events>;
  readonly setAllEvents: (events: Event[]) => TE.TaskEither<CacheError, void>;
  readonly getLastEvent: () => TE.TaskEither<CacheError, Event>;
  readonly getNextEvent: () => TE.TaskEither<CacheError, Event>;
}
