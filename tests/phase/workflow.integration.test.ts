import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { createPhaseCache } from '../../src/domain/phase/cache';
import { createPhaseRepository } from '../../src/domain/phase/repository';
import { toDomainPhase } from '../../src/domain/phase/types';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPhaseService } from '../../src/service/phase';
import type { WorkflowResult } from '../../src/service/phase/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import type { PhaseId } from '../../src/types/phase.type';
import { Phase } from '../../src/types/phase.type';

describe('Phase Workflow Integration Tests', () => {
  // Service and workflow instances
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 2,
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
  const workflows = phaseService.workflows;

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.phase.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `phase::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    } catch (error) {
      console.error('Error in beforeAll:', error);
      throw error;
    }
  });

  afterAll(async () => {
    try {
      // Clean up test data
      await prisma.phase.deleteMany();

      // Verify cleanup
      await redisCache.client.keys('*phase*');

      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Workflow Setup', () => {
    it('should create workflows with proper interface', () => {
      expect(workflows).toBeDefined();
      expect(workflows.syncPhases).toBeDefined();
      expect(typeof workflows.syncPhases).toBe('function');
    });
  });

  describe('Phase Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows.syncPhases(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly Phase[]>,
          WorkflowResult<readonly Phase[]> | null
        >(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('phase-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          startEvent: expect.any(Number),
          stopEvent: expect.any(Number),
        });
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch phases from API',
        cause: new Error('Network error'),
        details: { endpoint: '/bootstrap/phases' },
      });

      const failingApi: ExtendedBootstrapApi = {
        getBootstrapEvents: () => TE.left(mockError),
        getBootstrapPhases: () => TE.left(mockError),
        getBootstrapTeams: () => TE.left(mockError),
        getBootstrapElements: () => TE.left(mockError),
        getBootstrapData: async () => {
          throw new Error('Network error');
        },
      };

      const failingService = createPhaseService(failingApi, phaseRepository);
      const failingWorkflows = failingService.workflows;

      const result = await pipe(
        failingWorkflows.syncPhases(),
        TE.fold<ServiceError, WorkflowResult<readonly Phase[]>, ServiceError>(
          (error) => T.of(error),
          () => {
            throw new Error('Expected workflow to fail but it succeeded');
          },
        ),
      )();

      // Verify only top-level workflow error
      expect(result).toBeDefined();
      expect(result.name).toBe('ServiceError');
      expect(result.code).toBe(ServiceErrorCode.INTEGRATION_ERROR);
      expect(result.message).toBe('Phase sync workflow failed: Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only phase-related cache keys
      const season = getCurrentSeason();
      const baseKey = `phase::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows.syncPhases(),
        TE.fold<ServiceError, WorkflowResult<readonly Phase[]>, WorkflowResult<readonly Phase[]>>(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: '', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.duration).toBeGreaterThan(0);
      expect(result.duration).toBeLessThan(30000); // Reasonable timeout
    }, 30000);

    it('should include workflow context in results', async () => {
      const result = await pipe(
        workflows.syncPhases(),
        TE.fold<ServiceError, WorkflowResult<readonly Phase[]>, WorkflowResult<readonly Phase[]>>(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: 'phase-sync', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'phase-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
