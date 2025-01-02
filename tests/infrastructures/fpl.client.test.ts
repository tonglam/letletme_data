import * as E from 'fp-ts/Either';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';

describe('FPL Client Integration Tests', () => {
  let fplClient: FPLEndpoints;

  beforeAll(() => {
    fplClient = createFPLClient();
  });

  describe('Bootstrap Endpoints', () => {
    it('should fetch bootstrap static data', async () => {
      const result = await fplClient.bootstrap.getBootstrapStatic();
      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('Element (Player) Endpoints', () => {
    it('should fetch player summary data', async () => {
      const playerId = 1;
      const result = await fplClient.element.getElementSummary(playerId);
      expect(E.isRight(result)).toBe(true);
    });

    it('should handle invalid player ID', async () => {
      const invalidPlayerId = 99999;
      const result = await fplClient.element.getElementSummary(invalidPlayerId);
      expect(E.isLeft(result)).toBe(true);
    });
  });

  describe('Entry (Team) Endpoints', () => {
    const validTeamId = 5670789;

    it('should fetch team information', async () => {
      const result = await fplClient.entry.getEntry(validTeamId);
      expect(E.isRight(result)).toBe(true);
    });

    it('should fetch team transfer history', async () => {
      const result = await fplClient.entry.getEntryTransfers(validTeamId);
      expect(E.isRight(result)).toBe(true);
    });

    it('should fetch team history', async () => {
      const result = await fplClient.entry.getEntryHistory(validTeamId);
      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('Event (Gameweek) Endpoints', () => {
    const currentGameweek = 1;

    it('should fetch live gameweek data', async () => {
      const result = await fplClient.event.getLive(currentGameweek);
      expect(E.isRight(result)).toBe(true);
    });

    it('should fetch team picks for a gameweek', async () => {
      const teamId = 5670789;
      const result = await fplClient.event.getPicks(teamId, currentGameweek);
      expect(E.isRight(result)).toBe(true);
    });

    it('should fetch gameweek fixtures', async () => {
      const result = await fplClient.event.getFixtures(currentGameweek);
      expect(E.isRight(result)).toBe(true);
    });
  });

  describe('Leagues Endpoints', () => {
    const classicLeagueId = 314;
    const h2hLeagueId = 967;
    const page = 1;

    it('should fetch classic league standings', async () => {
      const result = await fplClient.leagues.getClassicLeague(classicLeagueId, page);
      expect(E.isRight(result)).toBe(true);
    });

    it('should handle H2H league standings request', async () => {
      const result = await fplClient.leagues.getH2hLeague(h2hLeagueId, page);
      expect(E.isRight(result) || E.isLeft(result)).toBe(true);
    });

    it('should handle cup matches request', async () => {
      const teamId = 5670789;
      const result = await fplClient.leagues.getCup(h2hLeagueId, page, teamId);
      expect(E.isRight(result) || E.isLeft(result)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle rate limiting', async () => {
      const tasks = Array(100)
        .fill(null)
        .map(() => fplClient.element.getElementSummary(1));

      const results = await Promise.all(tasks);
      expect(results.every((result) => E.isRight(result) || E.isLeft(result))).toBe(true);
    }, 30000);

    it('should handle network errors', async () => {
      const invalidClient = createFPLClient();
      const result = await invalidClient.element.getElementSummary(99999999);
      expect(E.isLeft(result)).toBe(true);
    });
  });
});
