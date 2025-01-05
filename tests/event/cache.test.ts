import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { createEventCache } from '../../src/domain/event/cache';
import { redisClient } from '../../src/infrastructure/cache/client';
import { createRedisCache } from '../../src/infrastructure/cache/redis-cache';
import type { Event, EventResponse } from '../../src/types/events.type';
import { toDomainEvent } from '../../src/types/events.type';
import bootstrapData from '../data/bootstrap.json';

describe('Event Cache Tests', () => {
  let testEvents: Event[];
  const TEST_PREFIX = 'test:event';
  const TEST_SEASON = '2023';

  beforeAll(() => {
    // Convert bootstrap events to domain events
    testEvents = bootstrapData.events.map((event) =>
      toDomainEvent({
        ...event,
        deadline_time_game_offset: 0,
        release_time_epoch: null,
        release_time_game_offset: null,
        chip_plays_processed: false,
        released: false,
      } as EventResponse),
    );
  });

  beforeEach(async () => {
    // Clean up any existing test keys
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(existingKeys);
    }
  });

  afterAll(async () => {
    // Final cleanup
    const existingKeys = await redisClient.keys(`${TEST_PREFIX}*`);
    if (existingKeys.length > 0) {
      await redisClient.del(existingKeys);
    }
    await redisClient.quit();
  });

  describe('Cache Operations', () => {
    const getDateString = (date: Date | string): string => {
      return new Date(date).toISOString();
    };

    const compareEvents = (a: Event, b: Event): boolean => {
      const aWithoutDate = { ...a, deadlineTime: getDateString(a.deadlineTime) };
      const bWithoutDate = { ...b, deadlineTime: getDateString(b.deadlineTime) };
      return JSON.stringify(aWithoutDate) === JSON.stringify(bWithoutDate);
    };

    const compareEventArrays = (a: readonly Event[], b: readonly Event[]): boolean => {
      if (a.length !== b.length) {
        console.log('Length mismatch:', a.length, b.length);
        return false;
      }

      // Sort both arrays by ID for consistent comparison
      const sortedA = [...a].sort((x, y) => x.id - y.id);
      const sortedB = [...b].sort((x, y) => x.id - y.id);

      for (let i = 0; i < sortedA.length; i++) {
        if (!compareEvents(sortedA[i], sortedB[i])) {
          console.log('Mismatch at index', i);
          console.log('Event A:', JSON.stringify(sortedA[i], null, 2));
          console.log('Event B:', JSON.stringify(sortedB[i], null, 2));
          return false;
        }
      }

      return true;
    };

    it('should set and get a single event', async () => {
      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const eventCache = createEventCache(
        redis,
        {
          getOne: async () => null,
          getAll: async () => [],
          getCurrentEvent: async () => null,
          getNextEvent: async () => null,
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
        },
      );

      const testEvent = testEvents[0];
      const cacheResult = await pipe(eventCache.cacheEvent(testEvent))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(eventCache.getEvent(testEvent.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(compareEvents(getResult.right, testEvent)).toBe(true);
      }
    });

    it('should set and get multiple events', async () => {
      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const eventCache = createEventCache(
        redis,
        {
          getOne: async () => null,
          getAll: async () => [],
          getCurrentEvent: async () => null,
          getNextEvent: async () => null,
        },
        {
          keyPrefix: TEST_PREFIX,
          season: TEST_SEASON,
        },
      );

      const cacheResult = await pipe(eventCache.cacheEvents(testEvents))();
      expect(E.isRight(cacheResult)).toBe(true);

      const getResult = await pipe(eventCache.getAllEvents())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        const cachedEvents = getResult.right;
        expect(compareEventArrays(cachedEvents, testEvents)).toBe(true);
      }
    });

    it('should handle cache miss with data provider fallback', async () => {
      // Clear the cache before starting the test
      const cacheKey = `${TEST_PREFIX}::${TEST_SEASON}`;
      const keys = await redisClient.keys(`${cacheKey}*`);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }

      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const testEvent = testEvents[0];
      const mockDataProvider = {
        getOne: jest.fn().mockImplementation(async (id: number) => {
          const event = testEvents.find((e) => e.id === id);
          return event || null;
        }),
        getAll: jest.fn().mockImplementation(async () => {
          // Return a copy of testEvents to avoid mutation
          return [...testEvents];
        }),
        getCurrentEvent: jest.fn().mockResolvedValue(testEvents.find((e) => e.isCurrent)),
        getNextEvent: jest.fn().mockResolvedValue(testEvents.find((e) => e.isNext)),
      };

      const eventCache = createEventCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test cache miss for single event
      const getResult = await pipe(eventCache.getEvent(testEvent.id.toString()))();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(compareEvents(getResult.right, testEvent)).toBe(true);
        expect(mockDataProvider.getOne).toHaveBeenCalledWith(testEvent.id);
      }

      // Clear the cache before testing getAllEvents
      const allKeys = await redisClient.keys(`${cacheKey}*`);
      if (allKeys.length > 0) {
        await redisClient.del(allKeys);
      }

      // Test cache miss for all events
      const getAllResult = await pipe(eventCache.getAllEvents())();
      expect(E.isRight(getAllResult)).toBe(true);
      if (E.isRight(getAllResult) && getAllResult.right) {
        const cachedEvents = getAllResult.right;
        expect(cachedEvents.length).toBe(testEvents.length);
        expect(compareEventArrays(cachedEvents, testEvents)).toBe(true);
        expect(mockDataProvider.getAll).toHaveBeenCalled();

        // Verify that events are properly cached
        const verifyResult = await pipe(eventCache.getAllEvents())();
        expect(E.isRight(verifyResult)).toBe(true);
        if (E.isRight(verifyResult) && verifyResult.right) {
          expect(verifyResult.right.length).toBe(testEvents.length);
          expect(compareEventArrays(verifyResult.right, testEvents)).toBe(true);
          // getAll should not be called again
          expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
        }
      }
    });

    it('should handle current and next event caching', async () => {
      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const currentEvent = testEvents.find((e) => e.isCurrent);
      const nextEvent = testEvents.find((e) => e.isNext);
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue([]),
        getCurrentEvent: jest.fn().mockResolvedValue(currentEvent),
        getNextEvent: jest.fn().mockResolvedValue(nextEvent),
      };

      const eventCache = createEventCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test current event
      const currentResult = await pipe(eventCache.getCurrentEvent())();
      expect(E.isRight(currentResult)).toBe(true);
      if (E.isRight(currentResult) && currentResult.right && currentEvent) {
        expect(compareEvents(currentResult.right, currentEvent)).toBe(true);
        expect(mockDataProvider.getCurrentEvent).toHaveBeenCalled();
      }

      // Test next event
      const nextResult = await pipe(eventCache.getNextEvent())();
      expect(E.isRight(nextResult)).toBe(true);
      if (E.isRight(nextResult) && nextResult.right && nextEvent) {
        expect(compareEvents(nextResult.right, nextEvent)).toBe(true);
        expect(mockDataProvider.getNextEvent).toHaveBeenCalled();
      }
    });

    it('should handle error cases gracefully', async () => {
      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getAll: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getCurrentEvent: jest.fn().mockRejectedValue(new Error('Data provider error')),
        getNextEvent: jest.fn().mockRejectedValue(new Error('Data provider error')),
      };

      const eventCache = createEventCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Test error handling for single event
      const getResult = await pipe(eventCache.getEvent('1'))();
      expect(E.isLeft(getResult)).toBe(true);

      // Test error handling for all events
      const getAllResult = await pipe(eventCache.getAllEvents())();
      expect(E.isLeft(getAllResult)).toBe(true);

      // Test error handling for current event
      const currentResult = await pipe(eventCache.getCurrentEvent())();
      expect(E.isLeft(currentResult)).toBe(true);

      // Test error handling for next event
      const nextResult = await pipe(eventCache.getNextEvent())();
      expect(E.isLeft(nextResult)).toBe(true);
    });

    it('should warm up cache with initial data', async () => {
      const redis = createRedisCache<Event>({ keyPrefix: TEST_PREFIX });
      const mockDataProvider = {
        getOne: jest.fn().mockResolvedValue(null),
        getAll: jest.fn().mockResolvedValue(testEvents),
        getCurrentEvent: jest.fn().mockResolvedValue(null),
        getNextEvent: jest.fn().mockResolvedValue(null),
      };

      const eventCache = createEventCache(redis, mockDataProvider, {
        keyPrefix: TEST_PREFIX,
        season: TEST_SEASON,
      });

      // Warm up cache
      const warmUpResult = await pipe(eventCache.warmUp())();
      expect(E.isRight(warmUpResult)).toBe(true);
      expect(mockDataProvider.getAll).toHaveBeenCalled();

      // Verify data is cached
      const getResult = await pipe(eventCache.getAllEvents())();
      expect(E.isRight(getResult)).toBe(true);
      if (E.isRight(getResult) && getResult.right) {
        expect(compareEventArrays(getResult.right, testEvents)).toBe(true);
        // Should not call data provider again
        expect(mockDataProvider.getAll).toHaveBeenCalledTimes(1);
      }
    });
  });
});
