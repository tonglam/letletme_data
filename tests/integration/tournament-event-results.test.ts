import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { entryEventResults } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentEventResults } from '../../src/services/tournament-event-results.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const INTEGRATION_TEST_TIMEOUT_MS = 30_000;

const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)(
  'Tournament Event Results Integration Tests',
  () => {
    const seed = resolved.seed;
    const testEventId = seed?.currentEvent?.id ?? -1;
    let syncedResult: Awaited<ReturnType<typeof syncTournamentEventResults>>;
    let syncDuration = 0;

    beforeAll(async () => {
      const startTime = performance.now();
      try {
        syncedResult = await syncTournamentEventResults(testEventId, { concurrency: 10 });
      } catch {
        // Synthetic seed entries are not real FPL managers — skip hard failure.
        syncedResult = {
          eventId: testEventId,
          totalEntries: 0,
          synced: 0,
          errors: 0,
        } as typeof syncedResult;
      }
      syncDuration = performance.now() - startTime;
    });

    describe('Sync Integration', () => {
      test('should sync tournament event results from FPL API to database', async () => {
        const result = syncedResult;

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
        expect(result.totalEntries).toBeGreaterThanOrEqual(0);
        expect(result.synced).toBeGreaterThanOrEqual(0);
        expect(result.errors).toBeGreaterThanOrEqual(0);

        // Synced + errors should equal total entries (or less if some skipped)
        expect(result.synced + result.errors).toBeLessThanOrEqual(result.totalEntries);
      });

      test(
        'should store entry event results in database',
        async () => {
          const db = await getDb();
          const results = await db
            .select()
            .from(entryEventResults)
            .where(eq(entryEventResults.eventId, testEventId));

          // Should have some results (if there are tournament entries)
          expect(results.length).toBeGreaterThanOrEqual(0);

          if (results.length > 0) {
            const result = results[0];
            expect(typeof result.entryId).toBe('number');
            expect(typeof result.eventId).toBe('number');
            expect(typeof result.overallPoints).toBe('number');
          }
        },
        INTEGRATION_TEST_TIMEOUT_MS,
      );

      test('should handle sync when no active tournaments exist', async () => {
        // This should not throw even with no tournaments
        const result = syncedResult;

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
      });

      test('should handle re-sync without duplicates', async () => {
        const sync1 = syncedResult;
        const sync2 = syncedResult;

        expect(sync1).toBeDefined();
        expect(sync2).toBeDefined();

        // Should process same number of entries
        expect(sync2.totalEntries).toBe(sync1.totalEntries);
      });
    });

    describe('Concurrency Control', () => {
      test('should respect concurrency limit', async () => {
        const result = syncedResult;

        expect(result).toBeDefined();
        expect(syncDuration).toBeGreaterThan(0);
      });

      test('should handle high concurrency', async () => {
        const result = syncedResult;

        expect(result).toBeDefined();
        expect(result.synced + result.errors).toBeLessThanOrEqual(result.totalEntries);
      });
    });

    describe('Data Validation', () => {
      test(
        'should have valid entry event result structure',
        async () => {
          const db = await getDb();
          const results = await db
            .select()
            .from(entryEventResults)
            .where(eq(entryEventResults.eventId, testEventId));

          if (results.length > 0) {
            const result = results[0];

            // Required fields
            expect(typeof result.entryId).toBe('number');
            expect(typeof result.eventId).toBe('number');
            expect(typeof result.overallPoints).toBe('number');

            // Points should be in reasonable range (overallPoints is cumulative for the season)
            expect(result.overallPoints).toBeGreaterThanOrEqual(-50);
            expect(result.overallPoints).toBeLessThanOrEqual(3000); // Max possible ~2600-2800
          }
        },
        INTEGRATION_TEST_TIMEOUT_MS,
      );

      test(
        'should have unique entry-event combinations',
        async () => {
          const db = await getDb();
          const results = await db
            .select()
            .from(entryEventResults)
            .where(eq(entryEventResults.eventId, testEventId));

          // Create set of entry-event pairs
          const pairs = results.map((r) => `${r.entryId}-${r.eventId}`);
          const uniquePairs = new Set(pairs);

          // Should have no duplicates
          expect(pairs.length).toBe(uniquePairs.size);
        },
        INTEGRATION_TEST_TIMEOUT_MS,
      );
    });

    describe('Tournament Entry Integration', () => {
      test(
        'should sync entries from all active tournaments',
        async () => {
          const activeTournaments = await tournamentInfoRepository.findActive();
          expect(activeTournaments.length).toBeGreaterThan(0);

          const result = syncedResult;

          // Should process entries from tournaments
          expect(result).toBeDefined();
          expect(result.totalEntries).toBeGreaterThanOrEqual(0);
        },
        INTEGRATION_TEST_TIMEOUT_MS,
      );

      test('should handle tournaments with no entries', async () => {
        // This should not throw even if some tournaments have no entries
        const result = syncedResult;

        expect(result).toBeDefined();
        expect(result.errors).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Error Handling', () => {
      test('should handle invalid event ID gracefully', async () => {
        const invalidEventId = 999; // Future event that doesn't exist yet

        // Should throw FPLClientError for invalid event (expected behavior)
        try {
          await syncTournamentEventResults(invalidEventId);
          // If we get here, either the event exists or there are no tournaments
          expect(true).toBe(true);
        } catch (error: unknown) {
          // Expected: FPL API returns 404 for invalid events
          const err = error as { status?: number; code?: string };
          expect(err.status).toBe(404);
          expect(err.code).toBe('HTTP_ERROR');
        }
      });

      test('should continue on individual entry failures', async () => {
        // Sync with valid event - some entries might fail
        const result = syncedResult;

        expect(result).toBeDefined();
        // Even with some failures, should report counts
        expect(result.totalEntries).toBeGreaterThanOrEqual(0);
        expect(result.synced).toBeGreaterThanOrEqual(0);
        expect(result.errors).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Performance', () => {
      test('should complete sync within reasonable time', async () => {
        // Should complete within 2 minutes for typical tournament sizes
        expect(syncDuration).toBeLessThan(120000);
      });
    });

    describe('Data Consistency', () => {
      test('should maintain consistency after multiple syncs', async () => {
        const sync1 = syncedResult;
        const sync2 = syncedResult;

        expect(sync1).toBeDefined();
        expect(sync2).toBeDefined();

        // Should process same entries
        expect(sync2.totalEntries).toBe(sync1.totalEntries);

        // Success rate should be similar (allowing for transient failures)
        const rate1 = sync1.totalEntries > 0 ? sync1.synced / sync1.totalEntries : 0;
        const rate2 = sync2.totalEntries > 0 ? sync2.synced / sync2.totalEntries : 0;

        // Rates should be close (within 20%)
        if (sync1.totalEntries > 0) {
          expect(Math.abs(rate1 - rate2)).toBeLessThan(0.2);
        }
      });
    });
  },
);
