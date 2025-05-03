import { Event, Events } from '@app/domain/event/model';
import { EventID } from '@app/domain/shared/types/id.types';
import { DBError } from '@app/shared/types/error.types';
import * as TE from 'fp-ts/TaskEither';

export interface EventRepository {
  readonly findById: (id: EventID) => TE.TaskEither<DBError, Event>;
  readonly findCurrent: () => TE.TaskEither<DBError, Event>;
  readonly findAll: () => TE.TaskEither<DBError, Events>;
  readonly saveBatch: (events: Events) => TE.TaskEither<DBError, Events>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
