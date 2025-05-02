import { EventID } from '@app/domain/types/id.types';
import { Event, EventCreateInputs, Events } from '@app/schemas/tables/event.schema';
import { DBError } from '@app/shared/types/error.types';
import * as TE from 'fp-ts/TaskEither';

export interface EventRepository {
  readonly findById: (id: EventID) => TE.TaskEither<DBError, Event>;
  readonly findCurrent: () => TE.TaskEither<DBError, Event>;
  readonly findAll: () => TE.TaskEither<DBError, Events>;
  readonly saveBatch: (eventInputs: EventCreateInputs) => TE.TaskEither<DBError, Events>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
