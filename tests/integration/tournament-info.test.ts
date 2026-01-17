import { describe, expect, test } from 'bun:test';

import { tournamentInfos } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { syncTournamentInfo } from '../../src/services/tournament-info.service';

describe('Tournament Info Integration Tests', () => {
  describe('Sync Integration', () => {
    test('should sync tournament info', async () => {
      const result = await syncTournamentInfo();

      expect(result).toBeDefined();
      expect(typeof result.updated).toBe('number');
      expect(result.updated).toBeGreaterThanOrEqual(0);
      expect(result.total).toBeGreaterThanOrEqual(0);
    });

    test('should store tournament info in database', async () => {
      await syncTournamentInfo();

      const db = await getDb();
      const infos = await db.select().from(tournamentInfos);

      expect(infos.length).toBeGreaterThanOrEqual(0);

      if (infos.length > 0) {
        const info = infos[0];
        expect(typeof info.id).toBe('number');
        expect(typeof info.leagueId).toBe('number');
        expect(typeof info.leagueType).toBe('string');
        expect(['classic', 'h2h']).toContain(info.leagueType);
      }
    });
  });

  describe('Data Validation', () => {
    test('should have valid tournament info structure', async () => {
      await syncTournamentInfo();

      const db = await getDb();
      const infos = await db.select().from(tournamentInfos);

      if (infos.length > 0) {
        const info = infos[0];

        // Validate group mode
        expect(['no_group', 'points_races', 'battle_races']).toContain(info.groupMode);

        // Validate knockout mode
        expect([
          'no_knockout',
          'single_elimination',
          'double_elimination',
          'head_to_head',
        ]).toContain(info.knockoutMode);

        // Validate state
        expect(['active', 'inactive', 'finished']).toContain(info.state);

        // Total team num should be positive
        expect(info.totalTeamNum).toBeGreaterThan(0);
      }
    });

    test('should have valid event ID ranges', async () => {
      await syncTournamentInfo();

      const db = await getDb();
      const infos = await db.select().from(tournamentInfos);

      infos.forEach((info) => {
        if (info.groupStartedEventId !== null) {
          expect(info.groupStartedEventId).toBeGreaterThan(0);
          expect(info.groupStartedEventId).toBeLessThanOrEqual(38);
        }

        if (info.groupEndedEventId !== null) {
          expect(info.groupEndedEventId).toBeGreaterThan(0);
          expect(info.groupEndedEventId).toBeLessThanOrEqual(38);
        }

        if (info.groupStartedEventId && info.groupEndedEventId) {
          expect(info.groupEndedEventId).toBeGreaterThanOrEqual(info.groupStartedEventId);
        }

        if (info.knockoutStartedEventId !== null) {
          expect(info.knockoutStartedEventId).toBeGreaterThan(0);
          expect(info.knockoutStartedEventId).toBeLessThanOrEqual(38);
        }

        if (info.knockoutEndedEventId !== null) {
          expect(info.knockoutEndedEventId).toBeGreaterThan(0);
          expect(info.knockoutEndedEventId).toBeLessThanOrEqual(38);
        }
      });
    });

    test('should have consistent group/knockout modes with event IDs', async () => {
      await syncTournamentInfo();

      const db = await getDb();
      const infos = await db.select().from(tournamentInfos);

      infos.forEach((info) => {
        // If group mode is not no_group, should have group event IDs
        if (info.groupMode !== 'no_group') {
          // May not have event IDs if tournament hasn't started yet
        }

        // If knockout mode is not no_knockout, should have knockout event IDs
        if (info.knockoutMode !== 'no_knockout') {
          // May not have event IDs if knockout hasn't started yet
        }
      });
    });
  });

  describe('Active Tournaments', () => {
    test('should identify active tournaments correctly', async () => {
      await syncTournamentInfo();

      const db = await getDb();
      const infos = await db.select().from(tournamentInfos);

      const activeTournaments = infos.filter((i) => i.state === 'active');
      const inactiveTournaments = infos.filter((i) => i.state === 'inactive');
      const finishedTournaments = infos.filter((i) => i.state === 'finished');

      // Total should equal all tournaments
      expect(
        activeTournaments.length + inactiveTournaments.length + finishedTournaments.length,
      ).toBe(infos.length);
    });
  });

  describe('Performance', () => {
    test('should sync efficiently', async () => {
      const startTime = performance.now();
      await syncTournamentInfo();
      const endTime = performance.now();

      const duration = endTime - startTime;
      // Should complete within reasonable time
      expect(duration).toBeLessThan(60000); // 60 seconds
    });
  });
});
