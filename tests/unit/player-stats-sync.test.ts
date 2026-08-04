import { describe, expect, mock, test } from 'bun:test';

const { syncCurrentPlayerStats } = await import('../../src/services/player-stats.service');

describe('player stats synchronization reporting', () => {
  test('publishes the target before bootstrap failures', async () => {
    const resolvedEvents: number[] = [];
    const getBootstrap = mock(async () => {
      throw new Error('bootstrap unavailable');
    });

    await expect(
      syncCurrentPlayerStats(
        {
          onTargetEventResolved: (eventId) => resolvedEvents.push(eventId),
        },
        {
          getBootstrap,
          resolvePlayerSyncEvent: async () =>
            ({
              event: { id: 12 },
              phase: 'current',
            }) as never,
        },
      ),
    ).rejects.toThrow('bootstrap unavailable');

    expect(resolvedEvents).toEqual([12]);
    expect(getBootstrap).toHaveBeenCalledTimes(1);
  });
});
