import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import {
  createEventCache,
  createEventOperations,
  type EventCacheOperations,
} from '../../domains/events/cache/cache';
import { toPrismaEventCreate } from '../../domains/events/operations';
import { getCacheModule } from '../../infrastructure/cache/cache.module';
import { CacheError } from '../../infrastructure/cache/types';

export const initializeEventCache = (
  bootstrapApi: BootstrapApi,
): EventCacheOperations | undefined =>
  pipe(
    getCacheModule().getRedisClient(),
    E.chain((client) =>
      pipe(
        E.tryCatch(
          () => createEventCache(client),
          (error): CacheError => ({
            type: 'OPERATION_ERROR',
            message: 'Failed to create event cache',
            cause: error,
          }),
        ),
        E.map((eventCache) =>
          createEventOperations(eventCache, {
            getAll: async () => {
              const events = await bootstrapApi.getBootstrapEvents();
              return events?.map(toPrismaEventCreate) ?? [];
            },
            getOne: async (id: string) => {
              const events = await bootstrapApi.getBootstrapEvents();
              const event = events?.find((e) => e.id === Number(id));
              return event ? toPrismaEventCreate(event) : null;
            },
          }),
        ),
      ),
    ),
    E.getOrElseW(() => undefined),
  );
