import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createEventServiceCache } from '../../src/service/event/cache';
import type { CacheError } from '../../src/types/errors.type';
import type { Event } from '../../src/types/events.type';

describe('Event Service Integration Tests', () => {
  // Test resources tracking
  let testKeys: string[] = [];

  // Service dependencies
  const fplClient = createFPLClient();
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const redisCache = createRedisCache<Event>();
  const eventService = createEventServiceCache(bootstrapApi);

  beforeEach(() => {
    testKeys = [];
  });

  afterEach(async () => {
    // Cleanup test data
    await Promise.all(
      testKeys.map(async (key) => {
        await pipe(
          TE.tryCatch(
            () => redisClient.del(key),
            (error) => error as CacheError,
          ),
          TE.fold(
            () => T.of(undefined),
            () => T.of(undefined),
          ),
        )();
      }),
    );
  });

  describe('Data Flow Tests', () => {
    it('should fetch data from API and store in cache on cache miss', async () => {
      const eventKey = `${CachePrefix.EVENT}:current`;
      testKeys.push(eventKey);

      // First call - should fetch from API and cache
      const result1 = await pipe(
        eventService.getCurrentEvent(),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(O.isSome(result1)).toBe(true);

      // Verify data is in cache
      const cachedData = await pipe(
        redisCache.get(eventKey),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(O.isSome(cachedData)).toBe(true);

      if (O.isSome(result1) && O.isSome(cachedData)) {
        expect(cachedData.value.id).toEqual(result1.value.id);
      }

      // Second call - should use cache
      const result2 = await pipe(
        eventService.getCurrentEvent(),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(result2).toEqual(result1);
    });

    it('should handle API errors gracefully', async () => {
      // Force API error by temporarily breaking the client
      const brokenApi = {
        ...bootstrapApi,
        getBootstrapEvents: () => Promise.reject(new Error('API Error')),
      };
      const errorService = createEventServiceCache(brokenApi);

      const result = await pipe(
        errorService.getCurrentEvent(),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(O.isNone(result)).toBe(true);
    });

    it('should maintain data consistency between cache and API', async () => {
      const eventKey = `${CachePrefix.EVENT}:next`;
      testKeys.push(eventKey);

      // Get initial data
      const result1 = await pipe(
        eventService.getNextEvent(),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(O.isSome(result1)).toBe(true);

      // Clear cache to force new API fetch
      await pipe(
        TE.tryCatch(
          () => redisClient.del(eventKey),
          (error) => error as CacheError,
        ),
        TE.fold(
          () => T.of(undefined),
          () => T.of(undefined),
        ),
      )();

      // Get data again
      const result2 = await pipe(
        eventService.getNextEvent(),
        TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
        TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
          () => T.of(O.none),
          (eventOption) => T.of(eventOption),
        ),
      )();
      expect(result2).toEqual(result1);
    });
  });
});
