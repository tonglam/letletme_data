import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createDomainOperations } from '../../infrastructure/db/operations';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import {
  Event as DomainEvent,
  EventId,
  PrismaEvent,
  toDomainEvent,
  toPrismaEvent,
} from '../../types/events.type';
import type { EventCacheOperations } from './cache';
import { eventRepository } from './repository';

const { single, array } = createDomainOperations<DomainEvent, PrismaEvent>({
  toDomain: toDomainEvent,
  toPrisma: toPrismaEvent,
});

export const saveEvent = (event: DomainEvent): TE.TaskEither<APIError, DomainEvent> =>
  pipe(
    eventRepository.save(single.fromDomain(event)),
    TE.map(single.toDomain),
    TE.chain((result) =>
      result
        ? TE.right(result)
        : TE.left(createValidationError({ message: 'Failed to save event' })),
    ),
  );

export const cacheEvent =
  (cache: EventCacheOperations) =>
  (event: DomainEvent): TE.TaskEither<APIError, void> =>
    pipe(
      cache.cacheEvents([{ ...single.fromDomain(event), createdAt: new Date() }]),
      TE.mapLeft((error) =>
        createValidationError({ message: 'Failed to cache event', details: { error } }),
      ),
    );

export const findCurrentEvent = (): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(eventRepository.findCurrent(), TE.map(single.toDomain));

export const findNextEvent = (): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(eventRepository.findNext(), TE.map(single.toDomain));

export const findEventById = (id: EventId): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(eventRepository.findById(id), TE.map(single.toDomain));

export const findAllEvents = (): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(eventRepository.findAll(), TE.map(array.toDomain));

export const saveBatchEvents = (
  events: readonly DomainEvent[],
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    events,
    TE.of,
    TE.map(array.fromDomain),
    TE.chain((prismaEvents) =>
      pipe(eventRepository.saveBatch(prismaEvents), TE.map(array.toDomain)),
    ),
  );
