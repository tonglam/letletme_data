import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createPhaseCache } from '../../src/domain/phase/cache';
import { createPhaseRepository } from '../../src/domain/phase/repository';
import { toDomainPhase } from '../../src/domain/phase/types';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPhaseService } from '../../src/service/phase';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError } from '../../src/types/error.type';
import type { Phase, PhaseId } from '../../src/types/phase.type';

describe('Phase Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.PHASE;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;
  const testCurrentPhaseKey = `${testCacheKey}::current`;

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
  const phaseRepository = createPhaseRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<Phase>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const phaseCache = createPhaseCache(redisCache, {
    getOne: async (id: number) => {
      const result = await phaseRepository.findById(id as PhaseId)();
      if (E.isRight(result) && result.right) {
        return toDomainPhase(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await phaseRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainPhase);
      }
      return [];
    },
  });

  const phaseService = createPhaseService(bootstrapApi, phaseRepository, phaseCache);

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear existing data
      await prisma.phase.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentPhaseKey);
      await multi.exec();

      // Sync phases from API
      await pipe(
        phaseService.syncPhasesFromApi(),
        TE.fold<ServiceError, readonly Phase[], void>(
          (error) => {
            console.error('Failed to sync phases:', error);
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
      // Clean up test data
      await prisma.phase.deleteMany();

      // Clean up test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentPhaseKey);
      await multi.exec();

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
      expect(phaseService).toBeDefined();
      expect(phaseService.getPhases).toBeDefined();
      expect(phaseService.getPhase).toBeDefined();
      expect(phaseService.savePhases).toBeDefined();
      expect(phaseService.syncPhasesFromApi).toBeDefined();
      expect(phaseService.workflows).toBeDefined();
      expect(phaseService.workflows.syncPhases).toBeDefined();
    });
  });

  describe('Phase Retrieval', () => {
    it(
      'should get all phases',
      async () => {
        const result = await pipe(
          phaseService.getPhases(),
          TE.fold<ServiceError, readonly Phase[], readonly Phase[]>(
            () => T.of([]),
            (phases) => T.of(phases),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          startEvent: expect.any(Number),
          stopEvent: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get phase by id',
      async () => {
        // First get all phases to find a valid ID
        const phases = await pipe(
          phaseService.getPhases(),
          TE.fold<ServiceError, readonly Phase[], readonly Phase[]>(
            () => T.of([]),
            (phases) => T.of(phases),
          ),
        )();

        expect(phases.length).toBeGreaterThan(0);
        const testPhase = phases[0];

        const result = await pipe(
          phaseService.getPhase(testPhase.id),
          TE.map((phase: Phase | null): O.Option<Phase> => O.fromNullable(phase)),
          TE.fold<ServiceError, O.Option<Phase>, O.Option<Phase>>(
            () => T.of(O.none),
            (phaseOption) => T.of(phaseOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testPhase.id,
            name: expect.any(String),
            startEvent: expect.any(Number),
            stopEvent: expect.any(Number),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent phase id',
      async () => {
        const nonExistentId = 9999 as PhaseId;
        const result = await pipe(
          phaseService.getPhase(nonExistentId),
          TE.map((phase: Phase | null): O.Option<Phase> => O.fromNullable(phase)),
          TE.fold<ServiceError, O.Option<Phase>, O.Option<Phase>>(
            () => T.of(O.none),
            (phaseOption) => T.of(phaseOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Phase Creation', () => {
    it(
      'should save phases',
      async () => {
        // First get all phases
        const existingPhases = await pipe(
          phaseService.getPhases(),
          TE.fold<ServiceError, readonly Phase[], readonly Phase[]>(
            () => T.of([]),
            (phases) => T.of(phases),
          ),
        )();

        expect(existingPhases.length).toBeGreaterThan(0);

        // Create new phases with different IDs
        const newPhases = existingPhases.slice(0, 2).map((phase) => ({
          ...phase,
          id: (phase.id + 1000) as PhaseId, // Avoid ID conflicts
        }));

        const result = await pipe(
          phaseService.savePhases(newPhases),
          TE.fold<ServiceError, readonly Phase[], readonly Phase[]>(
            () => T.of([]),
            (phases) => T.of(phases),
          ),
        )();

        expect(result.length).toBe(newPhases.length);
        expect(result[0]).toMatchObject({
          id: newPhases[0].id,
          name: expect.any(String),
          startEvent: expect.any(Number),
          stopEvent: expect.any(Number),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
