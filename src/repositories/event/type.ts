import { Prisma, Event as PrismaEventType } from '@prisma/client';
import { Event, EventId } from 'src/types/domain/event.type';

export type PrismaEventCreateInput = Prisma.EventCreateInput;
export type PrismaEvent = PrismaEventType;

export type PrismaEventCreate = Omit<Event, 'id'> & { id: EventId };
