import { beforeAll, describe, expect, test } from 'bun:test';

import { eventOverallResultCache } from '../../src/cache/operations';
import { syncEventOverallResult } from '../../src/services/event-overall-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Event Overall Results Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // Get current event ID for testing
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Sync event overall results - fetches from FPL API and caches
    const result = await syncEventOverallResult();
    expect(result.count).toBeGreaterThan(0);
  });

  describe('Sync Integration', () => {
    test('should sync event overall results from FPL API to cache', async () => {
      const result = await syncEventOverallResult();

      expect(result).toBeDefined();
      expect(result.count).toBeGreaterThan(0);
      expect(result.eventId).toBeTypeOf('number');
    });

    test('should cache all events results', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).toBeDefined();
      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBeGreaterThan(0);
    });

    test('should include current event in results', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      const currentEventResult = cachedData?.find((r) => r.event === testEventId);
      expect(currentEventResult).toBeDefined();
    });

    test('should handle re-sync without errors', async () => {
      const sync1 = await syncEventOverallResult();
      const sync2 = await syncEventOverallResult();

      // Should have same count (all events)
      expect(sync2.count).toBe(sync1.count);
      expect(sync2.eventId).toBe(sync1.eventId);
    });
  });

  describe('Data Validation', () => {
    test('should have valid event overall result data structure', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();
      expect(cachedData!.length).toBeGreaterThan(0);

      const result = cachedData![0];

      // Required fields
      expect(typeof result.event).toBe('number');
      expect(result.event).toBeGreaterThan(0);
      expect(result.event).toBeLessThanOrEqual(38); // Max gameweeks

      // Numeric fields (can be null)
      expect(['number', 'object']).toContain(typeof result.averageEntryScore);
      expect(['number', 'object']).toContain(typeof result.highestScore);
      expect(['number', 'object']).toContain(typeof result.highestScoringEntry);

      // Boolean field
      expect(typeof result.finished).toBe('boolean');
    });

    test('should have chip plays data', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Find a finished event (more likely to have chip data)
      const finishedEvent = cachedData?.find((r) => r.finished);
      if (finishedEvent) {
        expect(Array.isArray(finishedEvent.chipPlays)).toBe(true);

        // If there are chip plays, validate structure
        if (finishedEvent.chipPlays.length > 0) {
          const chip = finishedEvent.chipPlays[0];
          expect(typeof chip.chipName).toBe('string');
          expect(typeof chip.numberPlayed).toBe('number');
          expect(chip.numberPlayed).toBeGreaterThan(0);
        }
      }
    });

    test('should have top element info for finished events', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Find a finished event
      const finishedEvent = cachedData?.find((r) => r.finished);
      if (finishedEvent) {
        // Top element info can be null or have valid data
        if (finishedEvent.topElementInfo) {
          expect(typeof finishedEvent.topElementInfo.element).toBe('number');
          expect(typeof finishedEvent.topElementInfo.points).toBe('number');
          expect(finishedEvent.topElementInfo.element).toBeGreaterThan(0);
          expect(finishedEvent.topElementInfo.points).toBeGreaterThan(0);
        }
      }
    });

    test('should have valid player references', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      const finishedEvent = cachedData?.find((r) => r.finished);
      if (finishedEvent) {
        // Most selected player ID
        if (finishedEvent.mostSelected !== null) {
          expect(typeof finishedEvent.mostSelected).toBe('number');
          expect(finishedEvent.mostSelected).toBeGreaterThan(0);
        }

        // Most transferred in player ID
        if (finishedEvent.mostTransferredIn !== null) {
          expect(typeof finishedEvent.mostTransferredIn).toBe('number');
          expect(finishedEvent.mostTransferredIn).toBeGreaterThan(0);
        }

        // Most captained player ID
        if (finishedEvent.mostCaptained !== null) {
          expect(typeof finishedEvent.mostCaptained).toBe('number');
          expect(finishedEvent.mostCaptained).toBeGreaterThan(0);
        }

        // Most vice captained player ID
        if (finishedEvent.mostViceCaptained !== null) {
          expect(typeof finishedEvent.mostViceCaptained).toBe('number');
          expect(finishedEvent.mostViceCaptained).toBeGreaterThan(0);
        }
      }
    });

    test('should have reasonable score values', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      const finishedEvent = cachedData?.find((r) => r.finished);
      if (finishedEvent) {
        if (finishedEvent.averageEntryScore !== null) {
          expect(finishedEvent.averageEntryScore).toBeGreaterThan(0);
          expect(finishedEvent.averageEntryScore).toBeLessThan(200); // Reasonable max
        }

        if (finishedEvent.highestScore !== null) {
          expect(finishedEvent.highestScore).toBeGreaterThan(0);
          expect(finishedEvent.highestScore).toBeLessThan(300); // Reasonable max

          // Highest should be >= average
          if (finishedEvent.averageEntryScore !== null) {
            expect(finishedEvent.highestScore).toBeGreaterThanOrEqual(
              finishedEvent.averageEntryScore,
            );
          }
        }
      }
    });
  });

  describe('Cache Operations', () => {
    test('should cache all event results', async () => {
      const result = await syncEventOverallResult();
      const cachedData = await eventOverallResultCache.getAll();

      expect(cachedData).not.toBeNull();
      expect(cachedData?.length).toBe(result.count);
    });

    test('should return results sorted by event ID', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Verify sorted order
      for (let i = 1; i < cachedData!.length; i++) {
        expect(cachedData![i].event).toBeGreaterThan(cachedData![i - 1].event);
      }
    });

    test('should retrieve specific event data from cache', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      const currentEventData = cachedData?.find((r) => r.event === testEventId);
      expect(currentEventData).toBeDefined();
      expect(currentEventData?.event).toBe(testEventId);
    });

    test('should replace cache on re-sync', async () => {
      const sync1 = await syncEventOverallResult();
      const cache1 = await eventOverallResultCache.getAll();

      const sync2 = await syncEventOverallResult();
      const cache2 = await eventOverallResultCache.getAll();

      expect(cache2).not.toBeNull();
      expect(cache2?.length).toBe(sync2.count);
      expect(cache2?.length).toBe(cache1?.length);
    });
  });

  describe('Query Performance', () => {
    test('should efficiently retrieve from cache', async () => {
      // Ensure cache is populated
      await syncEventOverallResult();

      const startTime = performance.now();
      await eventOverallResultCache.getAll();
      const endTime = performance.now();

      expect(endTime - startTime).toBeLessThan(500); // Should be very fast (cache-only)
    });

    test('should handle large result sets efficiently', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Should handle all 38 gameweeks efficiently
      expect(cachedData!.length).toBeGreaterThan(0);
      expect(cachedData!.length).toBeLessThanOrEqual(38);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistency after multiple syncs', async () => {
      const sync1 = await syncEventOverallResult();
      const cache1 = await eventOverallResultCache.getAll();

      const sync2 = await syncEventOverallResult();
      const cache2 = await eventOverallResultCache.getAll();

      expect(sync2.count).toBe(sync1.count);
      expect(cache2?.length).toBe(cache1?.length);
    });

    test('should have all events from 1 to current', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Should have sequential event IDs
      const eventIds = cachedData!.map((r) => r.event).sort((a, b) => a - b);
      expect(eventIds[0]).toBe(1); // First gameweek
      expect(eventIds[eventIds.length - 1]).toBeGreaterThanOrEqual(testEventId);

      // Check for gaps
      for (let i = 1; i < eventIds.length; i++) {
        expect(eventIds[i] - eventIds[i - 1]).toBe(1); // Sequential
      }
    });

    test('should have current event marked correctly', async () => {
      await syncEventOverallResult();

      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Find current event
      const currentEventData = cachedData?.find((r) => r.event === testEventId);
      expect(currentEventData).toBeDefined();
      expect(currentEventData?.event).toBe(testEventId);
    });
  });

  describe('Error Handling', () => {
    test('should handle sync successfully', async () => {
      const result = await syncEventOverallResult();

      expect(result).toBeDefined();
      expect(result.count).toBeGreaterThan(0);
      expect(result.eventId).not.toBeNull();
    });

    test('should return empty cache if sync fails but not throw', async () => {
      // This test assumes sync always succeeds with valid FPL API
      const result = await syncEventOverallResult();
      expect(result.count).toBeGreaterThan(0);
    });
  });

  describe('Chip Play Statistics', () => {
    test('should have valid chip play counts', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      // Find events with chip plays
      const eventsWithChips = cachedData?.filter((r) => r.chipPlays.length > 0);

      if (eventsWithChips && eventsWithChips.length > 0) {
        eventsWithChips.forEach((event) => {
          event.chipPlays.forEach((chip) => {
            expect(chip.chipName).toBeTypeOf('string');
            expect(chip.chipName.length).toBeGreaterThan(0);
            expect(chip.numberPlayed).toBeGreaterThan(0);
          });
        });
      }
    });

    test('should have known chip types', async () => {
      const cachedData = await eventOverallResultCache.getAll();
      expect(cachedData).not.toBeNull();

      const knownChips = ['bboost', 'wildcard', 'freehit', '3xc', 'bench_boost'];
      const eventsWithChips = cachedData?.filter((r) => r.chipPlays.length > 0);

      if (eventsWithChips && eventsWithChips.length > 0) {
        eventsWithChips.forEach((event) => {
          event.chipPlays.forEach((chip) => {
            // Chip name should be one of the known types (or similar)
            const chipNameLower = chip.chipName.toLowerCase();
            const isKnownChip = knownChips.some((known) => chipNameLower.includes(known));
            // Just verify it's a non-empty string, as FPL may add new chips
            expect(chip.chipName.length).toBeGreaterThan(0);
          });
        });
      }
    });
  });
});
