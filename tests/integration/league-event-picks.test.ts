import { beforeAll, describe, expect, test } from 'bun:test';

import { entryEventPicks } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../src/services/events.service';
import { syncLeagueEventPicksByTournament } from '../../src/services/league-event-picks.service';

describe('League Event Picks Integration Tests', () => {
  let testEventId: number;
  let testTournamentId: number | null = null;

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Get a tournament for testing
    const tournaments = await tournamentInfoRepository.findActive();
    if (tournaments.length > 0) {
      testTournamentId = tournaments[0].id;
    } else {
      console.log('⚠️  No active tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test('should sync league event picks for tournament', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      const result = await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      expect(result).toBeDefined();
      expect(result.tournamentId).toBe(testTournamentId);
      expect(result.eventId).toBe(testEventId);
      expect(result.totalEntries).toBeGreaterThanOrEqual(0);
      expect(result.synced).toBeGreaterThanOrEqual(0);
    });

    test('should store picks in database', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const picks = await db.select().from(entryEventPicks);

      expect(picks.length).toBeGreaterThanOrEqual(0);

      if (picks.length > 0) {
        const pick = picks[0];
        expect(typeof pick.entryId).toBe('number');
        expect(typeof pick.eventId).toBe('number');
        expect(pick.picks).toBeDefined();
        // picks is JSONB array, check first element
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as any;
          expect(typeof firstPick.element).toBe('number');
          expect(typeof firstPick.position).toBe('number');
        }
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid pick structure', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const picks = await db.select().from(entryEventPicks);

      if (picks.length > 0) {
        const pick = picks[0];
        expect(pick.picks).toBeDefined();
        // picks is JSONB array of pick objects
        if (Array.isArray(pick.picks) && pick.picks.length > 0) {
          const firstPick = pick.picks[0] as any;
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
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const picksRows = await db.select().from(entryEventPicks);

      // Each row contains all 15 picks for one entry-event combination in JSONB
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          expect(row.picks.length).toBe(15);
        }
      });
    });

    test('should have unique positions per entry per event', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const picksRows = await db.select().from(entryEventPicks);

      // Each row contains all picks in JSONB, check positions are unique
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          const positions = row.picks.map((p: any) => p.position);
          const uniquePositions = new Set(positions);
          expect(uniquePositions.size).toBe(positions.length);
        }
      });
    });
  });

  describe('Captain and Vice Captain', () => {
    test('should have one captain (2x or 3x multiplier)', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const picksRows = await db.select().from(entryEventPicks);

      // Each row contains all picks in JSONB, check for captain (multiplier >= 2)
      picksRows.forEach((row) => {
        if (Array.isArray(row.picks)) {
          const captainPicks = row.picks.filter((p: any) => p.multiplier >= 2);
          expect(captainPicks.length).toBeGreaterThanOrEqual(1);
        }
      });
    });
  });

  describe('Performance', () => {
    test('should complete sync within reasonable time', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      const startTime = performance.now();
      await syncLeagueEventPicksByTournament(testTournamentId, testEventId);
      const endTime = performance.now();

      const duration = endTime - startTime;
      expect(duration).toBeLessThan(120000); // 2 minutes
    });
  });
});
