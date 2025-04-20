import { Prisma, Event as PrismaEventType } from '@prisma/client';
import * as TE from 'fp-ts/TaskEither';
import { Event, EventId, Events } from 'src/types/domain/event.type';
import { DBError } from 'src/types/error.type';

export type PrismaEventCreateInput = Prisma.EventCreateInput;
export type PrismaEvent = PrismaEventType;

export type EventCreateInput = Omit<Event, 'id'> & { id: EventId };
export type EventCreateInputs = readonly EventCreateInput[];

export interface EventRepository {
  readonly findById: (id: EventId) => TE.TaskEither<DBError, Event>;
  readonly findCurrent: () => TE.TaskEither<DBError, Event>;
  readonly findAll: () => TE.TaskEither<DBError, Events>;
  readonly saveBatch: (events: EventCreateInputs) => TE.TaskEither<DBError, Events>;
  readonly deleteAll: () => TE.TaskEither<DBError, void>;
}
