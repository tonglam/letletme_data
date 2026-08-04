import { describe, expect, test } from 'bun:test';

import { finalizeTournamentEventLifecycle } from '../../src/domain/tournament-event-finalization';

describe('tournament event finalization', () => {
  test('finishes and publishes lifecycle state even when the scoring cascade is skipped', async () => {
    const calls: string[] = [];

    const finished = await finalizeTournamentEventLifecycle(12, {
      refreshAlways: false,
      finish: async (eventId) => {
        calls.push(`finish:${eventId}`);
        return 2;
      },
      refresh: async () => {
        calls.push('refresh');
      },
      invalidate: async (reason) => {
        calls.push(`invalidate:${reason}`);
      },
    });

    expect(finished).toBe(2);
    expect(calls).toEqual(['finish:12', 'refresh', 'invalidate:finish']);
  });

  test('retains the cascade refresh without unnecessary cache invalidation', async () => {
    const calls: string[] = [];

    await finalizeTournamentEventLifecycle(12, {
      refreshAlways: true,
      finish: async () => {
        calls.push('finish');
        return 0;
      },
      refresh: async () => {
        calls.push('refresh');
      },
      invalidate: async () => {
        calls.push('invalidate');
      },
    });

    expect(calls).toEqual(['finish', 'refresh']);
  });
});
