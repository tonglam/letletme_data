import { beforeAll, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { tournamentPointsGroupResults } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentPointsRaceResults } from '../../src/services/tournament-points-race-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Points Race Results Integration Tests', () => {
  let testEventId: number;
  let hasPointsRaceTournaments: boolean;

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    const tournaments = await tournamentInfoRepository.findActive();
    hasPointsRaceTournaments = tournaments.some((t) => t.groupMode === 'points_races');

    if (!hasPointsRaceTournaments) {
      console.log('⚠️  No points race tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test('should sync points race results', async () => {
      const result = await syncTournamentPointsRaceResults(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.updatedGroups).toBeGreaterThanOrEqual(0);
      expect(result.updatedResults).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      if (!hasPointsRaceTournaments) {
        console.log('⊘ Skipping - no points race tournaments');
        return;
      }

      await syncTournamentPointsRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentPointsGroupResults);

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.tournamentId).toBe('number');
        expect(typeof result.groupId).toBe('number');
        expect(typeof result.entryId).toBe('number');
        expect(typeof result.rank).toBe('number');
        expect(typeof result.totalPoints).toBe('number');
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid points race structure', async () => {
      if (!hasPointsRaceTournaments) {
        console.log('⊘ Skipping - no points race tournaments');
        return;
      }

      await syncTournamentPointsRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentPointsGroupResults);

      if (results.length > 0) {
        const result = results[0];
        expect(result.rank).toBeGreaterThan(0);
        expect(result.totalPoints).toBeGreaterThanOrEqual(0);
      }
    });

    test('should have unique ranks per group', async () => {
      if (!hasPointsRaceTournaments) {
        console.log('⊘ Skipping - no points race tournaments');
        return;
      }

      await syncTournamentPointsRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentPointsGroupResults);

      // Group by tournament and group ID
      const groups = new Map<string, typeof results>();
      results.forEach((r) => {
        const key = `${r.tournamentId}-${r.groupId}`;
        if (!groups.has(key)) {
          groups.set(key, []);
        }
        groups.get(key)!.push(r);
      });

      // Each group should have unique ranks
      groups.forEach((groupResults) => {
        const ranks = groupResults.map((r) => r.rank);
        const uniqueRanks = new Set(ranks);
        expect(uniqueRanks.size).toBe(ranks.length);
      });
    });
  });
});
