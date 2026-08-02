import { describe, expect, mock, test } from 'bun:test';

import type { StoredPlayerValue } from '../../src/repositories/player-values';
import {
  createPlayerValuesSync,
  type PlayerValuesSyncDependencies,
} from '../../src/services/player-values.service';
import {
  mockTeamsForPlayerValues,
  singleRawFPLElementFixture,
} from '../fixtures/player-values.fixtures';

const changeDate = '20260803';

function storedValue(
  value: number,
  changeType: StoredPlayerValue['changeType'],
  lastValue: number,
): StoredPlayerValue {
  return {
    elementId: singleRawFPLElementFixture.id,
    elementType: singleRawFPLElementFixture.element_type,
    eventId: 1,
    value,
    changeDate,
    changeType,
    lastValue,
  };
}

function buildDependencies(
  overrides: Partial<PlayerValuesSyncDependencies> = {},
): PlayerValuesSyncDependencies {
  return {
    getBootstrap: async () => ({ elements: [singleRawFPLElementFixture], teams: [] }) as never,
    resolvePlayerSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
    findLatestForAllPlayers: async () => [],
    findByChangeDate: async () => [],
    insertBatch: async (rows) => ({ count: rows.length, inserted: rows }),
    loadTeamsBasicInfo: async () => mockTeamsForPlayerValues as never,
    getCachedValues: async () => null,
    mergeCachedValues: async () => undefined,
    enqueuePlayerPrices: async () => ({ id: 'player-prices-immediate' }) as never,
    notify: async () => undefined,
    ...overrides,
  };
}

describe('player-values synchronization orchestration', () => {
  test('performs no database or Redis mutation on a true no-change run', async () => {
    const insertBatch = mock(async () => ({ count: 0, inserted: [] }));
    const loadTeamsBasicInfo = mock(async () => mockTeamsForPlayerValues as never);
    const getCachedValues = mock(async () => null);
    const mergeCachedValues = mock(async () => undefined);
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);

    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => [
          {
            elementId: singleRawFPLElementFixture.id,
            value: singleRawFPLElementFixture.now_cost,
            changeDate: '20260802',
          },
        ],
        insertBatch,
        loadTeamsBasicInfo,
        getCachedValues,
        mergeCachedValues,
        enqueuePlayerPrices,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0 });
    expect(insertBatch).not.toHaveBeenCalled();
    expect(loadTeamsBasicInfo).not.toHaveBeenCalled();
    expect(getCachedValues).not.toHaveBeenCalled();
    expect(mergeCachedValues).not.toHaveBeenCalled();
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
  });

  test('persists and repairs history before enqueueing prices and notifying', async () => {
    const operations: string[] = [];
    const changedElement = { ...singleRawFPLElementFixture, now_cost: 143 };
    const persisted = storedValue(143, 'Rise', 142);
    let dateReadCount = 0;

    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap: async () => ({ elements: [changedElement], teams: [] }) as never,
        findLatestForAllPlayers: async () => [
          { elementId: changedElement.id, value: 142, changeDate: '20260802' },
        ],
        findByChangeDate: async () => (dateReadCount++ === 0 ? [] : [persisted]),
        insertBatch: async (rows) => {
          operations.push('persist');
          return { count: rows.length, inserted: rows };
        },
        mergeCachedValues: async (_date, rows) => {
          operations.push('cache');
          expect(rows).toHaveLength(1);
        },
        enqueuePlayerPrices: async (_source, options) => {
          operations.push('enqueue');
          expect(options).toMatchObject({
            changeDate,
            jobId: `player-prices-${changeDate}-immediate`,
          });
          return { id: 'player-prices-immediate' } as never;
        },
        notify: async () => {
          operations.push('notify');
        },
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 1 });
    expect(operations).toEqual(['persist', 'cache', 'enqueue', 'notify']);
  });

  test('notification failure does not invalidate a successful capture', async () => {
    const changedElement = { ...singleRawFPLElementFixture, now_cost: 143 };
    const persisted = storedValue(143, 'Rise', 142);
    let dateReadCount = 0;
    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap: async () => ({ elements: [changedElement], teams: [] }) as never,
        findLatestForAllPlayers: async () => [
          { elementId: changedElement.id, value: 142, changeDate: '20260802' },
        ],
        findByChangeDate: async () => (dateReadCount++ === 0 ? [] : [persisted]),
        notify: async () => {
          throw new Error('bot unavailable');
        },
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 1 });
  });
});
