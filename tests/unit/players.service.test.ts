import { describe, expect, mock, test } from 'bun:test';

import { createPlayersSync } from '../../src/services/players.service';
import type { CoreSnapshotSyncResult } from '../../src/services/core-snapshot.service';

function coreResult(overrides: Partial<CoreSnapshotSyncResult> = {}): CoreSnapshotSyncResult {
  return {
    outcome: 'ready',
    season: '2627',
    events: 38,
    teams: 20,
    players: 220,
    phases: 1,
    fixtures: 380,
    requiredUnits: 659,
    reusedUnits: 0,
    succeededUnits: 659,
    failedUnits: 0,
    ...overrides,
  };
}

describe('players sync compatibility', () => {
  test('routes player refreshes through one complete core snapshot', async () => {
    const syncCore = mock(async () => coreResult());

    await expect(createPlayersSync({ syncCore })()).resolves.toEqual({ count: 220, errors: 0 });
    expect(syncCore).toHaveBeenCalledTimes(1);
  });

  test('maps a stale complete snapshot without starting a partial write', async () => {
    const syncCore = mock(async () =>
      coreResult({ outcome: 'noop', reusedUnits: 659, succeededUnits: 0 }),
    );

    await expect(createPlayersSync({ syncCore })()).resolves.toEqual({ count: 220, errors: 0 });
  });

  test('propagates canonical publication failures', async () => {
    const syncCore = mock(async (): Promise<CoreSnapshotSyncResult> => {
      throw new Error('core publication failed');
    });

    await expect(createPlayersSync({ syncCore })()).rejects.toThrow('core publication failed');
  });
});
