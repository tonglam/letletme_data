import { describe, expect, test } from 'bun:test';

import { finalizeTournamentEventLifecycle } from '../../src/domain/tournament-event-finalization';

describe('tournament event finalization', () => {
  test('delegates skipped-cascade recovery to the canonical finish gate', async () => {
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
    });

    expect(finished).toBe(2);
    expect(calls).toEqual(['finish:12', 'refresh']);
  });

  test('refreshes after recovery when finish was already committed', async () => {
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
    });

    expect(calls).toEqual(['finish', 'refresh']);
  });
});
