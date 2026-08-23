import { describe, expect, test } from 'bun:test';

import {
  UnderstatClient,
  UnderstatClientError,
  UnderstatLeagueResponseSchema,
  UnderstatNumberSchema,
  UnderstatTeamResponseSchema,
} from '../../src/clients/understat';
import { UNDERSTAT_LEAGUE_FIXTURE, UNDERSTAT_TEAM_FIXTURE } from '../fixtures/understat.fixtures';

describe('Understat client boundary', () => {
  test('converts numeric strings but rejects empty values', () => {
    expect(UnderstatNumberSchema.parse('1.25')).toBe(1.25);
    expect(UnderstatNumberSchema.safeParse('').success).toBe(false);
    expect(UnderstatLeagueResponseSchema.parse(UNDERSTAT_LEAGUE_FIXTURE).dates[0].id).toBe(28786);
  });

  test('normalizes omitted forecasts for future fixtures', () => {
    const { forecast, ...unplayedDate } = UNDERSTAT_LEAGUE_FIXTURE.dates[0];
    expect(forecast).toBeDefined();

    const parsed = UnderstatLeagueResponseSchema.parse({
      ...UNDERSTAT_LEAGUE_FIXTURE,
      dates: [{ ...unplayedDate, isResult: false }],
    });

    expect(parsed.dates[0].forecast).toEqual({ w: null, d: null, l: null });
  });

  test('rejects omitted forecasts for completed fixtures', () => {
    const { forecast, ...completedDate } = UNDERSTAT_LEAGUE_FIXTURE.dates[0];
    expect(forecast).toBeDefined();

    const result = UnderstatLeagueResponseSchema.safeParse({
      ...UNDERSTAT_LEAGUE_FIXTURE,
      dates: [completedDate],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['dates', 0, 'forecast'] }),
      );
    }
  });

  test('normalizes an empty team statistics array for seasons without results', () => {
    const parsed = UnderstatTeamResponseSchema.parse({
      ...UNDERSTAT_TEAM_FIXTURE,
      statistics: [],
    });

    expect(parsed.statistics).toEqual({
      situation: {},
      formation: {},
      gameState: {},
      timing: {},
      shotZone: {},
      attackSpeed: {},
      result: {},
    });
  });

  test('accepts empty team statistics only for the active result-free season', async () => {
    const client = new UnderstatClient({
      enabled: true,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            ...UNDERSTAT_TEAM_FIXTURE,
            dates: [{ ...UNDERSTAT_TEAM_FIXTURE.dates[0], isResult: false }],
            statistics: [],
          }),
        ),
    });

    await expect(client.getTeamData('Chelsea', 2026)).resolves.toMatchObject({
      statistics: { situation: {} },
    });
  });

  test('rejects empty team statistics for completed or historical responses', async () => {
    const client = new UnderstatClient({
      enabled: true,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            ...UNDERSTAT_TEAM_FIXTURE,
            statistics: [],
          }),
        ),
    });

    await expect(client.getTeamData('Chelsea', 2026)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
    await expect(client.getTeamData('Chelsea', 2025)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });

  test('is a hard no-network gate when disabled', async () => {
    let calls = 0;
    const client = new UnderstatClient({
      enabled: false,
      fetchFn: async () => {
        calls += 1;
        return new Response('{}');
      },
    });

    await expect(client.getLeagueData('EPL', 2026)).rejects.toBeInstanceOf(UnderstatClientError);
    expect(calls).toBe(0);
  });

  test('encodes team title and sends the required XMLHttpRequest header', async () => {
    let capturedUrl = '';
    let capturedHeader = '';
    const client = new UnderstatClient({
      enabled: true,
      fetchFn: async (input, init) => {
        capturedUrl = String(input);
        capturedHeader = new Headers(init?.headers).get('X-Requested-With') ?? '';
        return new Response(
          JSON.stringify({
            dates: [],
            players: [],
            statistics: {
              situation: {},
              formation: {},
              gameState: {},
              timing: {},
              shotZone: {},
              attackSpeed: {},
              result: {},
            },
          }),
        );
      },
    });

    await client.getTeamData('Manchester United', 2026);
    expect(capturedUrl).toEndWith('/getTeamData/Manchester%20United/2026');
    expect(capturedHeader).toBe('XMLHttpRequest');
  });

  test('does not retry a non-retryable invalid JSON response', async () => {
    let calls = 0;
    const client = new UnderstatClient({
      enabled: true,
      fetchFn: async () => {
        calls += 1;
        return new Response('not-json');
      },
    });

    await expect(client.getLeagueData('EPL', 2026)).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    expect(calls).toBe(1);
  });

  test('classifies 429 for the queue without retrying inside the client', async () => {
    let calls = 0;
    const client = new UnderstatClient({
      enabled: true,
      fetchFn: async () => {
        calls += 1;
        return new Response('', { status: 429, headers: { 'Retry-After': '2' } });
      },
    });

    await expect(client.getLeagueData('EPL', 2026)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      retryable: true,
      retryAfterMs: 2_000,
    });
    expect(calls).toBe(1);
  });

  test('starts the network timeout after the provider permit is acquired', async () => {
    let signal: AbortSignal | undefined;
    const client = new UnderstatClient({
      enabled: true,
      timeoutMs: 10,
      acquirePermit: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return async () => {};
      },
      fetchFn: async (_input, init) => {
        signal = init?.signal ?? undefined;
        return new Response(
          JSON.stringify({
            dates: [],
            players: [],
            statistics: {
              situation: {},
              formation: {},
              gameState: {},
              timing: {},
              shotZone: {},
              attackSpeed: {},
              result: {},
            },
          }),
        );
      },
    });

    await client.getTeamData('Manchester United', 2026);
    expect(signal?.aborted).toBe(false);
  });
});
