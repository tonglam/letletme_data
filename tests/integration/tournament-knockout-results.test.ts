import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, test } from 'bun:test';

import { getDb } from '../../src/db/singleton';
import { tournamentKnockoutResults } from '../../src/db/schemas/index.schema';
import { syncTournamentKnockoutResults } from '../../src/services/tournament-knockout-results.service';
import { resolveIntegrationSeedAvailability } from './helpers/tournament-seed';

const resolved = await resolveIntegrationSeedAvailability('knockout');

describe.skipIf(!resolved.canRun || !resolved.seed?.currentEvent)(
  'Tournament Knockout Results Integration Tests',
  () => {
    const seed = resolved.seed;
    const testEventId = seed?.currentEvent?.id ?? -1;

    describe('Sync Integration', () => {
      test('should sync knockout results', async () => {
        const result = await syncTournamentKnockoutResults(testEventId);

        expect(result).toBeDefined();
        expect(result.eventId).toBe(testEventId);
        expect(result.updatedResults).toBeGreaterThanOrEqual(0);
        expect(result.updatedKnockouts).toBeGreaterThanOrEqual(0);
      });

      test('should store results in database', async () => {
        await syncTournamentKnockoutResults(testEventId);

        const db = await getDb();
        const results = await db.select().from(tournamentKnockoutResults);

        expect(results.length).toBeGreaterThanOrEqual(0);

        if (results.length > 0) {
          const result = results[0];
          expect(typeof result.tournamentId).toBe('number');
          expect(typeof result.matchId).toBe('number');
          expect(typeof result.playAgainstId).toBe('number');
        }
      });
    });

    describe('Data Validation', () => {
      test('should have valid knockout result structure', async () => {
        await syncTournamentKnockoutResults(testEventId);

        const db = await getDb();
        const results = await db.select().from(tournamentKnockoutResults);

        if (results.length > 0) {
          const result = results[0];
          expect(result.tournamentId).toBeGreaterThan(0);
          expect(result.matchId).toBeGreaterThan(0);
          expect(result.playAgainstId).toBeGreaterThan(0);
        }
      });
    });
  },
);
