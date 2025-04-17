import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

import { EventCache, EventOperations, EventRepository } from './types';
import { PrismaEventCreate } from '../../repositories/event/type';
import { EventId } from '../../types/domain/event.type';
import { DomainErrorCode, createDomainError } from '../../types/error.type';
import { getErrorMessage } from '../../utils/error.util';

export const createEventOperations = (
  repository: EventRepository,
  cache: EventCache,
): EventOperations => ({
  getAllEvents: () =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getAllEvents): ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.chain((cachedEvents) =>
        cachedEvents && cachedEvents.length > 0
          ? TE.right(cachedEvents)
          : pipe(
              repository.findAll(),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findAll): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
              TE.chainFirst((events) =>
                events && events.length > 0
                  ? pipe(
                      cache.setAllEvents(events),
                      TE.mapLeft((cacheError) =>
                        createDomainError({
                          code: DomainErrorCode.CACHE_ERROR,
                          message: `Cache Error (setAllEvents): ${getErrorMessage(cacheError)}`,
                          cause: cacheError instanceof Error ? cacheError : undefined,
                        }),
                      ),
                    )
                  : TE.right(undefined),
              ),
            ),
      ),
    ),

  getEventById: (id: EventId) =>
    pipe(
      cache.getEvent(id),
      TE.mapLeft((error) =>
        createDomainError({
          code: DomainErrorCode.CACHE_ERROR,
          message: `Cache Error (getEvent ${id}): ${getErrorMessage(error)}`,
          cause: error instanceof Error ? error : undefined,
        }),
      ),
      TE.chain((cachedEvent) =>
        cachedEvent
          ? TE.right(cachedEvent)
          : pipe(
              repository.findById(id),
              TE.mapLeft((dbError) =>
                createDomainError({
                  code: DomainErrorCode.DATABASE_ERROR,
                  message: `DB Error (findById ${id}): ${getErrorMessage(dbError)}`,
                  cause: dbError,
                }),
              ),
            ),
      ),
    ),

  getCurrentEvent: () =>
    pipe(
      repository.findCurrent(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findCurrent): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  getNextEvent: () =>
    pipe(
      repository.findNext(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (findNext): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
    ),

  saveEvents: (events: readonly PrismaEventCreate[]) =>
    pipe(
      repository.saveBatch(events),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (saveBatch): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst((createdEvents) =>
        pipe(
          cache.setAllEvents(createdEvents),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (setAllEvents): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),

  deleteAllEvents: () =>
    pipe(
      repository.deleteAll(),
      TE.mapLeft((dbError) =>
        createDomainError({
          code: DomainErrorCode.DATABASE_ERROR,
          message: `DB Error (deleteAll): ${getErrorMessage(dbError)}`,
          cause: dbError,
        }),
      ),
      TE.chainFirst(() =>
        pipe(
          cache.deleteAllEvents(),
          TE.mapLeft((cacheError) =>
            createDomainError({
              code: DomainErrorCode.CACHE_ERROR,
              message: `Cache Error (deleteAllEvents): ${getErrorMessage(cacheError)}`,
              cause: cacheError instanceof Error ? cacheError : undefined,
            }),
          ),
        ),
      ),
    ),
});
