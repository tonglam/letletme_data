import { Prisma, EventLive as PrismaEventLiveType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { RawEventLive, RawEventLives } from 'src/types/domain/event-live.type';
import { EventId } from 'src/types/domain/event.type';
import { DBError } from 'src/types/error.type';

export type PrismaEventLiveCreateInput = Prisma.EventLiveCreateInput;
export type PrismaEventLive = PrismaEventLiveType;

export type EventLiveCreateInput = RawEventLive;
export type EventLiveCreateInputs = readonly EventLiveCreateInput[];

export interface EventLiveRepository {
  readonly findByEventId: (eventId: EventId) => TE.TaskEither<DBError, RawEventLives>;
  readonly saveBatchByEventId: (
    eventLiveInputs: EventLiveCreateInputs,
  ) => TE.TaskEither<DBError, RawEventLives>;
  readonly deleteByEventId: (eventId: EventId) => TE.TaskEither<DBError, void>;
}
