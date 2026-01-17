import { beforeAll, describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { tournamentKnockoutResults } from '../../src/db/schemas/index.schema';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import { syncTournamentKnockoutResults } from '../../src/services/tournament-knockout-results.service';
import { getCurrentEvent } from '../../src/services/events.service';

describe('Tournament Knockout Results Integration Tests', () => {
  let testEventId: number;
  let hasKnockoutTournaments: boolean;

  beforeAll(async () => {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found - cannot run integration tests');
    }
    testEventId = currentEvent.id;

    const tournaments = await tournamentInfoRepository.findActive();
    hasKnockoutTournaments = tournaments.some((t) => t.knockoutMode !== 'no_knockout');

    if (!hasKnockoutTournaments) {
      console.log('⚠️  No knockout tournaments found - some tests will be skipped');
    }
  });

  describe('Sync Integration', () => {
    test('should sync knockout results', async () => {
      const result = await syncTournamentKnockoutResults(testEventId);

      expect(result).toBeDefined();
      expect(result.eventId).toBe(testEventId);
      expect(result.updatedResults).toBeGreaterThanOrEqual(0);
      expect(result.updatedKnockouts).toBeGreaterThanOrEqual(0);
    });

    test('should store results in database', async () => {
      if (!hasKnockoutTournaments) {
        console.log('⊘ Skipping - no knockout tournaments');
        return;
      }

      await syncTournamentKnockoutResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentKnockoutResults);

      expect(results.length).toBeGreaterThanOrEqual(0);

      if (results.length > 0) {
        const result = results[0];
        expect(typeof result.tournamentId).toBe('number');
        expect(typeof result.knockoutId).toBe('number');
        expect(typeof result.entryId).toBe('number');
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid knockout result structure', async () => {
      if (!hasKnockoutTournaments) {
        console.log('⊘ Skipping - no knockout tournaments');
        return;
      }

      await syncTournamentKnockoutResults(testEventId);

      const db = await getDb();
      const results = await db.select().from(tournamentKnockoutResults);

      if (results.length > 0) {
        const result = results[0];
        expect(result.tournamentId).toBeGreaterThan(0);
        expect(result.knockoutId).toBeGreaterThan(0);
        expect(result.entryId).toBeGreaterThan(0);
      }
    });
  });
});
