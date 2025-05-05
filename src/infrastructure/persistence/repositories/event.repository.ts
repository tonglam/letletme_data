import { Event } from '@app/domain/event/model';
import { EventRepository } from '@app/domain/event/repository';
import { EventID } from '@app/domain/shared/types/id.types';
import { createEventCache } from '@app/infrastructure/cache/event.cache';
import { createEventRepository as createDrizzleEventRepository } from '@app/infrastructure/persistence/drizzle/repositories/drizzle-event.repository';
import { mapErrorToDbError } from '@app/infrastructure/persistence/utils/error.util';
import { DBError } from '@app/shared/types/error.types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createEventRepository = (): EventRepository => {
  const dbRepository = createDrizzleEventRepository();
  const cache = createEventCache();

  const findById = (id: EventID): TE.TaskEither<DBError, Event> =>
    pipe(
      cache.getEvent(id),
      TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findById cache fetch')),
      TE.orElse((_dbErrorFromCache) => dbRepository.findById(id)),
    );

  const findCurrent = (): TE.TaskEither<DBError, Event> =>
    pipe(
      cache.getCurrentEvent(),
      TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findCurrent cache fetch')),
      TE.orElse((_dbErrorFromCache) =>
        pipe(
          dbRepository.findCurrent(),
          TE.tap((event) =>
            pipe(
              cache.setCurrentEvent(event),
              TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findCurrent cache set')),
              TE.orElseW(() => TE.right(undefined)),
            ),
          ),
        ),
      ),
    );

  const findLast = (): TE.TaskEither<DBError, Event> =>
    pipe(
      cache.getLastEvent(),
      TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findLast cache fetch')),
      TE.orElse((_dbErrorFromCache) => dbRepository.findLast()),
    );

  const findNext = (): TE.TaskEither<DBError, Event> =>
    pipe(
      cache.getNextEvent(),
      TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findNext cache fetch')),
      TE.orElse((_dbErrorFromCache) => dbRepository.findNext()),
    );

  const findAll = (): TE.TaskEither<DBError, Event[]> =>
    pipe(
      cache.getAllEvents(),
      TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findAll cache fetch')),
      TE.orElse((_dbErrorFromCache) =>
        pipe(
          dbRepository.findAll(),
          TE.tap((events) =>
            pipe(
              cache.setAllEvents(events),
              TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'findAll cache set')),
              TE.orElseW(() => TE.right(undefined)),
            ),
          ),
        ),
      ),
    );

  const saveBatch = (events: Event[]): TE.TaskEither<DBError, Event[]> =>
    pipe(
      dbRepository.saveBatch(events),
      TE.tap(() =>
        pipe(
          cache.setAllEvents([]),
          TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'saveBatch cache invalidate')),
          TE.orElseW(() => TE.right(undefined)),
        ),
      ),
    );

  const deleteAll = (): TE.TaskEither<DBError, void> =>
    pipe(
      dbRepository.deleteAll(),
      TE.tap(() =>
        pipe(
          cache.setAllEvents([]),
          TE.chainW(() => cache.clearCurrentEvent()),
          TE.mapLeft((err) => mapErrorToDbError(err, undefined, 'deleteAll cache invalidate')),
          TE.orElseW(() => TE.right(undefined)),
        ),
      ),
    );

  return {
    findById,
    findCurrent,
    findLast,
    findNext,
    findAll,
    saveBatch,
    deleteAll,
  };
};
