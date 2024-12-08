import * as E from 'fp-ts/Either';
import { BASE_URLS } from '../../../src/infrastructure/api/config/api.config';
import { FPLClient } from '../../../src/infrastructure/api/fpl/client';
import { EventResponse } from '../../../src/types/events.type';

// Types for test assertions
interface Fixture {
  event: number;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  finished: boolean;
  minutes: number;
  started: boolean;
}

interface LiveEventResponse {
  elements: Array<{
    id: number;
    stats: Record<string, number>;
    explain: Array<unknown>;
  }>;
}

describe('FPLClient Integration Tests', () => {
  let client: FPLClient;

  beforeAll(() => {
    client = new FPLClient({
      baseURL: BASE_URLS.FPL,
      timeout: 10000, // 10 seconds for tests
    });
  });

  describe('Bootstrap Static Data', () => {
    it('should fetch and validate bootstrap static data', async () => {
      const result = await client.getBootstrapStatic();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const data = result.right as EventResponse;
        expect(data).toHaveProperty('events');
        expect(data).toHaveProperty('teams');
        expect(data).toHaveProperty('elements');
        expect(Array.isArray(data.events)).toBe(true);
        expect(Array.isArray(data.teams)).toBe(true);
        expect(Array.isArray(data.elements)).toBe(true);
      }
    });
  });

  describe('Fixtures Data', () => {
    it('should fetch fixtures for a specific gameweek', async () => {
      const result = await client.getFixtures(1);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const fixtures = result.right as Fixture[];
        expect(Array.isArray(fixtures)).toBe(true);
        if (fixtures.length > 0) {
          const fixture = fixtures[0];
          expect(fixture).toHaveProperty('event');
          expect(fixture).toHaveProperty('team_h');
          expect(fixture).toHaveProperty('team_a');
          expect(typeof fixture.event).toBe('number');
          expect(typeof fixture.team_h).toBe('number');
          expect(typeof fixture.team_a).toBe('number');
        }
      }
    });
  });

  describe('Live Gameweek Data', () => {
    it('should fetch live data for a specific gameweek', async () => {
      const result = await client.getEventLive(1);

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const data = result.right as LiveEventResponse;
        expect(data).toHaveProperty('elements');
        expect(Array.isArray(data.elements)).toBe(true);
        if (data.elements.length > 0) {
          const element = data.elements[0];
          expect(element).toHaveProperty('id');
          expect(element).toHaveProperty('stats');
          expect(typeof element.id).toBe('number');
          expect(typeof element.stats).toBe('object');
        }
      }
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid gameweek gracefully', async () => {
      const result = await client.getFixtures(999);

      expect(E.isLeft(result)).toBe(true);
      if (E.isLeft(result)) {
        expect(result.left).toHaveProperty('message');
        expect(result.left).toHaveProperty('statusCode');
        expect(typeof result.left.message).toBe('string');
        expect(typeof result.left.statusCode).toBe('number');
      }
    });
  });
});
