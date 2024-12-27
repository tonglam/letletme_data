import { Prisma } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import type { APIError } from '../../infrastructure/http/common/errors';
import { createValidationError } from '../../infrastructure/http/common/errors';
import type {
  ChipPlay,
  Event as DomainEvent,
  EventId,
  PrismaEvent,
  PrismaEventCreate,
  TopElementInfo,
} from '../../types/events.type';
import type { EventCacheOperations } from './cache';
import { eventRepository } from './repository';

export const createError = (message: string, cause?: unknown): APIError =>
  createValidationError({ message, details: { cause } });

export const toDomainEvent = (prismaEvent: PrismaEvent): DomainEvent => ({
  id: prismaEvent.id as EventId,
  name: prismaEvent.name,
  deadlineTime: prismaEvent.deadlineTime,
  deadlineTimeEpoch: prismaEvent.deadlineTimeEpoch,
  deadlineTimeGameOffset: prismaEvent.deadlineTimeGameOffset,
  releaseTime: prismaEvent.releaseTime,
  averageEntryScore: prismaEvent.averageEntryScore,
  finished: prismaEvent.finished,
  dataChecked: prismaEvent.dataChecked,
  highestScore: prismaEvent.highestScore,
  highestScoringEntry: prismaEvent.highestScoringEntry,
  isPrevious: prismaEvent.isPrevious,
  isCurrent: prismaEvent.isCurrent,
  isNext: prismaEvent.isNext,
  cupLeaguesCreated: prismaEvent.cupLeaguesCreated,
  h2hKoMatchesCreated: prismaEvent.h2hKoMatchesCreated,
  rankedCount: prismaEvent.rankedCount,
  chipPlays: prismaEvent.chipPlays as unknown as ChipPlay[],
  mostSelected: prismaEvent.mostSelected,
  mostTransferredIn: prismaEvent.mostTransferredIn,
  mostCaptained: prismaEvent.mostCaptained,
  mostViceCaptained: prismaEvent.mostViceCaptained,
  topElement: prismaEvent.topElement,
  topElementInfo: prismaEvent.topElementInfo as unknown as TopElementInfo | null,
  transfersMade: prismaEvent.transfersMade,
  createdAt: prismaEvent.createdAt,
});

export const toPrismaEventCreate = (event: DomainEvent): PrismaEventCreate => ({
  id: Number(event.id),
  name: event.name,
  deadlineTime: event.deadlineTime,
  deadlineTimeEpoch: event.deadlineTimeEpoch,
  deadlineTimeGameOffset: event.deadlineTimeGameOffset,
  releaseTime: event.releaseTime,
  averageEntryScore: event.averageEntryScore,
  finished: event.finished,
  dataChecked: event.dataChecked,
  highestScore: event.highestScore,
  highestScoringEntry: event.highestScoringEntry,
  isPrevious: event.isPrevious,
  isCurrent: event.isCurrent,
  isNext: event.isNext,
  cupLeaguesCreated: event.cupLeaguesCreated,
  h2hKoMatchesCreated: event.h2hKoMatchesCreated,
  rankedCount: event.rankedCount,
  chipPlays: event.chipPlays as unknown as Prisma.InputJsonValue,
  mostSelected: event.mostSelected,
  mostTransferredIn: event.mostTransferredIn,
  mostCaptained: event.mostCaptained,
  mostViceCaptained: event.mostViceCaptained,
  topElement: event.topElement,
  topElementInfo: event.topElementInfo as unknown as Prisma.InputJsonValue,
  transfersMade: event.transfersMade,
  createdAt: event.createdAt ?? new Date(),
});

const toPrismaEventWithError = (event: DomainEvent): E.Either<APIError, PrismaEventCreate> =>
  E.tryCatch(
    () => toPrismaEventCreate(event),
    (error) => createError('Invalid event data', error),
  );

const toDomainEventWithError = (event: PrismaEvent): E.Either<APIError, DomainEvent> =>
  E.tryCatch(
    () => toDomainEvent(event),
    (error) => createError('Failed to convert event', error),
  );

