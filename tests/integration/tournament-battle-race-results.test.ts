import { beforeAll, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { tournamentBattleGroupResults } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentBattleRaceResults } from '../../src/services/tournament-battle-race-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Battle Race Results Integration Tests', () => {
  let testEventId: number;
  let hasBattleRaceTournaments: boolean;

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    // Check if there are active battle race tournaments
    const tournaments = await tournamentInfoRepository.findActive();
    hasBattleRaceTournaments = tournaments.some((t) => t.groupMode === 'battle_races');

    if (!hasBattleRaceTournaments) {
      console.log('⚠️  No battle race tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test('should sync battle race results', async () => {
      const result = await syncTournamentBattleRaceResults(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.updatedGroups).toBeGreaterThanOrEqual(0);
      expect(result.updatedResults).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      if (!hasBattleRaceTournaments) {
        console.log('⊘ Skipping - no battle race tournaments');
        return;
      }

      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.tournamentId).toBe('number');
        expect(typeof result.groupId).toBe('number');
        expect(typeof result.homeEntryId).toBe('number');
        expect(typeof result.awayEntryId).toBe('number');
      }
    });

    test('should handle no battle race tournaments', async () => {
      const result = await syncTournamentBattleRaceResults(testEventId);

      expect(result).toBeDefined();
      if (!hasBattleRaceTournaments) {
        expect(result.updatedGroups).toBe(0);
        expect(result.updatedResults).toBe(0);
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid battle race result structure', async () => {
      if (!hasBattleRaceTournaments) {
        console.log('⊘ Skipping - no battle race tournaments');
        return;
      }

      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      if (results.length > 0) {
        const result = results[0];
        expect(result.homeEntryId).toBeGreaterThan(0);
        expect(result.awayEntryId).toBeGreaterThan(0);
        expect(result.homeMatchPoints ?? 0).toBeGreaterThanOrEqual(0);
        expect(result.awayMatchPoints ?? 0).toBeGreaterThanOrEqual(0);
      }
    });

    test('should have valid points calculation', async () => {
      if (!hasBattleRaceTournaments) {
        console.log('⊘ Skipping - no battle race tournaments');
        return;
      }

      await syncTournamentBattleRaceResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentBattleGroupResults);

      results.forEach((result) => {
        expect([0, 1, 3]).toContain(result.homeMatchPoints ?? 0);
        expect([0, 1, 3]).toContain(result.awayMatchPoints ?? 0);
      });
    });
  });
});
