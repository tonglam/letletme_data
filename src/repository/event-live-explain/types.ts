import { InferInsertModel, InferSelectModel } from 'drizzle-orm';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import * as schema from 'schema/event-live-explain';
import { EventLiveExplain, EventLiveExplains } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { DBError } from 'types/error.type';

export type DbEventLiveExplain = InferSelectModel<typeof schema.eventLiveExplains>;
export type DbEventLiveExplainCreateInput = InferInsertModel<typeof schema.eventLiveExplains>;

export type EventLiveExplainCreateInput = EventLiveExplain;
export type EventLiveExplainCreateInputs = readonly EventLiveExplainCreateInput[];

export interface EventLiveExplainRepository {
  readonly findByElementIdAndEventId: (
    elementId: PlayerId,
    eventId: EventId,
  ) => TE.TaskEither<DBError, Option<EventLiveExplain>>;
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, EventLiveExplains>;
  readonly saveBatchByEventId: (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ) => TE.TaskEither<DBError, void>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}
