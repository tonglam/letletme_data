import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/event.schema';
import { Event, EventId, Events } from 'types/domain/event.type';
import { DBError } from 'types/error.type';

export type DbEvent = InferSelectModel<typeof schema.events>;
export type DbEventInsert = InferInsertModel<typeof schema.events>;

export type EventCreateInput = Omit<Event, 'createdAt'>;
export type EventCreateInputs = EventCreateInput[];

export interface EventRepository {
  readonly findById: (id: EventId) => TE.TaskEither<DBError, Event>;
  readonly findCurrent: () => TE.TaskEither<DBError, Event>;
  readonly findAll: () => TE.TaskEither<DBError, Events>;
  readonly saveBatch: (eventInputs: EventCreateInputs) => TE.TaskEither<DBError, Events>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
