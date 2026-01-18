import { beforeAll, describe, expect, test } from 'bun:test';

import { eventLivesCache } from '../../src/cache/operations';
import { eventLiveRepository } from '../../src/repositories/event-lives';
import { syncEventLives, updateEventLivesCache } from '../../src/services/event-lives.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Event Lives Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // Get current event ID for testing
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Sync event live data - tests: FPL API → Transform → DB → Redis
    const result = await syncEventLives(testEventId);
    expect(result.count).toBeGreaterThan(0);
  });

  describe('Sync Integration', () => {
    test('should sync event live data from FPL API to database', async () => {
      const dbEventLives = await eventLiveRepository.findByEventId(testEventId);
      expect(dbEventLives.length).toBeGreaterThan(0);
      expect(dbEventLives[0].eventId).toBeTypeOf('number');
      expect(dbEventLives[0].elementId).toBeTypeOf('number');
      expect(dbEventLives[0].totalPoints).toBeTypeOf('number');
    });

    test('should sync and populate cache', async () => {
      // Sync should populate cache
      const result = await syncEventLives(testEventId);
      expect(result.count).toBeGreaterThan(0);

      // Verify cache is populated
      const cachedData = await eventLivesCache.getByEventId(testEventId);
      expect(cachedData).toBeDefined();
      expect(cachedData?.length).toBeGreaterThan(0);
    });

    test('should update cache only without DB writes', async () => {
      // Get initial DB count
      const beforeDbCount = (await eventLiveRepository.findByEventId(testEventId)).length;

      // Update cache only
      const result = await updateEventLivesCache(testEventId);
      expect(result.count).toBeGreaterThan(0);

      // Verify cache is updated
      const cachedData = await eventLivesCache.getByEventId(testEventId);
      expect(cachedData).toBeDefined();
      expect(cachedData?.length).toBe(result.count);

      // Verify DB count unchanged (no new writes from cache-only update)
      const afterDbCount = (await eventLiveRepository.findByEventId(testEventId)).length;
      expect(afterDbCount).toBe(beforeDbCount);
    });

    test('should be faster than full sync', async () => {
      // Measure cache-only update time
      const cacheStart = performance.now();
      await updateEventLivesCache(testEventId);
      const cacheTime = performance.now() - cacheStart;

      // Measure full sync time
      const syncStart = performance.now();
      await syncEventLives(testEventId);
      const syncTime = performance.now() - syncStart;

      // Cache-only should be faster (no DB writes)
      expect(cacheTime).toBeLessThan(syncTime);
      expect(cacheTime).toBeLessThan(1000); // Should complete in under 1 second
    });

    test('should respect unique constraint on (eventId, elementId)', async () => {
      // Get existing record
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      if (eventLives.length === 0) {
        return; // Skip if no data
      }

      const existing = eventLives[0];

      // Try to upsert same record with different points using batch
      const updated = {
        ...existing,
        totalPoints: existing.totalPoints + 10,
      };

      const results = await eventLiveRepository.upsertBatch([updated]);
      expect(results.length).toBe(1);

      // Verify no duplicates
      const allRecords = await eventLiveRepository.findByEventId(testEventId);
      const sameElement = allRecords.filter((r) => r.elementId === existing.elementId);
      expect(sameElement.length).toBe(1);
    });
  });

  describe('Repository Integration', () => {
    test('should find event lives by event ID', async () => {
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      expect(eventLives.length).toBeGreaterThan(0);
      expect(eventLives[0].eventId).toBe(testEventId);
    });

    test('should upsert single event live via batch', async () => {
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
      if (eventLives.length === 0) return;

      const existing = eventLives[0];
      const updated = {
        ...existing,
        totalPoints: existing.totalPoints + 5,
      };

      const results = await eventLiveRepository.upsertBatch([updated]);
      expect(results.length).toBe(1);
      expect(results[0].totalPoints).toBe(updated.totalPoints);
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
    test('should maintain consistent data between sync and repository', async () => {
      const dbEventLives = await eventLiveRepository.findByEventId(testEventId);
      const cachedEventLives = await eventLivesCache.getByEventId(testEventId);

      expect(cachedEventLives).not.toBeNull();
      expect(cachedEventLives!.length).toBe(dbEventLives.length);
      
      if (cachedEventLives!.length > 0 && dbEventLives.length > 0) {
        // Create maps for comparison
        const dbMap = new Map(dbEventLives.map((el) => [el.elementId, el]));
        const cacheMap = new Map(cachedEventLives!.map((el) => [el.elementId, el]));
        
        // Verify all cached elements exist in DB
        for (const [elementId, cached] of cacheMap) {
          const db = dbMap.get(elementId);
          expect(db).toBeDefined();
          expect(cached.eventId).toBe(db!.eventId);
          expect(cached.elementId).toBe(db!.elementId);
        }
      }
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
      const eventLives = await eventLiveRepository.findByEventId(testEventId);
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
      const eventLives = await eventLiveRepository.findByEventId(testEventId);

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
  });

  describe('Sync Operation', () => {
    test('should sync event live data successfully', async () => {
      const result = await syncEventLives(testEventId);

      expect(result).toHaveProperty('count');
      expect(result).toHaveProperty('errors');
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBe(0);
    });

    test('should update database after sync', async () => {
      const beforeCount = (await eventLiveRepository.findByEventId(testEventId)).length;

      await syncEventLives(testEventId);

      const afterCount = (await eventLiveRepository.findByEventId(testEventId)).length;
      expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
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
  });
});
