import { describe, expect, test } from 'bun:test';

import {
  UnderstatClient,
  UnderstatClientError,
  UnderstatLeagueResponseSchema,
  UnderstatNumberSchema,
} from '../../src/clients/understat';
import { UNDERSTAT_LEAGUE_FIXTURE } from '../fixtures/understat.fixtures';

describe('Understat client boundary', () => {
  test('converts numeric strings but rejects empty values', () => {
    expect(UnderstatNumberSchema.parse('1.25')).toBe(1.25);
    expect(UnderstatNumberSchema.safeParse('').success).toBe(false);
    expect(UnderstatLeagueResponseSchema.parse(UNDERSTAT_LEAGUE_FIXTURE).dates[0].id).toBe(28786);
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
});
