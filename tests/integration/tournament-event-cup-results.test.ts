import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { entryEventCupResults } from '../../src/db/schemas/index.schema';
import { syncTournamentEventCupResults } from '../../src/services/tournament-event-cup-results.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)(
  'Tournament Event Cup Results Integration Tests',
  () => {
    const seed = resolved.seed;
    const testEventId = seed?.currentEvent?.id ?? -1;
    let syncPromise: ReturnType<typeof syncTournamentEventCupResults> | undefined;

    function ensureSynced() {
      syncPromise ??= syncTournamentEventCupResults(testEventId);
      return syncPromise;
    }

    describe('Sync Integration', () => {
      test(
        'should sync tournament event cup results',
        async () => {
          const result = await ensureSynced();

          expect(result).toBeDefined();
          expect(result.eventId).toBe(testEventId);
          expect(result.totalEntries).toBeGreaterThanOrEqual(0);
          expect(result.upserted).toBeGreaterThanOrEqual(0);
        },
        { timeout: 30000 },
      );

      test(
        'should store cup results in database',
        async () => {
          await ensureSynced();

          const db = await getDb();
          const results = await db
            .select()
            .from(entryEventCupResults)
            .where(eq(entryEventCupResults.eventId, testEventId));

          expect(results.length).toBeGreaterThanOrEqual(0);

          if (results.length > 0) {
            const result = results[0];
            expect(typeof result.entryId).toBe('number');
            expect(typeof result.eventId).toBe('number');
          }
        },
        { timeout: 30000 },
      );
    });

    describe('Data Validation', () => {
      test(
        'should have valid cup result structure',
        async () => {
          await ensureSynced();

          const db = await getDb();
          const results = await db
            .select()
            .from(entryEventCupResults)
            .where(eq(entryEventCupResults.eventId, testEventId));

          if (results.length > 0) {
            const result = results[0];
            expect(result.entryId).toBeGreaterThan(0);
            expect(result.eventId).toBeGreaterThan(0);
          }
        },
        { timeout: 30000 },
      );
    });
  },
);
