import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/event-live.schema';
import { RawEventLive, RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { DBError } from 'types/error.type';

export type DbEventLive = InferSelectModel<typeof schema.eventLive>;
export type DbEventLiveCreateInput = InferInsertModel<typeof schema.eventLive>;

export type EventLiveCreateInput = RawEventLive;
export type EventLiveCreateInputs = readonly EventLiveCreateInput[];

export interface EventLiveRepository {
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, RawEventLives>;
  readonly saveBatchByEventId: (
    eventLiveInputs: EventLiveCreateInputs,
  ) => TE.TaskEither<DBError, RawEventLives>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}
