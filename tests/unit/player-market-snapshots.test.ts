import { describe, expect, test } from 'bun:test';

import type { FPLBootstrapResponse, RawFPLElement } from '../../src/clients/fpl';
import {
  validateCompleteMarketSnapshotBatch,
  type PlayerMarketSnapshot,
} from '../../src/domain/player-market-snapshots';
import { createPlayerMarketSnapshotsRepository } from '../../src/repositories/player-market-snapshots';
import { transformPlayerMarketSnapshots } from '../../src/transformers/player-market-snapshots';
import { rawFPLElementsFixture } from '../fixtures/player-stats.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const teams = [
  { id: 1, name: 'Arsenal', short_name: 'ARS' },
  { id: 2, name: 'Manchester City', short_name: 'MCI' },
  { id: 3, name: 'Liverpool', short_name: 'LIV' },
] as unknown as FPLBootstrapResponse['teams'];

function bootstrap(elements: RawFPLElement[]) {
  return { elements, teams } as Pick<FPLBootstrapResponse, 'elements' | 'teams'>;
}

describe('player market snapshot transformation', () => {
  test('captures the complete upstream identity, ownership, transfer, and availability state', () => {
    const element = {
      ...rawFPLElementsFixture[0],
      status: 'd',
      selected_by_percent: '17.125',
      news: 'Hamstring injury - 25% chance of playing',
      news_added: '2026-08-02T08:15:00Z',
      chance_of_playing_this_round: 25,
      chance_of_playing_next_round: 50,
    };
    const capturedAt = new Date('2026-08-02T23:40:00Z');

    const [snapshot] = transformPlayerMarketSnapshots(bootstrap([element]), capturedAt);

    expect(snapshot).toMatchObject({
      snapshotDate: '2026-08-03',
      capturedAt,
      elementId: element.id,
      playerCode: element.code,
      webName: element.web_name,
      teamId: element.team,
      teamName: 'Arsenal',
      teamShortName: 'ARS',
      position: 'GKP',
      price: element.now_cost,
      selectedByPercent: 17.125,
      transfersIn: element.transfers_in,
      transfersOut: element.transfers_out,
      transfersInEvent: element.transfers_in_event,
      transfersOutEvent: element.transfers_out_event,
      status: 'd',
      news: element.news,
      chanceOfPlayingThisRound: 25,
      chanceOfPlayingNextRound: 50,
    });
    expect(snapshot.newsAdded?.toISOString()).toBe('2026-08-02T08:15:00.000Z');
  });

  test('accepts a newly added player as another full-roster observation', () => {
    const newcomer = {
      ...rawFPLElementsFixture[0],
      id: 999,
      code: 999_001,
      web_name: 'Newcomer',
      team: 2,
    };

    const snapshots = transformPlayerMarketSnapshots(
      bootstrap([...rawFPLElementsFixture, newcomer]),
      new Date('2026-08-03T01:40:00Z'),
    );

    expect(snapshots).toHaveLength(rawFPLElementsFixture.length + 1);
    expect(snapshots.at(-1)).toMatchObject({
      elementId: 999,
      webName: 'Newcomer',
      teamName: 'Manchester City',
    });
  });

  test.each([
    ['ownership above 100', { selected_by_percent: '100.1' }],
    ['non-numeric ownership', { selected_by_percent: 'unknown' }],
    ['negative cumulative transfers', { transfers_in: -1 }],
    ['negative event transfers', { transfers_out_event: -1 }],
    ['invalid news timestamp', { news_added: 'not-a-timestamp' }],
    ['invalid playing chance', { chance_of_playing_this_round: 101 }],
  ])('rejects %s', (_label, overrides) => {
    const invalid = { ...rawFPLElementsFixture[0], ...overrides } as RawFPLElement;
    expect(() =>
      transformPlayerMarketSnapshots(bootstrap([invalid]), new Date('2026-08-03T01:40:00Z')),
    ).toThrow();
  });

  test('rejects missing teams, duplicate players, and empty upstream rosters', () => {
    expect(() =>
      transformPlayerMarketSnapshots(
        bootstrap([{ ...rawFPLElementsFixture[0], team: 999 }]),
        new Date('2026-08-03T01:40:00Z'),
      ),
    ).toThrow('Missing team 999');

    const duplicated = [rawFPLElementsFixture[0], rawFPLElementsFixture[0]];
    expect(() =>
      transformPlayerMarketSnapshots(bootstrap(duplicated), new Date('2026-08-03T01:40:00Z')),
    ).toThrow('duplicate players');

    expect(() =>
      transformPlayerMarketSnapshots(bootstrap([]), new Date('2026-08-03T01:40:00Z')),
    ).toThrow('Incomplete market snapshot batch');
  });
});

