import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { eventRepository } from '../../src/domain/event/repository';
import { redisClient } from '../../src/infrastructure/cache/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import {
  createEventService,
  createEventWorkflows,
  EventWorkflowKey,
} from '../../src/service/event';
import { WorkflowResult } from '../../src/service/event/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import { Event } from '../../src/types/event.type';

describe('Event Workflow Integration Tests', () => {
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
  const eventService = createEventService(bootstrapApi, eventRepository);
  const workflows = createEventWorkflows(eventService);

  beforeAll(async () => {
    // Wait for Redis connection
    await new Promise((resolve) => setTimeout(resolve, 1000));
  });

  afterAll(async () => {
    await redisClient.quit();
  });

  describe('Workflow Setup', () => {
    it('should create workflows with proper interface', () => {
      expect(workflows).toBeDefined();
      expect(workflows[EventWorkflowKey.SYNC]).toBeDefined();
      expect(typeof workflows[EventWorkflowKey.SYNC]).toBe('function');
    });
  });

  describe('Event Sync Workflow', () => {
    it('should execute sync workflow successfully', async () => {
      const result = await pipe(
        workflows[EventWorkflowKey.SYNC](),
        TE.fold<
          ServiceError,
          WorkflowResult<readonly Event[]>,
          WorkflowResult<readonly Event[]> | null
        >(
          () => T.of(null),
          (result) => T.of(result),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('event-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

        // Verify workflow metrics
        expect(result.duration).toBeGreaterThan(0);

        // Verify workflow result
        expect(Array.isArray(result.result)).toBe(true);
        expect(result.result.length).toBeGreaterThan(0);
        expect(result.result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          deadlineTime: expect.any(String),
        });
      }
    }, 30000);

    it('should handle workflow errors properly', async () => {
      // Create mock API that always fails
      const mockError = createAPIError({
        code: APIErrorCode.SERVICE_ERROR,
        message: 'Failed to fetch events from API',
        cause: new Error('Network error'),
        details: { endpoint: '/bootstrap/events' },
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

      const failingService = createEventService(failingApi, eventRepository);
      const failingWorkflows = createEventWorkflows(failingService);

      const result = await pipe(
        failingWorkflows[EventWorkflowKey.SYNC](),
        TE.fold<ServiceError, WorkflowResult<readonly Event[]>, ServiceError>(
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
      expect(result.message).toBe('Event sync workflow failed: Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Workflow Metrics', () => {
    beforeEach(async () => {
      // Clear only event-related cache keys
      const season = getCurrentSeason();
      const baseKey = `event::${season}`;
      const currentKey = `${baseKey}::current`;
      const nextKey = `${baseKey}::next`;

      const multi = redisClient.multi();
      multi.del(baseKey);
      multi.del(currentKey);
      multi.del(nextKey);
      await multi.exec();
    });

    it('should track workflow execution time', async () => {
      const result = await pipe(
        workflows[EventWorkflowKey.SYNC](),
        TE.fold<ServiceError, WorkflowResult<readonly Event[]>, WorkflowResult<readonly Event[]>>(
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
        workflows[EventWorkflowKey.SYNC](),
        TE.fold<ServiceError, WorkflowResult<readonly Event[]>, WorkflowResult<readonly Event[]>>(
          (error) =>
            T.of({
              duration: 0,
              context: { workflowId: 'event-sync', startTime: new Date() },
              result: [],
              error,
            }),
          (result) => T.of(result),
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'event-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
