import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { ExtendedBootstrapApi } from '../../src/domain/bootstrap/types';
import { createEventCache } from '../../src/domain/event/cache';
import { createEventRepository } from '../../src/domain/event/repository';
import { toDomainEvent } from '../../src/domain/event/types';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createEventService } from '../../src/service/event';
import type { WorkflowResult } from '../../src/service/event/types';
import { getCurrentSeason } from '../../src/types/base.type';
import {
  APIErrorCode,
  createAPIError,
  ServiceError,
  ServiceErrorCode,
} from '../../src/types/error.type';
import { Event, EventId } from '../../src/types/event.type';

describe('Event Service Integration Tests', () => {
  // Service instances
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 2,
      baseDelay: 500,
      maxDelay: 2000,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const eventRepository = createEventRepository(prisma);

  // Create Redis cache with remote configuration
  const redisCache = createRedisCache<Event>({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
  });

  const eventCache = createEventCache(redisCache, {
    getOne: async (id: number) => {
      const result = await eventRepository.findById(id as EventId)();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
    getAll: async () => {
      const result = await eventRepository.findAll()();
      if (E.isRight(result)) {
        return result.right.map(toDomainEvent);
      }
      return [];
    },
    getCurrent: async () => {
      const result = await eventRepository.findCurrent()();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
    getNext: async () => {
      const result = await eventRepository.findNext()();
      if (E.isRight(result) && result.right) {
        return toDomainEvent(result.right);
      }
      return null;
    },
  });

  const eventService = createEventService(bootstrapApi, eventRepository, eventCache);

  beforeAll(async () => {
    try {
      // Wait for Redis connection
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Clear test data
      await prisma.event.deleteMany();

      // Clear test-specific cache keys
      const season = getCurrentSeason();
      const baseKey = `event::${season}`;

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
      await prisma.event.deleteMany();

      // Verify cleanup
      await redisCache.client.keys('*event*');

      // Close connections
      await redisCache.client.quit();
      await prisma.$disconnect();
    } catch (error) {
      console.error('Error in afterAll:', error);
      throw error;
    }
  });

  describe('Event Service', () => {
    it('should create service with proper interface', () => {
      expect(eventService).toBeDefined();
      expect(eventService.getEvents).toBeDefined();
      expect(eventService.getEvent).toBeDefined();
      expect(eventService.getCurrentEvent).toBeDefined();
      expect(eventService.getNextEvent).toBeDefined();
      expect(eventService.saveEvents).toBeDefined();
      expect(eventService.syncEventsFromApi).toBeDefined();
    });
  });

  describe('Event Sync', () => {
    it('should execute sync successfully', async () => {
      const result = await pipe(
        eventService.syncEventsFromApi(),
        TE.fold<ServiceError, readonly Event[], WorkflowResult<readonly Event[]> | null>(
          () => T.of(null),
          (events) =>
            T.of({
              context: {
                workflowId: 'event-sync',
                startTime: new Date(),
              },
              result: events,
              duration: 0,
            }),
        ),
      )();

      expect(result).not.toBeNull();
      if (result) {
        // Verify workflow context
        expect(result.context).toBeDefined();
        expect(result.context.workflowId).toBe('event-sync');
        expect(result.context.startTime).toBeInstanceOf(Date);

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

    it('should handle sync errors properly', async () => {
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

      const failingService = createEventService(failingApi, eventRepository, eventCache);

      const result = await pipe(
        failingService.syncEventsFromApi(),
        TE.fold<ServiceError, readonly Event[], ServiceError>(
          (error) => T.of(error),
          () => {
            throw new Error('Expected sync to fail but it succeeded');
          },
        ),
      )();

      // Verify only top-level workflow error
      expect(result).toBeDefined();
      expect(result.name).toBe('ServiceError');
      expect(result.code).toBe(ServiceErrorCode.INTEGRATION_ERROR);
      expect(result.message).toBe('Service integration failed');
      expect(result.timestamp).toBeInstanceOf(Date);
    }, 10000);
  });

  describe('Metrics', () => {
    beforeEach(async () => {
      // Clear only event-related cache keys
      const season = getCurrentSeason();
      const baseKey = `event::${season}`;

      const multi = redisCache.client.multi();
      multi.del(baseKey);
      await multi.exec();
    });

    it('should track execution time', async () => {
      const startTime = new Date().getTime();
      const result = await pipe(
        eventService.syncEventsFromApi(),
        TE.fold<ServiceError, readonly Event[], WorkflowResult<readonly Event[]>>(
          (error) =>
            T.of({
              context: { workflowId: '', startTime: new Date() },
              result: [],
              duration: 0,
              error,
            }),
          (events) => {
            const duration = new Date().getTime() - startTime;
            return T.of({
              context: { workflowId: 'event-sync', startTime: new Date() },
              result: events,
              duration,
            });
          },
        ),
      )();

      expect(result.duration).toBeGreaterThan(0);
      expect(result.duration).toBeLessThan(30000); // Reasonable timeout
    }, 30000);

    it('should include context in results', async () => {
      const result = await pipe(
        eventService.syncEventsFromApi(),
        TE.fold<ServiceError, readonly Event[], WorkflowResult<readonly Event[]>>(
          (error) =>
            T.of({
              context: { workflowId: 'event-sync', startTime: new Date() },
              result: [],
              duration: 0,
              error,
            }),
          (events) => {
            return T.of({
              context: { workflowId: 'event-sync', startTime: new Date() },
              result: events,
              duration: 0,
            });
          },
        ),
      )();

      expect(result.context).toMatchObject({
        workflowId: 'event-sync',
        startTime: expect.any(Date),
      });
    }, 30000);
  });
});