describe('complete daily market snapshot repository', () => {
  function createSnapshot(overrides: Partial<PlayerMarketSnapshot> = {}): PlayerMarketSnapshot {
    return {
      ...transformPlayerMarketSnapshots(
        bootstrap([rawFPLElementsFixture[0]]),
        new Date('2026-08-03T01:40:00Z'),
      )[0],
      ...overrides,
    };
  }

  function createMemoryDb(options: { dropLastReturn?: boolean } = {}) {
    const rows = new Map<string, Record<string, unknown>>();
    return {
      rows,
      db: {
        insert: () => ({
          values: (values: Array<Record<string, unknown>>) => ({
            onConflictDoUpdate: () => ({
              returning: async () => {
                for (const value of values) {
                  rows.set(`${value.snapshotDate}:${value.elementId}`, value);
                }
                const returned = values.map((value) => ({ elementId: value.elementId }));
                return options.dropLastReturn ? returned.slice(0, -1) : returned;
              },
            }),
          }),
        }),
        delete: () => ({ where: async () => undefined }),
        select: () => ({
          from: () => ({
            where: async () => [
              {
                count: rows.size,
                snapshotCount: rows.size,
                captureCount: new Set([...rows.values()].map((row) => String(row.capturedAt))).size,
                latestCapturedAt:
                  [...rows.values()].map((row) => row.capturedAt as Date).at(-1) ?? null,
              },
            ],
          }),
        }),
      },
    };
  }

  test('updates a same-day player observation without duplicating the row', async () => {
    const memory = createMemoryDb();
    const repository = createPlayerMarketSnapshotsRepository(memory.db as never);
    const first = createSnapshot();
    const retry = createSnapshot({
      capturedAt: new Date('2026-08-03T02:10:00Z'),
      selectedByPercent: 18.4,
    });

    await repository.upsertCompleteDay(TEST_SEASON, 1, [first], 1);
    const result = await repository.upsertCompleteDay(TEST_SEASON, 1, [retry], 1);

    expect(result).toEqual({ snapshotDate: '2026-08-03', persistedCount: 1 });
    expect(memory.rows.size).toBe(1);
    expect(memory.rows.get('2026-08-03:1')).toMatchObject({
      seasonId: TEST_SEASON.seasonId,
      sourceEventId: 1,
      capturedAt: retry.capturedAt,
      selectedByPercent: '18.4',
    });
  });

  test('fails the whole day when the database does not return every upstream player', async () => {
    const first = createSnapshot();
    const second = createSnapshot({ elementId: 2, playerCode: 2 });
    validateCompleteMarketSnapshotBatch([first, second], 2);
    const memory = createMemoryDb({ dropLastReturn: true });
    const repository = createPlayerMarketSnapshotsRepository(memory.db as never);

    await expect(repository.upsertCompleteDay(TEST_SEASON, 1, [first, second], 2)).rejects.toThrow(
      'Failed to persist complete player market snapshot',
    );
  });

  test('reports current-day snapshot coverage for the watchdog', async () => {
    const memory = createMemoryDb();
    const repository = createPlayerMarketSnapshotsRepository(memory.db as never);
    expect(await repository.getDayCoverage(TEST_SEASON, '20260803')).toEqual({
      snapshotCount: 0,
      captureCount: 0,
      latestCapturedAt: null,
    });

    const snapshot = createSnapshot();
    await repository.upsertCompleteDay(TEST_SEASON, 1, [snapshot], 1);
    expect(await repository.getDayCoverage(TEST_SEASON, '2026-08-03')).toEqual({
      snapshotCount: 1,
      captureCount: 1,
      latestCapturedAt: snapshot.capturedAt,
    });
  });

  test('normalizes aggregate timestamp strings returned by PostgreSQL', async () => {
    const repository = createPlayerMarketSnapshotsRepository({
      select: () => ({
        from: () => ({
          where: async () => [
            {
              snapshotCount: 600,
              captureCount: 1,
              latestCapturedAt: '2026-08-03T01:40:00.000Z',
            },
          ],
        }),
      }),
    } as never);

    await expect(repository.getDayCoverage(TEST_SEASON, '20260803')).resolves.toEqual({
      snapshotCount: 600,
      captureCount: 1,
      latestCapturedAt: new Date('2026-08-03T01:40:00.000Z'),
    });
  });
});
