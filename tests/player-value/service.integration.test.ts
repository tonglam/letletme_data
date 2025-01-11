import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPlayerValueRepository } from '../../src/domain/player-value/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerValueService } from '../../src/service/player-value';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError, ServiceErrorCode, createServiceError } from '../../src/types/error.type';
import type { PlayerValue, PlayerValueId } from '../../src/types/player-value.type';

describe('Player Value Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.PLAYER_VALUE;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;
  const testCurrentValueKey = `${testCacheKey}::current`;

  // Service dependencies with optimized retry config
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 3,
      baseDelay: 500,
      maxDelay: 2000,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const playerValueRepository = createPlayerValueRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<PlayerValue>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  // Wrap bootstrapApi to map APIError to ServiceError
  const wrappedBootstrapApi = {
    getBootstrapElements: () =>
      pipe(
        bootstrapApi.getBootstrapElements(),
        TE.mapLeft((error) =>
          createServiceError({
            code: ServiceErrorCode.INTEGRATION_ERROR,
            message: error.message,
            cause: error,
          }),
        ),
      ),
  };

  const playerValueService = createPlayerValueService(wrappedBootstrapApi, playerValueRepository);

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.playerValue.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentValueKey);
      await multi.exec();

      // Sync player values from API
      await pipe(
        playerValueService.syncPlayerValuesFromApi(),
        TE.fold<ServiceError, readonly PlayerValue[], void>(
          (error) => {
            console.error('Failed to sync player values:', error);
            return T.of(undefined);
          },
          () => T.of(void (async () => {})()),
        ),
      )();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  }, TEST_TIMEOUT);

  afterAll(async () => {
    try {
      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Service Setup', () => {
    it('should create service with proper interface', () => {
      expect(playerValueService).toBeDefined();
      expect(playerValueService.getPlayerValues).toBeDefined();
      expect(playerValueService.getPlayerValue).toBeDefined();
      expect(playerValueService.savePlayerValues).toBeDefined();
      expect(playerValueService.syncPlayerValuesFromApi).toBeDefined();
      expect(playerValueService.workflows).toBeDefined();
      expect(playerValueService.workflows.syncPlayerValues).toBeDefined();
    });
  });

  describe('Player Value Retrieval', () => {
    it(
      'should get all player values',
      async () => {
        const result = await pipe(
          playerValueService.getPlayerValues(),
          TE.fold<ServiceError, readonly PlayerValue[], readonly PlayerValue[]>(
            () => T.of([]),
            (values) => T.of(values),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(String),
          elementId: expect.any(Number),
          value: expect.any(Number),
          changeDate: expect.any(String),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get player value by id',
      async () => {
        // First get all values to find a valid ID
        const values = await pipe(
          playerValueService.getPlayerValues(),
          TE.fold<ServiceError, readonly PlayerValue[], readonly PlayerValue[]>(
            () => T.of([]),
            (values) => T.of(values),
          ),
        )();

        expect(values.length).toBeGreaterThan(0);
        const testValue = values[0];

        const result = await pipe(
          playerValueService.getPlayerValue(testValue.id),
          TE.map((value: PlayerValue | null): O.Option<PlayerValue> => O.fromNullable(value)),
          TE.fold<ServiceError, O.Option<PlayerValue>, O.Option<PlayerValue>>(
            () => T.of(O.none),
            (valueOption) => T.of(valueOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testValue.id,
            elementId: expect.any(Number),
            value: expect.any(Number),
            changeDate: expect.any(String),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent player value id',
      async () => {
        const nonExistentId = '999_2023-12-31' as PlayerValueId;
        const result = await pipe(
          playerValueService.getPlayerValue(nonExistentId),
          TE.map((value: PlayerValue | null): O.Option<PlayerValue> => O.fromNullable(value)),
          TE.fold<ServiceError, O.Option<PlayerValue>, O.Option<PlayerValue>>(
            () => T.of(O.none),
            (valueOption) => T.of(valueOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Player Value Creation', () => {
    it(
      'should save player values',
      async () => {
        // First get all values
        const existingValues = await pipe(
          playerValueService.getPlayerValues(),
          TE.fold<ServiceError, readonly PlayerValue[], readonly PlayerValue[]>(
            () => T.of([]),
            (values) => T.of(values),
          ),
        )();

        expect(existingValues.length).toBeGreaterThan(0);

        // Create new values with different IDs
        const today = new Date().toISOString().slice(0, 10);
        const newValues = existingValues.slice(0, 2).map((value) => ({
          ...value,
          id: `${value.elementId}_${today}` as PlayerValueId,
        }));

        const result = await pipe(
          playerValueService.savePlayerValues(newValues),
          TE.fold<ServiceError, readonly PlayerValue[], readonly PlayerValue[]>(
            () => T.of([]),
            (values) => T.of(values),
          ),
        )();

        expect(result.length).toBe(newValues.length);
        expect(result[0]).toMatchObject({
          id: expect.any(String),
          elementId: expect.any(Number),
          value: expect.any(Number),
          changeDate: expect.any(String),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
