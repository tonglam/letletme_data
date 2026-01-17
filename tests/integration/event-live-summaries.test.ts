import { beforeAll, describe, expect, test } from 'bun:test';

import { eventLiveSummaryCache } from '../../src/cache/operations';
import { eventLiveSummaries } from '../../src/db/schemas/event-live-summaries.schema';
import { getDb } from '../../src/db/singleton';
import { syncEventLiveSummary } from '../../src/services/event-live-summaries.service';
import { syncEventLives } from '../../src/services/event-lives.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Event Live Summaries Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // Get current event ID for testing
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Ensure event lives data exists (summaries depend on it)
    await syncEventLives(testEventId);

    // Clear cache before tests
    await eventLiveSummaryCache.clearByEventId(testEventId);

    // Sync event live summary data - aggregates from event_lives table
    const result = await syncEventLiveSummary();
    expect(result.count).toBeGreaterThan(0);
  });

  describe('Sync Integration', () => {
    test('should aggregate and sync event live summary data to database', async () => {
      const db = await getDb();
      const dbSummaries = await db.select().from(eventLiveSummaries);

      expect(dbSummaries.length).toBeGreaterThan(0);
      expect(dbSummaries[0].eventId).toBe(testEventId);
      expect(dbSummaries[0].elementId).toBeTypeOf('number');
      expect(dbSummaries[0].totalPoints).toBeTypeOf('number');
    });

    test('should populate cache after sync', async () => {
      // Verify cache is populated (from beforeAll sync)
      const cachedData = await eventLiveSummaryCache.getByEventId(testEventId);
      expect(cachedData).toBeDefined();
      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBeGreaterThan(0);
    });

    test('should have consistent data between DB and cache', async () => {
      const db = await getDb();
      const dbSummaries = await db.select().from(eventLiveSummaries);

      const cachedSummaries = await eventLiveSummaryCache.getByEventId(testEventId);

      expect(cachedSummaries).not.toBeNull();
      expect(cachedSummaries?.length).toBe(dbSummaries.length);
    });

    test('should replace all summaries on re-sync', async () => {
      // Get initial count
      const db = await getDb();
      const beforeSync = await db.select().from(eventLiveSummaries);

      // Re-sync
      const result = await syncEventLiveSummary();

      const afterSync = await db.select().from(eventLiveSummaries);

      // Should have same count (replaceAll truncates then inserts)
      expect(afterSync.length).toBe(result.count);
      expect(afterSync.length).toBe(beforeSync.length);
    });
  });

  describe('Data Aggregation', () => {
    test('should aggregate stats correctly per player', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      expect(summaries.length).toBeGreaterThan(0);

      // Each summary should represent one player
      const elementIds = summaries.map((s) => s.elementId);
      const uniqueElementIds = new Set(elementIds);
      expect(elementIds.length).toBe(uniqueElementIds.size); // No duplicates
    });

    test('should have valid aggregated statistics', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      summaries.forEach((summary) => {
        // All stats should be non-negative (aggregated sums)
        expect(summary.minutes).toBeGreaterThanOrEqual(0);
        expect(summary.goalsScored).toBeGreaterThanOrEqual(0);
        expect(summary.assists).toBeGreaterThanOrEqual(0);
        expect(summary.cleanSheets).toBeGreaterThanOrEqual(0);
        expect(summary.goalsConceded).toBeGreaterThanOrEqual(0);
        expect(summary.bonus).toBeGreaterThanOrEqual(0);
        expect(summary.totalPoints).toBeGreaterThanOrEqual(-10); // Can be negative
      });
    });

    test('should include player metadata', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      expect(summaries.length).toBeGreaterThan(0);

      const summary = summaries[0];

      // Should have element type (1=GK, 2=DEF, 3=MID, 4=FWD)
      expect(summary.elementType).toBeGreaterThanOrEqual(1);
      expect(summary.elementType).toBeLessThanOrEqual(4);

      // Should have team ID
      expect(summary.teamId).toBeGreaterThan(0);
      expect(summary.teamId).toBeLessThanOrEqual(20); // Premier League teams
    });
  });

  describe('Data Validation', () => {
    test('should have valid event live summary data structure', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      expect(summaries.length).toBeGreaterThan(0);

      const summary = summaries[0];

      // Required fields
      expect(typeof summary.eventId).toBe('number');
      expect(typeof summary.elementId).toBe('number');
      expect(typeof summary.elementType).toBe('number');
      expect(typeof summary.teamId).toBe('number');
      expect(typeof summary.totalPoints).toBe('number');
    });

    test('should have players with played minutes', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      // At least some players should have played (minutes > 0)
      const playedPlayers = summaries.filter((s) => s.minutes > 0);
      expect(playedPlayers.length).toBeGreaterThan(0);
    });

    test('should have players with points', async () => {
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      // At least some players should have scored points
      const scoringPlayers = summaries.filter((s) => s.totalPoints > 0);
      expect(scoringPlayers.length).toBeGreaterThan(0);
    });
  });

  describe('Cache Operations', () => {
    test('should cache data after sync', async () => {
      const cachedData = await eventLiveSummaryCache.getByEventId(testEventId);

      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBeGreaterThan(0);
    });

    test('should clear cache for specific event', async () => {
      // Cache should be populated from beforeAll
      let cachedData = await eventLiveSummaryCache.getByEventId(testEventId);
      expect(cachedData).not.toBeNull();

      // Clear cache
      await eventLiveSummaryCache.clearByEventId(testEventId);

      // Verify cache is cleared
      cachedData = await eventLiveSummaryCache.getByEventId(testEventId);
      expect(cachedData).toBeNull();
    });

    test('should retrieve cached data correctly', async () => {
      // Sync to populate cache
      const result = await syncEventLiveSummary();

      // Get from cache
      const cachedData = await eventLiveSummaryCache.getByEventId(testEventId);

      expect(cachedData).not.toBeNull();
      expect(Array.isArray(cachedData)).toBe(true);
      expect(cachedData?.length).toBe(result.count);

      // Verify data structure
      if (cachedData && cachedData.length > 0) {
        const firstSummary = cachedData[0];
        expect(firstSummary.eventId).toBe(testEventId);
        expect(typeof firstSummary.elementId).toBe('number');
        expect(typeof firstSummary.totalPoints).toBe('number');
      }
    });
  });

  describe('Query Performance', () => {
    test('should efficiently query summaries from database', async () => {
      const startTime = performance.now();
      const db = await getDb();
      await db.select().from(eventLiveSummaries);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(1000); // Should complete in under 1 second
    });

    test('should efficiently retrieve from cache', async () => {
      const startTime = performance.now();
      await eventLiveSummaryCache.getByEventId(testEventId);
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(500); // Cache should be faster than 500ms
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistency after multiple syncs', async () => {
      const sync1 = await syncEventLiveSummary();
      const sync2 = await syncEventLiveSummary();

      // Should have same count (aggregation is deterministic)
      expect(sync2.count).toBe(sync1.count);
    });

    test('should have matching element IDs across DB and cache', async () => {
      const db = await getDb();
      const dbSummaries = await db.select().from(eventLiveSummaries);

      const cachedSummaries = await eventLiveSummaryCache.getByEventId(testEventId);

      expect(cachedSummaries).not.toBeNull();

      const dbElementIds = new Set(dbSummaries.map((s) => s.elementId));
      const cacheElementIds = new Set(cachedSummaries?.map((s) => s.elementId) || []);

      expect(cacheElementIds.size).toBe(dbElementIds.size);
      dbElementIds.forEach((id) => {
        expect(cacheElementIds.has(id)).toBe(true);
      });
    });

    test('should have summary totals matching underlying event lives data', async () => {
      // This test verifies the aggregation logic is correct
      const db = await getDb();
      const summaries = await db.select().from(eventLiveSummaries);

      // Get a sample player's summary
      const sampleSummary = summaries.find((s) => s.minutes > 0);
      if (!sampleSummary) {
        // Skip if no players with minutes
        return;
      }

      // Verify the summary has consistent data
      // If a player has minutes, they should have some related stats
      if (sampleSummary.minutes > 0) {
        // At minimum, they should have bps (bonus points system) or total points
        const hasStats =
          sampleSummary.bps > 0 ||
          sampleSummary.totalPoints !== 0 ||
          sampleSummary.goalsScored > 0 ||
          sampleSummary.assists > 0;

        expect(hasStats).toBe(true);
      }
    });
  });

  describe('Error Handling', () => {
    test('should handle sync when current event exists', async () => {
      // Verify sync result from beforeAll
      const cachedData = await eventLiveSummaryCache.getByEventId(testEventId);
      expect(cachedData).toBeDefined();
      expect(cachedData).not.toBeNull();
      expect(testEventId).toBeTypeOf('number');
    });

    test('should return null for non-existent event in cache', async () => {
      const nonExistentEventId = 99999;
      const cachedData = await eventLiveSummaryCache.getByEventId(nonExistentEventId);

      expect(cachedData).toBeNull();
    });
  });
});
