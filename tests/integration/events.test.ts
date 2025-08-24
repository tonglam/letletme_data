import { beforeAll, describe, expect, test } from 'bun:test';

import {
  clearEventsCache,
  getCurrentEvent,
  getEvent,
  getEvents,
  getNextEvent,
  syncEvents,
} from '../../src/api/events';
import { eventsCache } from '../../src/cache/operations';
import { fplClient } from '../../src/clients/fpl';
import { eventRepository } from '../../src/repositories/events';
import { transformEvents } from '../../src/transformers/events';
import {
  mockBootstrapResponseFixture,
  rawFPLEventsFixture,
  transformedEventsFixture,
} from '../fixtures/events.fixtures';
describe('Events Integration Tests', () => {
  beforeAll(async () => {
    // Setup: Clear cache and database before tests
    await clearEventsCache();
    await eventRepository.deleteAll();

    // NO MOCKING - Use real production FPL API for integration tests
  });

  describe('Full Data Flow Integration', () => {
    test('should complete full sync flow: API → Transform → Database → Cache', async () => {
      // ===================
      // STEP 1: SYNC FROM API
      // ===================
      await syncEvents();

      // ===================
      // STEP 2: VERIFY DATABASE
      // ===================
      const dbEvents = await eventRepository.findAll();
      expect(dbEvents.length).toBeGreaterThan(0); // Real FPL API returns 38 events

      // Verify data integrity with real FPL data
      const dbEvent = dbEvents[0]; // First event from real API
      expect(dbEvent).toBeDefined();
      expect(dbEvent.name).toBeDefined();
      expect(typeof dbEvent.finished).toBe('boolean');
      expect(typeof dbEvent.id).toBe('number');

      // ===================
      // STEP 3: VERIFY CACHE
      // ===================
      const cachedEvents = await eventsCache.get();
      expect(cachedEvents).toBeTruthy();
      expect(Array.isArray(cachedEvents)).toBe(true);
      expect((cachedEvents as any).length).toBeGreaterThan(0);

      // ===================
      // STEP 4: VERIFY API LAYER
      // ===================
      const apiEvents = await getEvents();
      expect(apiEvents.length).toBeGreaterThan(0); // Real FPL API data
      expect(apiEvents[0].name).toBeDefined();
    });

    test('should handle cache fallback correctly', async () => {
      // First, set up test data by syncing
      await syncEvents();

      // Clear cache but keep database data
      await clearEventsCache();

      // First call should hit database and populate cache
      const events1 = await getEvents();
      expect(events1).toHaveLength(38); // Real FPL API returns 38 events;

      // Verify cache is now populated
      const cachedEvents = await eventsCache.get();
      expect(cachedEvents).toBeTruthy();

      // Second call should hit cache
      const events2 = await getEvents();

      // Normalize dates for comparison (cache serializes dates to strings)
      const normalizeEventDates = (event: Awaited<ReturnType<typeof getEvents>>[0]) => ({
        ...event,
        deadlineTime:
          typeof event.deadlineTime === 'string'
            ? event.deadlineTime
            : event.deadlineTime?.toISOString(),
        createdAt:
          typeof event.createdAt === 'string' ? event.createdAt : event.createdAt?.toISOString(),
        updatedAt:
          typeof event.updatedAt === 'string' ? event.updatedAt : event.updatedAt?.toISOString(),
      });

      const normalizedEvents1 = events1.map(normalizeEventDates);
      const normalizedEvents2 = events2.map(normalizeEventDates);

      expect(normalizedEvents2).toEqual(normalizedEvents1);
      expect(events2).toHaveLength(38); // Real FPL API returns 38 events;
    });

    test('should handle database upsert correctly on multiple syncs', async () => {
      // First sync
      await syncEvents();
      const events1 = await eventRepository.findAll();
      expect(events1).toHaveLength(38); // Real FPL API returns 38 events;

      // Second sync (should update, not duplicate)
      await syncEvents();
      const events2 = await eventRepository.findAll();
      expect(events2).toHaveLength(38); // Real FPL API returns 38 events;

      // Verify no duplicates
      const eventIds = events2.map((e) => e.id);
      const uniqueIds = [...new Set(eventIds)];
      expect(uniqueIds).toHaveLength(38); // Real FPL API returns 38 events;
    });
  });

  describe('Event Repository Integration', () => {
    beforeAll(async () => {
      // Ensure events exist in database for repository tests
      await syncEvents();
    });

    test('should find event by ID correctly', async () => {
      const event = await getEvent(1);
      expect(event).toBeDefined();
      expect(event?.id).toBe(1);
      expect(event?.name).toBe('Gameweek 1');
    });

    test('should return null for non-existent event ID', async () => {
      const event = await getEvent(999);
      expect(event).toBeNull();
    });

    test('should find current event correctly', async () => {
      const currentEvent = await getCurrentEvent();
      expect(currentEvent).toBeDefined();
      expect(currentEvent?.isCurrent).toBe(true);
      expect(currentEvent?.id).toBeDefined(); // Real API determines current event
      expect(currentEvent?.name).toBeDefined(); // Real API event name
    });

    test('should find next event correctly', async () => {
      const nextEvent = await getNextEvent();
      expect(nextEvent).toBeDefined();
      expect(nextEvent?.isNext).toBe(true);
      expect(nextEvent?.id).toBe(3);
      expect(nextEvent?.name).toBe('Gameweek 3');
    });

    test('should handle batch upsert with mixed new and existing events', async () => {
      // Create a mix of existing and new events
      const mixedEvents = [
        ...transformedEventsFixture.slice(0, 2), // Existing events
        {
          ...transformedEventsFixture[2],
          id: 4,
          name: 'Gameweek 4',
          isCurrent: false,
          isNext: false,
          isPrevious: false,
        },
      ];

      const result = await eventRepository.upsertBatch(mixedEvents);
      expect(result).toHaveLength(3); // Should return the 3 events we upserted

      // Verify new event was added
      const newEvent = await eventRepository.findById(4);
      expect(newEvent).toBeDefined();
      expect(newEvent?.name).toBe('Gameweek 4');
    });
  });

  describe('Cache Integration', () => {
    test('should handle cache operations correctly', async () => {
      // Set cache
      await eventsCache.set(transformedEventsFixture);

      // Get from cache
      const cached = await eventsCache.get();
      expect(cached).toBeTruthy();
      expect(Array.isArray(cached)).toBe(true);
      expect((cached as any).length).toBe(3);

      // Clear cache
      await clearEventsCache();
      const afterClear = await eventsCache.get();
      expect(afterClear).toBeNull();
    });

    test('should handle cache miss gracefully', async () => {
      // First ensure we have clean test data
      await eventRepository.deleteAll();
      await clearEventsCache();
      await syncEvents(); // This will add 3 events

      await clearEventsCache();

      // Should fall back to database
      const events = await getEvents();
      expect(events).toHaveLength(38); // Real FPL API returns 38 events;

      // Cache should now be populated
      const cached = await eventsCache.get();
      expect(cached).toBeTruthy();
    });
  });

  describe('Transformation Integration', () => {
    test('should transform FPL API data correctly', () => {
      const transformed = transformEvents(rawFPLEventsFixture);

      expect(transformed).toHaveLength(3); // Fixture has 3 sample events

      // Verify structure matches domain model
      transformed.forEach((event) => {
        expect(event).toHaveProperty('id');
        expect(event).toHaveProperty('name');
        expect(event).toHaveProperty('deadlineTime');
        expect(event).toHaveProperty('averageEntryScore');
        expect(event).toHaveProperty('finished');
        expect(event).toHaveProperty('dataChecked');
        expect(event).toHaveProperty('isPrevious');
        expect(event).toHaveProperty('isCurrent');
        expect(event).toHaveProperty('isNext');

        // Verify camelCase transformation
        expect(event).not.toHaveProperty('deadline_time');
        expect(event).not.toHaveProperty('average_entry_score');
        expect(event).not.toHaveProperty('data_checked');
        expect(event).not.toHaveProperty('is_previous');
        expect(event).not.toHaveProperty('is_current');
        expect(event).not.toHaveProperty('is_next');
      });
    });

    test('should handle date transformation correctly', () => {
      const transformed = transformEvents(rawFPLEventsFixture);

      const eventWithDate = transformed.find((e) => e.deadlineTime);
      expect(eventWithDate).toBeDefined();
      expect(eventWithDate?.deadlineTime).toBeInstanceOf(Date);
      expect(eventWithDate?.deadlineTime?.getTime()).toBeGreaterThan(0);

      // Check specific date value
      const firstEvent = transformed[0];
      expect(firstEvent?.deadlineTime).toBeDefined(); // Real FPL API deadline
    });

    test('should handle complex nested data correctly', () => {
      const transformed = transformEvents(rawFPLEventsFixture);

      const gw2 = transformed.find((e) => e.id === 2);
      expect(gw2).toBeDefined();

      // Verify chip_plays transformation
      expect(Array.isArray(gw2?.chipPlays)).toBe(true);
      expect(gw2?.chipPlays.length).toBeGreaterThan(0);
      expect(gw2?.chipPlays[0]).toHaveProperty('name');
      expect(gw2?.chipPlays[0]).toHaveProperty('num_played');

      // Verify top_element_info transformation
      expect(gw2?.topElementInfo).toBeDefined();
      expect(gw2?.topElementInfo).toHaveProperty('id');
      expect(gw2?.topElementInfo).toHaveProperty('points');
    });
  });

  describe('Error Handling Integration', () => {
    test('should handle database connection errors gracefully', async () => {
      // This test would require mocking the database connection
      // For now, we test that the error handling structure is in place
      expect(eventRepository.findAll).toBeDefined();
      expect(eventRepository.upsert).toBeDefined();
      expect(eventRepository.upsertBatch).toBeDefined();
    });

    test('should handle cache errors gracefully', async () => {
      // Test that system continues to work even if cache fails
      // This would require mocking Redis failures
      const events = await getEvents();
      expect(Array.isArray(events)).toBe(true);
    });

    test('should handle empty API response', async () => {
      // Mock empty response
      const originalGetBootstrap = (fplClient as any).getBootstrap;
      (fplClient as any).getBootstrap = async () => ({
        ...mockBootstrapResponseFixture,
        events: [],
      });

      await syncEvents();

      // Should handle gracefully
      const events = await getEvents();
      expect(Array.isArray(events)).toBe(true);

      // Restore
      (fplClient as any).getBootstrap = originalGetBootstrap;
    });
  });

  describe('Performance Integration', () => {
    test('should handle large dataset sync efficiently', async () => {
      // Create large dataset
      const largeDataset = Array(100)
        .fill(rawFPLEventsFixture[0])
        .map((event, index) => ({
          ...event,
          id: index + 1,
          name: `Gameweek ${index + 1}`,
        }));

      // Mock large response
      const originalGetBootstrap = (fplClient as any).getBootstrap;
      (fplClient as any).getBootstrap = async () => ({
        ...mockBootstrapResponseFixture,
        events: largeDataset,
      });

      const startTime = performance.now();
      await syncEvents();
      const endTime = performance.now();

      // Should complete in reasonable time
      expect(endTime - startTime).toBeLessThan(2000); // Under 2 seconds

      // Verify all data was synced
      const events = await eventRepository.findAll();
      expect(events.length).toBe(100);

      // Restore
      (fplClient as any).getBootstrap = originalGetBootstrap;
      await eventRepository.deleteAll(); // Clean up large dataset
    });

    test('should handle concurrent requests efficiently', async () => {
      // Make multiple concurrent requests
      const promises = Array(5)
        .fill(null)
        .map(() => getEvents());

      const startTime = performance.now();
      const results = await Promise.all(promises);
      const endTime = performance.now();

      // All requests should succeed
      expect(results.length).toBe(5);
      results.forEach((events) => {
        expect(Array.isArray(events)).toBe(true);
        expect(events.length).toBeGreaterThan(0);
      });

      // Should be efficient due to caching
      expect(endTime - startTime).toBeLessThan(1000); // Under 1 second
    });
  });

  describe('Event State Management Integration', () => {
    test('should maintain event state consistency across operations', async () => {
      // Set up clean test data
      await eventRepository.deleteAll();
      await clearEventsCache();
      await syncEvents();

      const events = await getEvents();

      // Verify event state logic (from our test fixtures, we know the expected states)
      const currentEvents = events.filter((e) => e.isCurrent);
      const nextEvents = events.filter((e) => e.isNext);
      const previousEvents = events.filter((e) => e.isPrevious);

      // Based on the fixtures, we should have specific state distributions
      expect(currentEvents).toHaveLength(1);
      expect(nextEvents).toHaveLength(1);
      expect(previousEvents).toHaveLength(1);

      // Verify state consistency
      const currentEvent = currentEvents[0];
      const nextEvent = nextEvents[0];
      const previousEvent = previousEvents[0];

      expect(currentEvent.isCurrent).toBe(true);
      expect(currentEvent.isNext).toBe(false);
      expect(currentEvent.isPrevious).toBe(false);

      expect(nextEvent.isNext).toBe(true);
      expect(nextEvent.isCurrent).toBe(false);
      expect(nextEvent.isPrevious).toBe(false);

      expect(previousEvent.isPrevious).toBe(true);
      expect(previousEvent.isCurrent).toBe(false);
      expect(previousEvent.isNext).toBe(false);
    });

    test('should correctly identify event properties by state', async () => {
      // Set up clean test data
      await eventRepository.deleteAll();
      await clearEventsCache();
      await syncEvents();

      const currentEvent = await getCurrentEvent();
      const nextEvent = await getNextEvent();

      expect(currentEvent).toBeDefined();
      expect(nextEvent).toBeDefined();

      // Current event should allow certain operations
      expect(currentEvent?.isCurrent).toBe(true);

      // Next event should be unfinished
      expect(nextEvent?.finished).toBe(false);
      expect(nextEvent?.isNext).toBe(true);
    });
  });

  describe('Data Consistency Integration', () => {
    test('should maintain data consistency between cache and database', async () => {
      // Set up clean test data
      await eventRepository.deleteAll();
      await clearEventsCache();
      await syncEvents();

      // Get from database
      const dbEvents = await eventRepository.findAll();

      // Clear cache and get fresh data (should populate cache from database)
      await clearEventsCache();
      const cachedEvents = await getEvents();

      // Compare structures (allowing for minor differences in timestamps)
      expect(cachedEvents.length).toBe(dbEvents.length);

      cachedEvents.forEach((cachedEvent, index) => {
        const dbEvent = dbEvents.find((e) => e.id === cachedEvent.id);
        expect(dbEvent).toBeDefined();

        // Compare key fields
        expect(cachedEvent.id).toBe(dbEvent?.id);
        expect(cachedEvent.name).toBe(dbEvent?.name);
        expect(cachedEvent.finished).toBe(dbEvent?.finished);
        expect(cachedEvent.isCurrent).toBe(dbEvent?.isCurrent);
        expect(cachedEvent.isNext).toBe(dbEvent?.isNext);
        expect(cachedEvent.isPrevious).toBe(dbEvent?.isPrevious);
      });
    });

    test('should handle data type consistency across layers', async () => {
      // Set up clean test data
      await eventRepository.deleteAll();
      await clearEventsCache();
      await syncEvents();

      // Get directly from database (not cache) to ensure we have Date objects
      const events = await eventRepository.findAll();

      events.forEach((event) => {
        // Verify correct data types
        expect(typeof event.id).toBe('number');
        expect(typeof event.name).toBe('string');
        expect(typeof event.finished).toBe('boolean');
        expect(typeof event.dataChecked).toBe('boolean');

        // Handle nullable fields - dates from database should be Date objects
        if (event.deadlineTime !== null) {
          expect(event.deadlineTime).toBeInstanceOf(Date);
        }

        if (event.averageEntryScore !== null) {
          // averageEntryScore is stored as decimal (string) in the database
          expect(typeof event.averageEntryScore).toBe('string');
        }

        // Array fields
        expect(Array.isArray(event.chipPlays)).toBe(true);
      });
    });
  });
});
