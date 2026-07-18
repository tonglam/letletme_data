import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { getDb } from '../../src/db/singleton';
import { entryEventPicks } from '../../src/db/schemas/index.schema';
import { syncTournamentEventPicks } from '../../src/services/tournament-event-picks.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)('Tournament Event Picks Integration Tests', () => {
  const seed = resolved.seed;
  const testEventId = seed?.currentEvent?.id ?? -1;
  let syncedResult: Awaited<ReturnType<typeof syncTournamentEventPicks>>;

  beforeAll(async () => {
    syncedResult = await syncTournamentEventPicks(testEventId);
  });

  describe('Sync Integration', () => {
    test('should sync tournament event picks', async () => {
      expect(syncedResult).toBeDefined();
      expect(syncedResult.eventId).toBe(testEventId);
      expect(syncedResult.totalEntries).toBeGreaterThanOrEqual(0);
      expect(syncedResult.synced).toBeGreaterThanOrEqual(0);
    });

    test('should store picks in database', async () => {
      const db = await getDb();
      const picks = await db
        .select()
        .from(entryEventPicks)
        .where(eq(entryEventPicks.eventId, testEventId));

      expect(picks.length).toBeGreaterThanOrEqual(0);

      if (picks.length > 0) {
        const pick = picks[0];
        expect(typeof pick.entryId).toBe('number');
        expect(typeof pick.eventId).toBe('number');
        expect(pick.picks).toBeDefined();
        // picks is JSONB array, check first element
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as {
            element: number;
            position: number;
          };
          expect(typeof firstPick.element).toBe('number');
          expect(typeof firstPick.position).toBe('number');
        }
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid pick structure', async () => {
      const db = await getDb();
      const picks = await db
        .select()
        .from(entryEventPicks)
        .where(eq(entryEventPicks.eventId, testEventId));

      if (picks.length > 0) {
        const pick = picks[0];
        expect(pick.picks).toBeDefined();
        // picks is JSONB array of pick objects
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as {
            element: number;
            position: number;
          };
          expect(firstPick.position).toBeGreaterThanOrEqual(1);
          expect(firstPick.position).toBeLessThanOrEqual(15); // 11 starting + 4 bench
          expect(firstPick.element).toBeGreaterThan(0);
        }
      }
    });

    test('should have 15 picks per entry', async () => {
      const db = await getDb();
      const picksRows = await db
        .select()
        .from(entryEventPicks)
        .where(eq(entryEventPicks.eventId, testEventId));

      // Each row contains all 15 picks for one entry-event combination in JSONB
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          expect(row.picks.length).toBe(15);
        }
      });
    });
  });
});
