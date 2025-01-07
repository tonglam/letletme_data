import * as E from 'fp-ts/Either';
import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { eventRepository } from '../../src/domain/event/repository';
import { redisClient } from '../../src/infrastructure/cache/client';
import { prisma } from '../../src/infrastructure/db/prisma';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import type { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';
import { createEventService } from '../../src/service/event';
import { getCurrentSeason } from '../../src/types/base.type';
import { APIError, APIErrorCode, ServiceError } from '../../src/types/error.type';
import type { Event, EventId } from '../../src/types/event.type';

describe('Event Service Integration Tests', () => {
  const TEST_TIMEOUT = 30000;

  // Test-specific cache keys
  const TEST_CACHE_PREFIX = `${CachePrefix.EVENT}::test`;
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
  const eventService = createEventService(bootstrapApi, eventRepository);

  beforeAll(async () => {
    // Clear existing data
    await prisma.event.deleteMany();

    // Clear test-specific cache keys
    await Promise.all([
      redisClient.del(testCacheKey),
      redisClient.del(testCurrentEventKey),
      redisClient.del(testNextEventKey),
    ]);

    // Sync events from API
    await pipe(
      eventService.syncEventsFromApi(),
      TE.fold<ServiceError, readonly Event[], void>(
        (error) => {
          console.error('Failed to sync events:', error);
          return T.of(undefined);
        },
        () => T.of(undefined),
      ),
    )();
  }, TEST_TIMEOUT);

  afterAll(async () => {
    // Clean up test data
    await prisma.event.deleteMany();

    // Clean up test-specific cache keys
    await Promise.all([
      redisClient.del(testCacheKey),
      redisClient.del(testCurrentEventKey),
      redisClient.del(testNextEventKey),
    ]);

    await redisClient.quit();
    await prisma.$disconnect();
  });

  describe('Service Setup', () => {
    it('should create service with proper interface', () => {
      expect(eventService).toBeDefined();
      expect(eventService.getEvents).toBeDefined();
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
          name: newEvents[0].name,
          deadlineTime: newEvents[0].deadlineTime,
        });
      },
      TEST_TIMEOUT,
    );
  });

  describe('API Integration', () => {
    it(
      'should sync events from API',
      async () => {
        // Clear existing data first
        await prisma.event.deleteMany();

        const result = await pipe(
          eventService.syncEventsFromApi(),
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
      'should handle API errors',
      async () => {
        // Create mock client with failing bootstrap endpoint
        const mockClient: FPLEndpoints = {
          bootstrap: {
            getBootstrapStatic: () =>
              Promise.resolve(
                E.left({
                  code: APIErrorCode.VALIDATION_ERROR,
                  message: 'Failed to fetch events from API',
                  name: 'APIError',
                  timestamp: new Date(),
                  details: { httpStatus: 500 },
                } as APIError),
              ),
          },
          element: { getElementSummary: jest.fn() },
          entry: {
            getEntry: jest.fn(),
            getEntryTransfers: jest.fn(),
            getEntryHistory: jest.fn(),
          },
          event: {
            getLive: jest.fn(),
            getPicks: jest.fn(),
            getFixtures: jest.fn(),
          },
          leagues: {
            getClassicLeague: jest.fn(),
            getH2hLeague: jest.fn(),
            getCup: jest.fn(),
          },
        };

        const failingApi = createBootstrapApiAdapter(mockClient);
        const failingService = createEventService(failingApi, eventRepository);

        const result = await pipe(
          failingService.syncEventsFromApi(),
          TE.fold<ServiceError, readonly Event[], ServiceError | null>(
            (error) => T.of(error),
            () => T.of(null),
          ),
        )();

        expect(result).not.toBeNull();
        if (result) {
          expect(result.message).toBe('Service integration failed');
          expect(result.code).toBe('INTEGRATION_ERROR');
          expect(result.details).toBeDefined();
          expect(result.details?.error).toBeDefined();
        }
      },
      TEST_TIMEOUT,
    );
  });
});
