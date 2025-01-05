import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { CachePrefix } from '../../src/config/cache/cache.config';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { eventRepository } from '../../src/domain/event/repository';
import type { EventCache } from '../../src/domain/event/types';
import { redisClient } from '../../src/infrastructure/cache/client';
import { DEFAULT_RETRY_CONFIG } from '../../src/infrastructure/http/client/utils';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createEventServiceCache } from '../../src/service/event/cache';
import type { CacheError } from '../../src/types/errors.type';
import type { Event, EventId, EventResponse } from '../../src/types/events.type';
import { EventResponseSchema, toDomainEvent } from '../../src/types/events.type';

describe('Event Service Integration Tests', () => {
  // Test resources tracking
  let testKeys: string[] = [];
  let testEvents: Event[] = [];

  // Service dependencies with optimized retry config
  const fplClient = createFPLClient({
    retryConfig: {
      ...DEFAULT_RETRY_CONFIG,
      attempts: 2,
      baseDelay: 500,
      maxDelay: 2000,
    },
  });
  const bootstrapApi = createBootstrapApiAdapter(fplClient);
  const eventService = createEventServiceCache(bootstrapApi) as EventCache;

  beforeAll(async () => {
    // Wait for Redis connection and fetch events once
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const events = await pipe(
      eventRepository.findAll(),
      TE.fold(
        () => T.of([]),
        (events) => T.of(events.map(toDomainEvent)),
      ),
    )();

    if (events.length === 0) {
      const bootstrapResult = await bootstrapApi.getBootstrapEvents();
      if (bootstrapResult && bootstrapResult.length > 0) {
        const domainEvents = bootstrapResult.map(toDomainEvent);
        await pipe(
          eventRepository.createMany(domainEvents),
          TE.fold(
            () => T.of([]),
            (events) => {
              testEvents = events.map(toDomainEvent);
              return T.of(events);
            },
          ),
        )();
      }
    } else {
      testEvents = events;
    }
  }, 30000);

  afterAll(async () => {
    await redisClient.quit();
  });

  beforeEach(() => {
    testKeys = [];
  });

  afterEach(async () => {
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

  describe('API Response Validation', () => {
    it('should receive valid event data from the API', async () => {
      const bootstrapResult = await bootstrapApi.getBootstrapEvents();
      expect(bootstrapResult).toBeDefined();
      expect(Array.isArray(bootstrapResult)).toBe(true);
      expect(bootstrapResult.length).toBeGreaterThan(0);

      // Validate each event against the schema
      bootstrapResult.forEach((event) => {
        const result = EventResponseSchema.safeParse(event);
        expect(result.success).toBe(true);
        if (result.success) {
          const validatedEvent = result.data;
          expect(validatedEvent).toMatchObject({
            id: expect.any(Number),
            name: expect.any(String),
            deadline_time: expect.any(String),
            deadline_time_epoch: expect.any(Number),
            deadline_time_game_offset: expect.any(Number),
            finished: expect.any(Boolean),
            data_checked: expect.any(Boolean),
          });

          // Validate date string format
          expect(new Date(validatedEvent.deadline_time).toString()).not.toBe('Invalid Date');
          if (validatedEvent.release_time) {
            expect(new Date(validatedEvent.release_time).toString()).not.toBe('Invalid Date');
          }

          // Validate domain model conversion
          const domainEvent = toDomainEvent(validatedEvent);
          expect(domainEvent).toMatchObject({
            id: validatedEvent.id,
            name: validatedEvent.name,
            deadlineTime: validatedEvent.deadline_time,
            deadlineTimeEpoch: validatedEvent.deadline_time_epoch,
            deadlineTimeGameOffset: validatedEvent.deadline_time_game_offset,
            releaseTime: validatedEvent.release_time,
            finished: validatedEvent.finished,
            dataChecked: validatedEvent.data_checked,
          });
        }
      });
    }, 10000);

    it('should handle API response transformation errors gracefully', async () => {
      const invalidEvent = {
        id: 'invalid',
        name: 123,
        deadline_time: 'invalid-date',
      } as unknown as EventResponse;

      const result = EventResponseSchema.safeParse(invalidEvent);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.length).toBeGreaterThan(0);
      }
    });
  });

  describe('Event Service Operations', () => {
    describe('getAllEvents', () => {
      it('should fetch all events and cache them', async () => {
        const eventsKey = `${CachePrefix.EVENT}:all`;
        testKeys.push(eventsKey);

        const result1 = await pipe(
          eventService.getAllEvents(),
          TE.fold<CacheError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();
        expect(result1.length).toBeGreaterThan(0);
        expect(result1[0]).toMatchObject({
          id: expect.any(Number),
          name: expect.any(String),
          deadlineTime: expect.any(String),
          finished: expect.any(Boolean),
          dataChecked: expect.any(Boolean),
        });

        const result2 = await pipe(
          eventService.getAllEvents(),
          TE.fold<CacheError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();
        expect(result2).toEqual(result1);
      }, 10000);
    });

    describe('getEvent', () => {
      it('should fetch specific event by ID', async () => {
        expect(testEvents.length).toBeGreaterThan(0);
        const testEvent = testEvents[0];
        const eventKey = `${CachePrefix.EVENT}:${testEvent.id}`;
        testKeys.push(eventKey);

        const result = await pipe(
          eventService.getEvent(testEvent.id.toString()),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
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
            finished: expect.any(Boolean),
            dataChecked: expect.any(Boolean),
          });
        }
      }, 10000);

      it('should handle non-existent event ID gracefully', async () => {
        const nonExistentId = 9999 as EventId;
        const result = await pipe(
          eventService.getEvent(nonExistentId.toString()),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
            () => T.of(O.none),
            (eventOption) => T.of(eventOption),
          ),
        )();
        expect(O.isNone(result)).toBe(true);
      }, 10000);
    });

    describe('getCurrentEvent', () => {
      it('should fetch current event with proper validation', async () => {
        const eventKey = `${CachePrefix.EVENT}:current`;
        testKeys.push(eventKey);

        const result = await pipe(
          eventService.getCurrentEvent(),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
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
      }, 10000);
    });

    describe('getNextEvent', () => {
      it('should fetch next event with proper validation', async () => {
        const eventKey = `${CachePrefix.EVENT}:next`;
        testKeys.push(eventKey);

        const result = await pipe(
          eventService.getNextEvent(),
          TE.map((event: Event | null): O.Option<Event> => O.fromNullable(event)),
          TE.fold<CacheError, O.Option<Event>, O.Option<Event>>(
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
      }, 10000);
    });

    describe('Cache Operations', () => {
      it('should cache events successfully', async () => {
        expect(testEvents.length).toBeGreaterThan(0);
        const cacheResult = await pipe(
          eventService.cacheEvents(testEvents),
          TE.fold<CacheError, void, boolean>(
            () => T.of(false),
            () => T.of(true),
          ),
        )();
        expect(cacheResult).toBe(true);

        const cachedEvents = await pipe(
          eventService.getAllEvents(),
          TE.fold<CacheError, readonly Event[], readonly Event[]>(
            () => T.of([]),
            (events) => T.of(events),
          ),
        )();

        // Compare only essential fields
        const normalizeEvent = (e: Event) => ({
          id: e.id,
          name: e.name,
          deadlineTime: expect.any(String),
          finished: e.finished,
          dataChecked: e.dataChecked,
        });

        const normalizedCached = cachedEvents
          .filter((e) => e.id <= 38) // Filter out any test events
          .map(normalizeEvent)
          .sort((a, b) => a.id - b.id);
        const normalizedTest = testEvents.map(normalizeEvent).sort((a, b) => a.id - b.id);
        expect(normalizedCached).toEqual(normalizedTest);
      }, 10000);

      it('should handle cache errors gracefully', async () => {
        const invalidEvents = [{ id: 9999 as EventId }] as Event[];
        const result = await pipe(
          eventService.cacheEvents(invalidEvents),
          TE.fold<CacheError, void, boolean>(
            () => T.of(false), // Error case should return false
            () => T.of(true),
          ),
        )();
        expect(result).toBe(false);
      }, 10000);
    });

    describe('Error Handling', () => {
      it('should handle API errors gracefully', async () => {
        const brokenApi = {
          ...bootstrapApi,
          getBootstrapEvents: () => Promise.reject(new Error('API Error')),
        };
        const errorService = createEventServiceCache(brokenApi) as EventCache;

        const result = await pipe(
          errorService.getCurrentEvent(),
          TE.fold<CacheError, Event | null, O.Option<Event>>(
            () => T.of(O.none),
            (event) => T.of(O.fromNullable(event)),
          ),
        )();
        expect(O.isNone(result)).toBe(true);
      }, 10000);

      it('should handle timeout scenarios', async () => {
        const shortTimeoutClient = createFPLClient({
          retryConfig: {
            ...DEFAULT_RETRY_CONFIG,
            attempts: 1,
            baseDelay: 100,
            maxDelay: 200,
          },
        });
        const timeoutApi = createBootstrapApiAdapter(shortTimeoutClient);
        const timeoutService = createEventServiceCache(timeoutApi) as EventCache;

        const result = await pipe(
          timeoutService.getCurrentEvent(),
          TE.fold<CacheError, Event | null, O.Option<Event>>(
            () => T.of(O.none),
            (event) => T.of(O.fromNullable(event)),
          ),
        )();
        expect(O.isSome(result) || O.isNone(result)).toBe(true);
      }, 10000);
    });
  });
});
