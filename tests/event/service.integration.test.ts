import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { createEventCache } from '../../src/domain/event/cache';
import { createEventRepository } from '../../src/domain/event/repository';
import { toDomainEvent } from '../../src/domain/event/types';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createEventService } from '../../src/service/event';
import { getCurrentSeason } from '../../src/types/base.type';
import { ServiceError } from '../../src/types/error.type';
import type { Event, EventId } from '../../src/types/event.type';

describe('Event Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = CachePrefix.EVENT;
  const testCacheKey = `${TEST_CACHE_PREFIX}::${getCurrentSeason()}`;
  const testCurrentEventKey = `${testCacheKey}::current`;
  const testNextEventKey = `${testCacheKey}::next`;

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

      // Clear existing data
      await prisma.event.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentEventKey);
      multi.del(testNextEventKey);
      await multi.exec();

      // Sync events from API
      await pipe(
        eventService.syncEventsFromApi(),
        TE.fold<ServiceError, readonly Event[], void>(
          (error) => {
            console.error('Failed to sync events:', error);
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
      await prisma.event.deleteMany();

      // Clear test-specific cache keys
      const multi = redisCache.client.multi();
      multi.del(testCacheKey);
      multi.del(testCurrentEventKey);
      multi.del(testNextEventKey);
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
      expect(eventService).toBeDefined();
      expect(eventService.getEvents).toBeDefined();
      expect(eventService.getEvent).toBeDefined();
      expect(eventService.getCurrentEvent).toBeDefined();
      expect(eventService.getNextEvent).toBeDefined();
      expect(eventService.saveEvents).toBeDefined();
      expect(eventService.syncEventsFromApi).toBeDefined();
    });
  });

  describe('Event Retrieval', () => {
    it(
      'should get all events',
      async () => {
        const result = await pipe(
          eventService.getEvents(),
          TE.fold<ServiceError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();

        expect(result.length).toBeGreaterThan(0);
        expect(result[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          deadlineTime: expect.any(String),
        });
      },
      TEST_TIMEOUT,
    );

    it(
      'should get event by id',
      async () => {
        // First get all events to find a valid ID
        const events = await pipe(
          eventService.getEvents(),
          TE.fold<ServiceError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();

        expect(events.length).toBeGreaterThan(0);
        const testEvent = events[0];

        const result = await pipe(
          eventService.getEvent(testEvent.id),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<ServiceError, O.Option<Event>, O.Option<Event>>(
            () => T.of(O.none),
            (eventOption) => T.of(eventOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: testEvent.id,
            name: expect.any(String),
            deadlineTime: expect.any(String),
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should handle non-existent event id',
      async () => {
        const nonExistentId = 9999 as EventId;
        const result = await pipe(
          eventService.getEvent(nonExistentId),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<ServiceError, O.Option<Event>, O.Option<Event>>(
            () => T.of(O.none),
            (eventOption) => T.of(eventOption),
          ),
        )();

        expect(O.isNone(result)).toBe(true);
      },
      TEST_TIMEOUT,
    );
  });

  describe('Current & Next Events', () => {
    it(
      'should get current event',
      async () => {
        const result = await pipe(
          eventService.getCurrentEvent(),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<ServiceError, O.Option<Event>, O.Option<Event>>(
            () => T.of(O.none),
            (eventOption) => T.of(eventOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: expect.any(Number),
            name: expect.any(String),
            deadlineTime: expect.any(String),
            isCurrent: true,
          });
        }
      },
      TEST_TIMEOUT,
    );

    it(
      'should get next event',
      async () => {
        const result = await pipe(
          eventService.getNextEvent(),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<ServiceError, O.Option<Event>, O.Option<Event>>(
            () => T.of(O.none),
            (eventOption) => T.of(eventOption),
          ),
        )();

        expect(O.isSome(result)).toBe(true);
        if (O.isSome(result)) {
          expect(result.value).toMatchObject({
            id: expect.any(Number),
            name: expect.any(String),
            deadlineTime: expect.any(String),
            isNext: true,
          });
        }
      },
      TEST_TIMEOUT,
    );
  });

  describe('Event Creation', () => {
    it(
      'should save events',
      async () => {
        // First get all events
        const existingEvents = await pipe(
          eventService.getEvents(),
          TE.fold<ServiceError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();

        expect(existingEvents.length).toBeGreaterThan(0);

        // Create new events with different IDs
        const newEvents = existingEvents.slice(0, 2).map((event) => ({
          ...event,
          id: (event.id + 1000) as EventId, // Avoid ID conflicts
        }));

        const result = await pipe(
          eventService.saveEvents(newEvents),
          TE.fold<ServiceError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();

        expect(result.length).toBe(newEvents.length);
        expect(result[0]).toMatchObject({
          id: newEvents[0].id,
          name: expect.any(String),
          deadlineTime: expect.any(String),
        });
      },
      TEST_TIMEOUT,
    );
  });
});
