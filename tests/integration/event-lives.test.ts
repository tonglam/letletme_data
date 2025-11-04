import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { eventLiveRepository } from '../../src/repositories/event-lives';
import {
  clearAllEventLivesCache,
  clearEventLivesCache,
  getEventLiveByEventAndElement,
  getEventLivesByElementId,
  getEventLivesByEventId,
  syncEventLives,
} from '../../src/services/event-lives.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Event Lives Integration Tests', () => {
  let testEventId: number;
  let testElementId: number;

  beforeAll(async () => {
    // Get current event ID for testing
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Clear cache before starting
    await clearAllEventLivesCache();

    // Sync event live data - tests: FPL API → Transform → DB → Redis
    const result = await syncEventLives(testEventId);
    expect(result.count).toBeGreaterThan(0);

    // Get a test element ID from the synced data
    const eventLives = await eventLiveRepository.findByEventId(testEventId);
    if (eventLives.length > 0) {
      testElementId = eventLives[0].elementId;
    } else {
      throw new Error('No event live data found after sync');
    }
  });

  afterAll(async () => {
    // Clean up: clear cache (but keep database data for other tests)
    await clearAllEventLivesCache();
  });

  describe('External Data Integration', () => {
    test('should fetch and sync event live data from FPL API', async () => {
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives[0]).toHaveProperty('eventId');
      expect(eventLives[0]).toHaveProperty('elementId');
      expect(eventLives[0]).toHaveProperty('totalPoints');
      expect(eventLives[0]).toHaveProperty('minutes');
    });

    test('should save event live data to database', async () => {
      const dbEventLives = await eventLiveRepository.findByEventId(testEventId);
      expect(dbEventLives.length).toBeGreaterThan(0);
      expect(dbEventLives[0].eventId).toBeTypeOf('number');
      expect(dbEventLives[0].elementId).toBeTypeOf('number');
      expect(dbEventLives[0].totalPoints).toBeTypeOf('number');
    });

    test('should respect unique constraint on (eventId, elementId)', async () => {
      // Get existing record
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      if (eventLives.length === 0) {
        return; // Skip if no data
      }

      const existing = eventLives[0];

      // Try to upsert same record with different points
      const updated = {
        ...existing,
        totalPoints: existing.totalPoints + 10,
      };

      await expect(eventLiveRepository.upsert(updated)).resolves.toBeDefined();

      // Verify it was updated, not duplicated
      const afterUpdate = await eventLiveRepository.findByEventAndElement(
        existing.eventId,
        existing.elementId,
      );
      expect(afterUpdate).toBeDefined();
      expect(afterUpdate?.totalPoints).toBe(updated.totalPoints);

      // Verify no duplicates
      const allRecords = await eventLiveRepository.findByEventId(testEventId);
      const sameElement = allRecords.filter((r) => r.elementId === existing.elementId);
      expect(sameElement.length).toBe(1);
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve event lives by event ID', async () => {
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives[0].eventId).toBe(testEventId);
    });

    test('should retrieve specific event live by event and element', async () => {
      const eventLive = await getEventLiveByEventAndElement(testEventId, testElementId);
      expect(eventLive).toBeDefined();
      expect(eventLive?.eventId).toBe(testEventId);
      expect(eventLive?.elementId).toBe(testElementId);
    });

    test('should retrieve event lives by element ID', async () => {
      const eventLives = await getEventLivesByElementId(testElementId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives.some((el) => el.elementId === testElementId)).toBe(true);
    });

    test('should return null for non-existent event live', async () => {
      const nonExistentElementId = 999999;
      const eventLive = await getEventLiveByEventAndElement(testEventId, nonExistentElementId);
      expect(eventLive).toBeNull();
    });
  });

  describe('Cache Integration', () => {
    test('should use cache for fast retrieval', async () => {
      // First call - should populate cache
      const firstCall = await getEventLivesByEventId(testEventId);

      // Second call - should hit cache
      const startTime = performance.now();
      const secondCall = await getEventLivesByEventId(testEventId);
      const endTime = performance.now();

      expect(secondCall).toEqual(firstCall);
      expect(endTime - startTime).toBeLessThan(300); // Cache should be fast (parsing 742 records)
    });

    test('should handle cache miss and database fallback', async () => {
      // Clear cache to force database fallback
      await clearEventLivesCache(testEventId);

      // Should still work with database fallback
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
    });

    test('should clear specific event cache', async () => {
      // Populate cache
      await getEventLivesByEventId(testEventId);

      // Clear specific event cache
      await clearEventLivesCache(testEventId);

      // Next call should fetch from database
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
    });

    test('should clear all event lives cache', async () => {
      // Populate cache
      await getEventLivesByEventId(testEventId);

      // Clear all cache
      await clearAllEventLivesCache();

      // Next call should fetch from database
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
    });
  });

  describe('Repository Integration', () => {
    test('should find event lives by event ID', async () => {
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives[0].eventId).toBe(testEventId);
    });

    test('should find event live by event and element', async () => {
      const eventLive = await eventLiveRepository.findByEventAndElement(testEventId, testElementId);
      expect(eventLive).toBeDefined();
      expect(eventLive?.eventId).toBe(testEventId);
      expect(eventLive?.elementId).toBe(testElementId);
    });

    test('should find event lives by element ID', async () => {
      const eventLives = await eventLiveRepository.findByElementId(testElementId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives.some((el) => el.elementId === testElementId)).toBe(true);
    });

    test('should upsert single event live', async () => {
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      if (eventLives.length === 0) return;

      const existing = eventLives[0];
      const updated = {
        ...existing,
        totalPoints: existing.totalPoints + 5,
      };

      const result = await eventLiveRepository.upsert(updated);
      expect(result).toBeDefined();
      expect(result.totalPoints).toBe(updated.totalPoints);
    });

    test('should batch upsert event lives', async () => {
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      if (eventLives.length < 2) return;

      const batch = eventLives.slice(0, 2).map((el) => ({
        ...el,
        totalPoints: el.totalPoints + 1,
      }));

      const results = await eventLiveRepository.upsertBatch(batch);
      expect(results.length).toBe(2);
      results.forEach((result, index) => {
        expect(result.totalPoints).toBe(batch[index].totalPoints);
      });
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      // Clear cache to ensure fresh data
      await clearEventLivesCache(testEventId);

      const serviceEventLives = await getEventLivesByEventId(testEventId);
      const dbEventLives = await eventLiveRepository.findByEventId(testEventId);

      expect(serviceEventLives.length).toBe(dbEventLives.length);
      expect(serviceEventLives[0].eventId).toBe(dbEventLives[0].eventId);
      expect(serviceEventLives[0].elementId).toBe(dbEventLives[0].elementId);
    });

    test('should maintain data integrity after sync', async () => {
      const beforeSync = await eventLiveRepository.findByEventId(testEventId);

      // Re-sync same event
      await syncEventLives(testEventId);

      const afterSync = await eventLiveRepository.findByEventId(testEventId);

      // Should have same number of records (updated, not duplicated)
      expect(afterSync.length).toBe(beforeSync.length);
    });
  });

  describe('Data Validation', () => {
    test('should have valid event live data structure', async () => {
      const eventLives = await getEventLivesByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);

      const eventLive = eventLives[0];

      // Required fields
      expect(typeof eventLive.eventId).toBe('number');
      expect(typeof eventLive.elementId).toBe('number');
      expect(typeof eventLive.totalPoints).toBe('number');

      // Nullable fields
      expect(['number', 'object']).toContain(typeof eventLive.minutes);
      expect(['number', 'object']).toContain(typeof eventLive.goalsScored);
      expect(['number', 'object']).toContain(typeof eventLive.assists);

      // Boolean fields
      expect(['boolean', 'object']).toContain(typeof eventLive.starts);
      expect(['boolean', 'object']).toContain(typeof eventLive.inDreamTeam);

      // String fields
      expect(['string', 'object']).toContain(typeof eventLive.expectedGoals);
    });

    test('should have valid point ranges', async () => {
      const eventLives = await getEventLivesByEventId(testEventId);

      eventLives.forEach((eventLive) => {
        // Points should be within reasonable range
        expect(eventLive.totalPoints).toBeGreaterThanOrEqual(-10);
        expect(eventLive.totalPoints).toBeLessThanOrEqual(30);

        // Minutes should be valid
        if (eventLive.minutes !== null) {
          expect(eventLive.minutes).toBeGreaterThanOrEqual(0);
          expect(eventLive.minutes).toBeLessThanOrEqual(120);
        }

        // Stats should be non-negative
        if (eventLive.goalsScored !== null) {
          expect(eventLive.goalsScored).toBeGreaterThanOrEqual(0);
        }
        if (eventLive.assists !== null) {
          expect(eventLive.assists).toBeGreaterThanOrEqual(0);
        }
        if (eventLive.saves !== null) {
          expect(eventLive.saves).toBeGreaterThanOrEqual(0);
        }
      });
    });
  });

  describe('Query Performance', () => {
    test('should efficiently query by event ID', async () => {
      const startTime = performance.now();
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      const endTime = performance.now();

      expect(eventLives.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });

    test('should efficiently query by event and element', async () => {
      const startTime = performance.now();
      const eventLive = await eventLiveRepository.findByEventAndElement(testEventId, testElementId);
      const endTime = performance.now();

      expect(eventLive).toBeDefined();
      expect(endTime - startTime).toBeLessThan(500); // Should be very fast with indexes
    });

    test('should efficiently query by element ID', async () => {
      const startTime = performance.now();
      const eventLives = await eventLiveRepository.findByElementId(testElementId);
      const endTime = performance.now();

      expect(eventLives.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });
  });

  describe('Sync Operation', () => {
    test('should sync event live data successfully', async () => {
      const result = await syncEventLives(testEventId);

      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('errors');
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
    });

    test('should update cache after sync', async () => {
      // Clear cache first
      await clearEventLivesCache(testEventId);

      // Sync should populate cache
      await syncEventLives(testEventId);

      // Next call should be cached (fast)
      const startTime = performance.now();
      const eventLives = await getEventLivesByEventId(testEventId);
      const endTime = performance.now();

      expect(eventLives.length).toBeGreaterThan(0);
      expect(endTime - startTime).toBeLessThan(300); // Cache hit should be fast (parsing 742 records)
    });
  });

  describe('Error Handling', () => {
    test('should handle sync for invalid event ID gracefully', async () => {
      const invalidEventId = 999;

      await expect(syncEventLives(invalidEventId)).rejects.toThrow();
    });

    test('should return empty array for non-existent event', async () => {
      const nonExistentEventId = 99999;
      const eventLives = await eventLiveRepository.findByEventId(nonExistentEventId);

      expect(eventLives).toEqual([]);
    });

    test('should return null for non-existent event live', async () => {
      const nonExistentElementId = 999999;
      const eventLive = await eventLiveRepository.findByEventAndElement(
        testEventId,
        nonExistentElementId,
      );

      expect(eventLive).toBeNull();
    });
  });
});