const ensurePrismaEvent = (event: unknown): E.Either<APIError, PrismaEvent> => {
  if (
    typeof event === 'object' &&
    event !== null &&
    'id' in event &&
    'name' in event &&
    'deadlineTime' in event &&
    'deadlineTimeEpoch' in event &&
    'deadlineTimeGameOffset' in event &&
    'releaseTime' in event &&
    'averageEntryScore' in event &&
    'finished' in event &&
    'dataChecked' in event &&
    'highestScore' in event &&
    'highestScoringEntry' in event &&
    'isPrevious' in event &&
    'isCurrent' in event &&
    'isNext' in event &&
    'cupLeaguesCreated' in event &&
    'h2hKoMatchesCreated' in event &&
    'rankedCount' in event &&
    'chipPlays' in event &&
    'mostSelected' in event &&
    'mostTransferredIn' in event &&
    'mostCaptained' in event &&
    'mostViceCaptained' in event &&
    'topElement' in event &&
    'topElementInfo' in event &&
    'transfersMade' in event &&
    'createdAt' in event
  ) {
    return E.right(event as PrismaEvent);
  }
  return E.left(createError('Invalid PrismaEvent object'));
};

const ensurePrismaEventArray = (events: unknown): E.Either<APIError, PrismaEvent[]> => {
  if (Array.isArray(events)) {
    const validatedEvents = events.map((event) => ensurePrismaEvent(event));
    const errors = validatedEvents.filter(E.isLeft).map((e) => e.left);
    if (errors.length > 0) {
      return E.left(createError('Invalid PrismaEvent array', errors));
    }
    return E.right(validatedEvents.filter(E.isRight).map((p) => p.right));
  }
  return E.left(createError('Expected array of PrismaEvent objects'));
};

export const saveEvent = (event: DomainEvent): TE.TaskEither<APIError, DomainEvent> =>
  pipe(
    toPrismaEventWithError(event),
    TE.fromEither,
    TE.chain((prismaEvent) =>
      pipe(
        eventRepository.save({ ...prismaEvent, id: Number(event.id) }),
        TE.chain((saved) =>
          pipe(
            ensurePrismaEvent(saved),
            TE.fromEither,
            TE.chain((validEvent) => pipe(toDomainEventWithError(validEvent), TE.fromEither)),
          ),
        ),
      ),
    ),
  );

export const cacheEvent =
  (cache: EventCacheOperations) =>
  (event: DomainEvent): TE.TaskEither<APIError, void> =>
    pipe(
      toPrismaEventWithError(event),
      TE.fromEither,
      TE.chain((prismaEvent) =>
        pipe(
          cache.cacheEvents([{ ...prismaEvent, id: Number(event.id) }]),
          TE.mapLeft((error) => createError('Failed to cache event', error)),
        ),
      ),
    );

export const findCurrentEvent = (): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    eventRepository.findCurrent(),
    TE.chain((event) =>
      event
        ? pipe(
            ensurePrismaEvent(event),
            TE.fromEither,
            TE.chain((validEvent) => pipe(toDomainEventWithError(validEvent), TE.fromEither)),
          )
        : TE.right(null),
    ),
  );

export const findNextEvent = (): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    eventRepository.findNext(),
    TE.chain((event) =>
      event
        ? pipe(
            ensurePrismaEvent(event),
            TE.fromEither,
            TE.chain((validEvent) => pipe(toDomainEventWithError(validEvent), TE.fromEither)),
          )
        : TE.right(null),
    ),
  );

export const findEventById = (id: EventId): TE.TaskEither<APIError, DomainEvent | null> =>
  pipe(
    eventRepository.findById(id),
    TE.chain((event) =>
      event
        ? pipe(
            ensurePrismaEvent(event),
            TE.fromEither,
            TE.chain((validEvent) => pipe(toDomainEventWithError(validEvent), TE.fromEither)),
          )
        : TE.right(null),
    ),
  );

export const findAllEvents = (): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    eventRepository.findAll(),
    TE.chain((events) =>
      pipe(
        ensurePrismaEventArray(events),
        TE.fromEither,
        TE.chain((validEvents) =>
          pipe(
            validEvents,
            TE.traverseArray((event) => pipe(toDomainEventWithError(event), TE.fromEither)),
          ),
        ),
      ),
    ),
  );

export const saveBatchEvents = (
  events: readonly DomainEvent[],
): TE.TaskEither<APIError, readonly DomainEvent[]> =>
  pipe(
    events,
    TE.traverseArray((event) => pipe(toPrismaEventWithError(event), TE.fromEither)),
    TE.chain((prismaEvents) =>
      pipe(
        eventRepository.saveBatch(prismaEvents.map((p, i) => ({ ...p, id: Number(events[i].id) }))),
        TE.chain((savedEvents) =>
          pipe(
            ensurePrismaEventArray(savedEvents),
            TE.fromEither,
            TE.chain((validEvents) =>
              pipe(
                validEvents,
                TE.traverseArray((event) => pipe(toDomainEventWithError(event), TE.fromEither)),
              ),
            ),
          ),
        ),
      ),
    ),
  );
