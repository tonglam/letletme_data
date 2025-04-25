import { Prisma, EventLiveExplain as PrismaEventLiveExplainType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { EventId } from 'src/types/domain/event.type';
import { PlayerId } from 'src/types/domain/player.type';
import { DBError } from 'src/types/error.type';

import { EventLiveExplain, EventLiveExplains } from '../../types/domain/event-live-explain.type';

export type PrismaEventLiveExplainCreateInput = Prisma.EventLiveExplainCreateInput;
export type PrismaEventLiveExplain = PrismaEventLiveExplainType;

export type EventLiveExplainCreateInput = EventLiveExplain;
export type EventLiveExplainCreateInputs = readonly EventLiveExplainCreateInput[];

export interface EventLiveExplainRepository {
  readonly findByElementIdAndEventId: (
    elementId: PlayerId,
    eventId: EventId,
  ) => TE.TaskEither<DBError, EventLiveExplain>;
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, EventLiveExplains>;
  readonly saveBatchByEventId: (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ) => TE.TaskEither<DBError, EventLiveExplains>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}
