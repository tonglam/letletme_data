import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { eventLiveExplainCache } from '../../src/cache/operations';
import { eventLiveExplains } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncEventLiveExplain } from '../../src/services/event-live-explains.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Event Live Explains Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // Get current event ID for testing
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Clear cache before tests
    await eventLiveExplainCache.clearByEventId(testEventId);

    // Sync event live explain data - tests: FPL API → Transform → DB → Redis
    const result = await syncEventLiveExplain(testEventId);
    expect(result.count).toBeGreaterThan(0);
  });

  describe('Sync Integration', () => {
    test('should sync event live explain data from FPL API to database', async () => {
      const db = await getDb();
      const dbExplains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      expect(dbExplains.length).toBeGreaterThan(0);
      expect(dbExplains[0].eventId).toBe(testEventId);
      expect(dbExplains[0].elementId).toBeTypeOf('number');
      expect(dbExplains[0].bonus).not.toBeUndefined();
    });

    test('should sync and populate cache', async () => {
      // Re-sync to ensure cache is populated
      const result = await syncEventLiveExplain(testEventId);
      expect(result.count).toBeGreaterThan(0);

      // Verify cache is populated
      const cachedData = await eventLiveExplainCache.getByEventId(testEventId);
      expect(cachedData).toBeDefined();
      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBeGreaterThan(0);
      expect(cachedData?.length).toBe(result.count);
    });

    test('should have consistent data between DB and cache', async () => {
      const db = await getDb();
      const dbExplains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      const cachedExplains = await eventLiveExplainCache.getByEventId(testEventId);

      expect(cachedExplains).not.toBeNull();
      expect(cachedExplains?.length).toBe(dbExplains.length);
    });

    test('should handle re-sync without duplicates', async () => {
      const db = await getDb();
      const beforeSync = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      // Re-sync same event
      await syncEventLiveExplain(testEventId);

      const afterSync = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      // Should have same number of records (updated, not duplicated)
      expect(afterSync.length).toBe(beforeSync.length);
    });
  });

  describe('Data Validation', () => {
    test('should have valid event live explain data structure', async () => {
      const db = await getDb();
      const explains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      expect(explains.length).toBeGreaterThan(0);

      const explain = explains[0];

      // Required fields
      expect(typeof explain.eventId).toBe('number');
      expect(typeof explain.elementId).toBe('number');

      // Points fields (can be null or number)
      expect(['number', 'object']).toContain(typeof explain.bonus);
      expect(['number', 'object']).toContain(typeof explain.minutes);
      expect(['number', 'object']).toContain(typeof explain.minutesPoints);
      expect(['number', 'object']).toContain(typeof explain.goalsScored);
      expect(['number', 'object']).toContain(typeof explain.goalsScoredPoints);
    });

    test('should have valid point values', async () => {
      const db = await getDb();
      const explains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      explains.forEach((explain) => {
        // Points should be within reasonable ranges
        if (explain.goalsScored !== null) {
          expect(explain.goalsScored).toBeGreaterThanOrEqual(0);
          expect(explain.goalsScored).toBeLessThanOrEqual(10); // Reasonable max
        }

        if (explain.assists !== null) {
          expect(explain.assists).toBeGreaterThanOrEqual(0);
          expect(explain.assists).toBeLessThanOrEqual(10);
        }

        if (explain.bonus !== null) {
          expect(explain.bonus).toBeGreaterThanOrEqual(0);
          expect(explain.bonus).toBeLessThanOrEqual(3);
        }

        // Yellow cards should be 0 or positive
        if (explain.yellowCards !== null) {
          expect(explain.yellowCards).toBeGreaterThanOrEqual(0);
        }

        // Red cards should be 0 or 1
        if (explain.redCards !== null) {
          expect(explain.redCards).toBeGreaterThanOrEqual(0);
          expect(explain.redCards).toBeLessThanOrEqual(1);
        }
      });
    });

    test('should have valid minutes data', async () => {
      const db = await getDb();
      const explains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      explains.forEach((explain) => {
        if (explain.minutes !== null) {
          expect(explain.minutes).toBeGreaterThanOrEqual(0);
          expect(explain.minutes).toBeLessThanOrEqual(120); // Including extra time
        }
      });
    });
  });

  describe('Cache Operations', () => {
    test('should cache data after sync', async () => {
      const result = await syncEventLiveExplain(testEventId);
      const cachedData = await eventLiveExplainCache.getByEventId(testEventId);

      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBe(result.count);
    });

    test('should clear cache for specific event', async () => {
      // Ensure cache is populated
      await syncEventLiveExplain(testEventId);
      let cachedData = await eventLiveExplainCache.getByEventId(testEventId);
      expect(cachedData).not.toBeNull();

      // Clear cache
      await eventLiveExplainCache.clearByEventId(testEventId);

      // Verify cache is cleared
      cachedData = await eventLiveExplainCache.getByEventId(testEventId);
      expect(cachedData).toBeNull();
    });

    test('should retrieve cached data correctly', async () => {
      // Sync to populate cache
      const result = await syncEventLiveExplain(testEventId);

      // Get from cache
      const cachedData = await eventLiveExplainCache.getByEventId(testEventId);

      expect(cachedData).not.toBeNull();
      expect(Array.isArray(cachedData)).toBe(true);
      expect(cachedData?.length).toBe(result.count);

      // Verify data structure
      if (cachedData && cachedData.length > 0) {
        const firstExplain = cachedData[0];
        expect(firstExplain.eventId).toBe(testEventId);
        expect(typeof firstExplain.elementId).toBe('number');
      }
    });
  });

  describe('Query Performance', () => {
    test('should efficiently query by event ID', async () => {
      const startTime = performance.now();
      const db = await getDb();
      await db.select().from(eventLiveExplains).where(eq(eventLiveExplains.eventId, testEventId));
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });

    test('should efficiently retrieve from cache', async () => {
      // Ensure cache is populated
      await syncEventLiveExplain(testEventId);

      const startTime = performance.now();
      await eventLiveExplainCache.getByEventId(testEventId);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(500); // Cache should be faster than 500ms
    });
  });

  describe('Error Handling', () => {
    test('should handle sync for current event without explicit ID', async () => {
      const result = await syncEventLiveExplain();

      expect(result).toBeDefined();
      expect(result.count).toBeGreaterThan(0);
      expect(result.eventId).toBeTypeOf('number');
    });

    test('should return null for non-existent event in cache', async () => {
      const nonExistentEventId = 99999;
      const cachedData = await eventLiveExplainCache.getByEventId(nonExistentEventId);

      expect(cachedData).toBeNull();
    });

    test('should handle invalid event ID gracefully', async () => {
      const invalidEventId = -1;

      await expect(syncEventLiveExplain(invalidEventId)).rejects.toThrow();
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistency after multiple syncs', async () => {
      const sync1 = await syncEventLiveExplain(testEventId);
      const sync2 = await syncEventLiveExplain(testEventId);

      expect(sync2.count).toBe(sync1.count);
    });

    test('should have matching element IDs across DB and cache', async () => {
      await syncEventLiveExplain(testEventId);

      const db = await getDb();
      const dbExplains = await db
        .select()
        .from(eventLiveExplains)
        .where(eq(eventLiveExplains.eventId, testEventId));

      const cachedExplains = await eventLiveExplainCache.getByEventId(testEventId);

      expect(cachedExplains).not.toBeNull();

      const dbElementIds = new Set(dbExplains.map((e) => e.elementId));
      const cacheElementIds = new Set(cachedExplains?.map((e) => e.elementId) || []);

      expect(cacheElementIds.size).toBe(dbElementIds.size);
      dbElementIds.forEach((id) => {
        expect(cacheElementIds.has(id)).toBe(true);
      });
    });
  });
});
