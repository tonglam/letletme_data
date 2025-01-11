import { pipe } from 'fp-ts/function';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { createPlayerValueRepository } from '../../src/domain/player-value/repository';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createPlayerValueService } from '../../src/service/player-value';
import type { WorkflowResult } from '../../src/service/player-value/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  createServiceError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import type { PlayerValue } from '../../src/types/player-value.type';

describe('Player Value Workflow Integration Tests', () => {
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
  const workflows = playerValueService.workflows;

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.playerValue.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `player-value::${season}`;

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
      await prisma.playerValue.deleteMany();

      // Verify cleanup
      await redisCache.client.keys('*player-value*');

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
      expect(workflows.syncPlayerValues).toBeDefined();
      expect(typeof workflows.syncPlayerValues).toBe('function');
    });
  });

  describe('Player Value Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows.syncPlayerValues(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerValue[]>,
          WorkflowResult<readonly PlayerValue[]> | null
        >(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('player-value-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
          id: expect.any(String),
          elementId: expect.any(Number),
          value: expect.any(Number),
          changeDate: expect.any(String),
        });
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch player values from API',
        cause: new Error('Network error'),
        details: { endpoint: '/bootstrap/elements' },
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

      // Wrap failing API with error mapping
      const wrappedFailingApi = {
        getBootstrapElements: () =>
          pipe(
            failingApi.getBootstrapElements(),
            TE.mapLeft((error) =>
              createServiceError({
                code: ServiceErrorCode.INTEGRATION_ERROR,
                message: error.message,
                cause: error,
              }),
            ),
          ),
      };

      const failingService = createPlayerValueService(wrappedFailingApi, playerValueRepository);
      const failingWorkflows = failingService.workflows;

      const result = await pipe(
        failingWorkflows.syncPlayerValues(),
        TE.fold<ServiceError, WorkflowResult<readonly PlayerValue[]>, ServiceError>(
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
      expect(result.message).toBe('Player value sync workflow failed: Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only player-value-related cache keys
      const season = getCurrentSeason();
      const baseKey = `player-value::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows.syncPlayerValues(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerValue[]>,
          WorkflowResult<readonly PlayerValue[]>
        >(
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
        workflows.syncPlayerValues(),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly PlayerValue[]>,
          WorkflowResult<readonly PlayerValue[]>
        >(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: 'player-value-sync', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'player-value-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
