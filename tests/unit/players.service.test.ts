import { describe, expect, mock, test } from 'bun:test';

import {
  createPlayersSync,
  type PlayersSyncDependencies,
} from '../../src/services/players.service';
import type { Player, RawFPLElement } from '../../src/types';
import { rawFPLElementsFixture } from '../fixtures/player-stats.fixtures';

function bootstrap(elements: RawFPLElement[]) {
  return { elements, events: [] } as never;
}

function createDependencies(
  elements: RawFPLElement[],
  overrides: Partial<PlayersSyncDependencies> = {},
) {
  const upsertPlayers = mock(async (players: Player[]) => players.map((player) => ({ ...player })));
  const setPlayersCache = mock(async (_players: Player[], _season?: string) => undefined);
  const dependencies: PlayersSyncDependencies = {
    getBootstrap: mock(async () => bootstrap(elements)),
    upsertPlayers,
    setPlayersCache,
    resolvePublishedSeason: mock(async () => '2526'),
    ...overrides,
  };
  return { dependencies, upsertPlayers, setPlayersCache };
}

describe('players sync publication', () => {
  test('preserves the published roster when any bootstrap element is invalid', async () => {
    const partialRoster = [rawFPLElementsFixture[0], { ...rawFPLElementsFixture[1], id: -1 }];
    const { dependencies, upsertPlayers, setPlayersCache } = createDependencies(partialRoster);

    await expect(createPlayersSync(dependencies)()).rejects.toThrow(
      'Failed to transform player at index 1',
    );

    expect(upsertPlayers).not.toHaveBeenCalled();
    expect(setPlayersCache).not.toHaveBeenCalled();
  });

  test('rejects duplicate player identity before database or cache writes', async () => {
    const duplicateRoster = [rawFPLElementsFixture[0], { ...rawFPLElementsFixture[0] }];
    const { dependencies, upsertPlayers, setPlayersCache } = createDependencies(duplicateRoster);

    await expect(createPlayersSync(dependencies)()).rejects.toThrow(
      'FPL player roster contains duplicate player ID 1',
    );

    expect(upsertPlayers).not.toHaveBeenCalled();
    expect(setPlayersCache).not.toHaveBeenCalled();
  });

  test('refuses cache publication when database persistence is incomplete', async () => {
    const roster = rawFPLElementsFixture.slice(0, 2);
    const setPlayersCache = mock(async (_players: Player[], _season?: string) => undefined);
    const { dependencies } = createDependencies(roster, {
      upsertPlayers: async (players) => players.slice(0, 1),
      setPlayersCache,
    });

    await expect(createPlayersSync(dependencies)()).rejects.toThrow(
      'Player persistence returned an incomplete roster: 1/2',
    );
    expect(setPlayersCache).not.toHaveBeenCalled();
  });

  test('publishes one complete verified roster with no tolerated errors', async () => {
    const roster = rawFPLElementsFixture.slice(0, 2);
    const { dependencies, upsertPlayers, setPlayersCache } = createDependencies(roster);

    await expect(createPlayersSync(dependencies)()).resolves.toEqual({ count: 2, errors: 0 });
    expect(upsertPlayers).toHaveBeenCalledTimes(1);
    expect(setPlayersCache).toHaveBeenCalledTimes(1);
    expect(setPlayersCache.mock.calls[0]?.[0]).toHaveLength(2);
    expect(setPlayersCache.mock.calls[0]?.[1]).toBe('2526');
  });
});
