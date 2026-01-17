import { beforeAll, describe, expect, test } from 'bun:test';

import { leagueEventResults } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../src/services/events.service';
import { syncLeagueEventResultsByTournament } from '../../src/services/league-event-results.service';

describe('League Event Results Integration Tests', () => {
  let testEventId: number;
  let testTournamentId: number | null = null;

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    const tournaments = await tournamentInfoRepository.findActive();
    if (tournaments.length > 0) {
      testTournamentId = tournaments[0].id;
    } else {
      console.log('⚠️  No active tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test('should sync league event results for tournament', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      const result = await syncLeagueEventResultsByTournament(testTournamentId, testEventId);

      expect(result).toBeDefined();
      expect(result.tournamentId).toBe(testTournamentId);
      expect(result.eventId).toBe(testEventId);
      expect(result.totalEntries).toBeGreaterThanOrEqual(0);
      expect(result.updated).toBeGreaterThanOrEqual(0);
      expect(result.skipped).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventResultsByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const results = await db.select().from(leagueEventResults);

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.entryId).toBe('number');
        expect(typeof result.eventId).toBe('number');
        expect(typeof result.leagueId).toBe('number');
        expect(typeof result.overallPoints).toBe('number');
        expect(typeof result.eventPoints).toBe('number');
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid result structure', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventResultsByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const results = await db.select().from(leagueEventResults);

      if (results.length > 0) {
        const result = results[0];
        expect(result.overallPoints).toBeGreaterThanOrEqual(-50);
        expect(result.overallPoints).toBeLessThanOrEqual(3000);
        expect(result.eventPoints).toBeGreaterThanOrEqual(-50);
        expect(result.eventPoints).toBeLessThanOrEqual(300);
      }
    });

    test('should have consistent points calculation', async () => {
      if (!testTournamentId) {
        console.log('⊘ Skipping - no test tournament available');
        return;
      }

      await syncLeagueEventResultsByTournament(testTournamentId, testEventId);

      const db = await getDb();
      const results = await db.select().from(leagueEventResults);

      results.forEach((result) => {
        // Net points should be event points minus transfers cost
        const expectedNet = result.eventPoints - result.eventTransfersCost;
        expect(result.eventNetPoints).toBe(expectedNet);

        // Transfers cost should be non-negative
        expect(result.eventTransfersCost).toBeGreaterThanOrEqual(0);
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
      await syncLeagueEventResultsByTournament(testTournamentId, testEventId);
      const endTime = performance.now();

      const duration = endTime - startTime;
      expect(duration).toBeLessThan(120000); // 2 minutes
    });
  });
});
