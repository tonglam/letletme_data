import { describe, expect, mock, test } from 'bun:test';

import { TEST_SEASON } from '../fixtures/seasons.fixtures';
import { rawFPLElementsFixture } from '../fixtures/player-stats.fixtures';
import type { PlayerStatsRepository } from '../../src/repositories/player-stats';

const { syncCurrentPlayerStats } = await import('../../src/services/player-stats.service');

describe('player stats synchronization reporting', () => {
  test('publishes the target before bootstrap failures', async () => {
    const resolvedEvents: number[] = [];
    const getBootstrap = mock(async () => {
      throw new Error('bootstrap unavailable');
    });

    await expect(
      syncCurrentPlayerStats(
        TEST_SEASON,
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

  test('rejects non-zero GW1 preseason cumulative values before publication', async () => {
    const replaceBatch = mock(
      async (..._args: Parameters<PlayerStatsRepository['replaceBatch']>) => ({
        count: rawFPLElementsFixture.length,
        expectedRowCount: rawFPLElementsFixture.length,
        revision: 1,
        sourceCheckedAt: new Date(),
        publishedAt: new Date(),
        baselineVerifiedAt: null,
        contentSha256: 'a'.repeat(64),
      }),
    );
    const repository = {
      findCorePlayerIds: async () => rawFPLElementsFixture.map((element) => element.id),
      findPublication: async () => null,
      replaceBatch,
    } as unknown as PlayerStatsRepository;

    await expect(
      syncCurrentPlayerStats(TEST_SEASON, undefined, {
        getBootstrap: async () =>
          ({
            teams: [
              { id: 1, name: 'Arsenal', short_name: 'ARS' },
              { id: 2, name: 'Manchester City', short_name: 'MCI' },
              { id: 3, name: 'Liverpool', short_name: 'LIV' },
            ],
            elements: rawFPLElementsFixture,
          }) as never,
        resolvePlayerSyncEvent: async () => ({ event: { id: 1 }, phase: 'preseason' }) as never,
        repository,
      }),
    ).rejects.toThrow('baseline is not reset');
    expect(replaceBatch).not.toHaveBeenCalled();
  });

  test('publishes a verified zero GW1 baseline as one complete replacement', async () => {
    const zeroElements = rawFPLElementsFixture.map((element) => ({
      ...element,
      total_points: 0,
      minutes: 0,
      goals_scored: 0,
      assists: 0,
      clean_sheets: 0,
      goals_conceded: 0,
      own_goals: 0,
      penalties_saved: 0,
      penalties_missed: 0,
      yellow_cards: 0,
      red_cards: 0,
      saves: 0,
      bonus: 0,
      bps: 0,
      starts: 0,
      expected_goals: '0',
      expected_assists: '0',
      expected_goal_involvements: '0',
      expected_goals_conceded: '0',
    }));
    const replaceBatch = mock(
      async (..._args: Parameters<PlayerStatsRepository['replaceBatch']>) => ({
        count: zeroElements.length,
        expectedRowCount: zeroElements.length,
        revision: 2,
        sourceCheckedAt: new Date(),
        publishedAt: new Date(),
        baselineVerifiedAt: new Date(),
        contentSha256: 'b'.repeat(64),
      }),
    );
    const repository = {
      findCorePlayerIds: async () => zeroElements.map((element) => element.id),
      findPublication: async () => null,
      replaceBatch,
    } as unknown as PlayerStatsRepository;

    const result = await syncCurrentPlayerStats(TEST_SEASON, undefined, {
      getBootstrap: async () =>
        ({
          teams: [
            { id: 1, name: 'Arsenal', short_name: 'ARS' },
            { id: 2, name: 'Manchester City', short_name: 'MCI' },
            { id: 3, name: 'Liverpool', short_name: 'LIV' },
          ],
          elements: zeroElements,
        }) as never,
      resolvePlayerSyncEvent: async () => ({ event: { id: 1 }, phase: 'preseason' }) as never,
      repository,
    });

    expect(result.count).toBe(zeroElements.length);
    expect(replaceBatch).toHaveBeenCalledTimes(1);
    expect(replaceBatch.mock.calls[0]?.[1]).toHaveLength(zeroElements.length);
  });

  test('rejects missing, duplicate, and extra core player identifiers before publication', async () => {
    const cases = [
      {
        name: 'missing source row',
        elements: rawFPLElementsFixture.slice(0, -1),
        coreIds: rawFPLElementsFixture.map((element) => element.id),
      },
      {
        name: 'duplicate source row',
        elements: [
          rawFPLElementsFixture[0],
          rawFPLElementsFixture[0],
          ...rawFPLElementsFixture.slice(2),
        ],
        coreIds: rawFPLElementsFixture.map((element) => element.id),
      },
      {
        name: 'extra core row',
        elements: rawFPLElementsFixture,
        coreIds: [...rawFPLElementsFixture.map((element) => element.id), 999],
      },
    ] as const;

    for (const candidate of cases) {
      const replaceBatch = mock(
        async (..._args: Parameters<PlayerStatsRepository['replaceBatch']>) => ({
          count: candidate.elements.length,
          expectedRowCount: candidate.elements.length,
          revision: 1,
          sourceCheckedAt: new Date(),
          publishedAt: new Date(),
          baselineVerifiedAt: null,
          contentSha256: 'a'.repeat(64),
        }),
      );
      const repository = {
        findCorePlayerIds: async () => candidate.coreIds,
        findPublication: async () => null,
        replaceBatch,
      } as unknown as PlayerStatsRepository;

      await expect(
        syncCurrentPlayerStats(TEST_SEASON, undefined, {
          getBootstrap: async () =>
            ({
              teams: [
                { id: 1, name: 'Arsenal', short_name: 'ARS' },
                { id: 2, name: 'Manchester City', short_name: 'MCI' },
                { id: 3, name: 'Liverpool', short_name: 'LIV' },
              ],
              elements: candidate.elements,
            }) as never,
          resolvePlayerSyncEvent: async () => ({ event: { id: 12 }, phase: 'current' }) as never,
          repository,
        }),
      ).rejects.toThrow();
      expect(replaceBatch).not.toHaveBeenCalled();
    }
  });
});
