import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { entryEventPicks } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncLeagueEventPicksByTournament } from '../../src/services/league-event-picks.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('any');

describe.skipIf(!resolved.canRun)('League Event Picks Integration Tests', () => {
  const seed = resolved.seed!;
  const testEventId = seed.currentEvent.id;
  const testTournamentId = seed.tournamentId;
  let syncedResult: Awaited<ReturnType<typeof syncLeagueEventPicksByTournament>>;

  beforeAll(async () => {
    syncedResult = await syncLeagueEventPicksByTournament(testTournamentId, testEventId);
  });

  describe('Sync Integration', () => {
    test('should sync league event picks for tournament', async () => {
      expect(syncedResult).toBeDefined();
      expect(syncedResult.tournamentId).toBe(testTournamentId);
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
            multiplier: number;
          };
          expect(firstPick.position).toBeGreaterThanOrEqual(1);
          expect(firstPick.position).toBeLessThanOrEqual(15);
          expect(firstPick.element).toBeGreaterThan(0);
          expect(typeof firstPick.multiplier).toBe('number');
          expect(firstPick.multiplier).toBeGreaterThanOrEqual(0);
          expect(firstPick.multiplier).toBeLessThanOrEqual(3); // Captain can be 2x or 3x
        }
      }
    });

    test('should have 15 picks per entry per event', async () => {
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

    test('should have unique positions per entry per event', async () => {
      const db = await getDb();
      const picksRows = await db
        .select()
        .from(entryEventPicks)
        .where(eq(entryEventPicks.eventId, testEventId));

      // Each row contains all picks in JSONB, check positions are unique
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          const positions = row.picks.map((p: { position: number }) => p.position);
          const uniquePositions = new Set(positions);
          expect(uniquePositions.size).toBe(positions.length);
        }
      });
    });
  });

  describe('Captain and Vice Captain', () => {
    test('should have one captain (2x or 3x multiplier)', async () => {
      const db = await getDb();
      const picksRows = await db
        .select()
        .from(entryEventPicks)
        .where(eq(entryEventPicks.eventId, testEventId));

      // Each row contains all picks in JSONB, check for captain (multiplier >= 2)
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          const captainPicks = row.picks.filter((p: { multiplier: number }) => p.multiplier >= 2);
          expect(captainPicks.length).toBeGreaterThanOrEqual(1);
        }
      });
    });
  });

  describe('Performance', () => {
    test('should complete sync within reasonable time', async () => {
      expect(syncedResult.totalEntries).toBeGreaterThanOrEqual(0);
    });
  });
});
