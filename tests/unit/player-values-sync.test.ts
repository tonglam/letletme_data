import { describe, expect, mock, test } from 'bun:test';

import type { PlayerValue } from '../../src/domain/player-values';
import type { StoredPlayerValue } from '../../src/repositories/player-values';
import {
  createPlayerValuesSync,
  type PlayerValuesSyncDependencies,
} from '../../src/services/player-values.service';
import {
  getPlayerValueSeasonBounds,
  getPlayerValueSeasonFloor,
} from '../../src/utils/player-value-season';
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
    resolvePlayerSyncEvent: async () =>
      ({
        event: { id: 1, deadlineTime: '2026-08-15T17:30:00Z' },
        phase: 'current',
      }) as never,
    findLatestForAllPlayers: async () => [],
    findByChangeDate: async () => [],
    findPlayersByIds: async () => [],
    insertBatch: async (rows) => ({ count: rows.length, inserted: rows }),
    loadTeamsBasicInfo: async () => mockTeamsForPlayerValues as never,
    inspectCachedValues: async () => ({ fields: [], entries: [] }),
    mergeCachedValues: async () => undefined,
    deleteCachedFields: async () => undefined,
    enqueuePlayerPrices: async () => ({ id: 'player-prices-immediate' }) as never,
    notify: async () => undefined,
    getCurrentChangeDate: () => changeDate,
    ...overrides,
  };
}

describe('player-values synchronization orchestration', () => {
  test('reports the resolved target before later synchronization work fails', async () => {
    const resolvedEvents: number[] = [];
    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => {
          throw new Error('database unavailable after target resolution');
        },
      }),
    );

    await expect(
      sync(changeDate, {
        onTargetEventResolved: (eventId) => resolvedEvents.push(eventId),
      }),
    ).rejects.toThrow('database unavailable after target resolution');
    expect(resolvedEvents).toEqual([1]);
  });

  test('keeps the same season floor after the calendar year changes', () => {
    expect(getPlayerValueSeasonFloor('2026-08-15T17:30:00Z')).toBe('20260601');
    expect(getPlayerValueSeasonFloor('2027-01-02T11:00:00Z')).toBe('20260601');
    expect(getPlayerValueSeasonBounds('2027-01-02T11:00:00Z')).toEqual({
      fromChangeDate: '20260601',
      beforeChangeDate: '20270601',
    });
  });

  test('discards a delayed capture after its configured date without reading upstream', async () => {
    const getBootstrap = mock(async () => ({ elements: [singleRawFPLElementFixture] }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap,
        getCurrentChangeDate: () => '20260804',
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, outcome: 'noop' });
    expect(getBootstrap).not.toHaveBeenCalled();
  });

  test('scopes preseason history to the published season before seeding Start rows', async () => {
    let persisted: StoredPlayerValue[] = [];
    const findLatestForAllPlayers = mock(
      async (fromChangeDate: string, throughChangeDate: string) => {
        expect(fromChangeDate).toBe('20260601');
        expect(throughChangeDate).toBe(changeDate);
        // Prior-season rows are excluded by the bounded repository query.
        return [];
      },
    );
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);
    const notify = mock(async () => undefined);
    const mergeCachedValues = mock(async () => undefined);
    const deleteCachedFields = mock(async () => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        resolvePlayerSyncEvent: async () =>
          ({
            event: { id: 1, deadlineTime: '2026-08-15T17:30:00Z' },
            phase: 'preseason',
          }) as never,
        findLatestForAllPlayers,
        findByChangeDate: async () => persisted,
        insertBatch: async (rows) => {
          persisted = rows.map((row) => ({
            elementId: row.elementId,
            elementType: row.elementType,
            eventId: row.eventId,
            value: row.value,
            changeDate: row.changeDate,
            changeType: row.changeType,
            lastValue: row.lastValue,
          }));
          return { count: rows.length, inserted: rows };
        },
        enqueuePlayerPrices,
        notify,
        mergeCachedValues,
        deleteCachedFields,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 1, eventId: 1 });
    expect(persisted[0]).toMatchObject({ changeType: 'Start', lastValue: 0 });
    // Start rows seed the DB baseline but must never be published to Redis.
    expect(mergeCachedValues).not.toHaveBeenCalled();
    expect(deleteCachedFields).not.toHaveBeenCalled();
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('performs no database or Redis mutation on a true no-change run', async () => {
    const insertBatch = mock(async () => ({ count: 0, inserted: [] }));
    const loadTeamsBasicInfo = mock(async () => mockTeamsForPlayerValues as never);
    const inspectCachedValues = mock(async () => ({ fields: [], entries: [] }));
    const mergeCachedValues = mock(async () => undefined);
    const deleteCachedFields = mock(async () => undefined);
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
        inspectCachedValues,
        mergeCachedValues,
        deleteCachedFields,
        enqueuePlayerPrices,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(insertBatch).not.toHaveBeenCalled();
    expect(loadTeamsBasicInfo).not.toHaveBeenCalled();
    expect(inspectCachedValues).not.toHaveBeenCalled();
    expect(mergeCachedValues).not.toHaveBeenCalled();
    expect(deleteCachedFields).not.toHaveBeenCalled();
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

    expect(await sync(changeDate)).toEqual({ count: 1, eventId: 1 });
    expect(operations).toEqual(['persist', 'cache', 'enqueue', 'notify']);
  });

  test('retries negative-marker deletion after a complete positive hash write', async () => {
    const persisted = storedValue(singleRawFPLElementFixture.now_cost, 'Rise', 141);
    const cachedValue: PlayerValue = {
      ...persisted,
      elementType: 4,
      elementTypeName: 'FWD',
      webName: singleRawFPLElementFixture.web_name,
      teamId: singleRawFPLElementFixture.team,
      teamName: 'Manchester City',
      teamShortName: 'MCI',
    };
    const mergeCachedValues = mock(async () => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => [
          {
            elementId: singleRawFPLElementFixture.id,
            value: singleRawFPLElementFixture.now_cost,
            changeDate: '20260802',
          },
        ],
        findByChangeDate: async () => [persisted],
        inspectCachedValues: async () => ({
          fields: [String(cachedValue.elementId)],
          entries: [[String(cachedValue.elementId), cachedValue]],
        }),
        mergeCachedValues,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(mergeCachedValues).toHaveBeenCalledTimes(1);
    expect(mergeCachedValues).toHaveBeenCalledWith(changeDate, [cachedValue]);
  });

  test('writes verified fields before deleting stale or mis-keyed fields', async () => {
    const persisted = storedValue(singleRawFPLElementFixture.now_cost, 'Rise', 141);
    const cachedValue: PlayerValue = {
      ...persisted,
      elementType: 4,
      elementTypeName: 'FWD',
      webName: singleRawFPLElementFixture.web_name,
      teamId: singleRawFPLElementFixture.team,
      teamName: 'Manchester City',
      teamShortName: 'MCI',
    };
    const operations: string[] = [];
    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => [
          {
            elementId: singleRawFPLElementFixture.id,
            value: singleRawFPLElementFixture.now_cost,
            changeDate: '20260802',
          },
        ],
        findByChangeDate: async () => [persisted],
        inspectCachedValues: async () => ({
          fields: ['wrong-field'],
          entries: [['wrong-field', cachedValue]],
        }),
        mergeCachedValues: async (_date, rows) => {
          operations.push('hset');
          expect(rows).toEqual([cachedValue]);
        },
        deleteCachedFields: async (_date, fields) => {
          operations.push('hdel');
          expect(fields).toEqual(['wrong-field']);
        },
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(operations).toEqual(['hset', 'hdel']);
  });

  test('excludes Start rows from the cache while persisting them', async () => {
    const riseRow = storedValue(singleRawFPLElementFixture.now_cost, 'Rise', 141);
    const startRow: StoredPlayerValue = {
      elementId: 999, // newly listed player; deliberately absent from bootstrap
      elementType: 4,
      eventId: 1,
      value: 55,
      changeDate,
      changeType: 'Start',
      lastValue: 0,
    };
    const mergeCachedValues = mock(async (_date: string, rows: PlayerValue[]) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        elementId: singleRawFPLElementFixture.id,
        changeType: 'Rise',
      });
    });
    const deleteCachedFields = mock(async () => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => [
          {
            elementId: singleRawFPLElementFixture.id,
            value: singleRawFPLElementFixture.now_cost,
            changeDate: '20260802',
          },
        ],
        findByChangeDate: async () => [riseRow, startRow],
        mergeCachedValues,
        deleteCachedFields,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(mergeCachedValues).toHaveBeenCalledTimes(1);
    expect(deleteCachedFields).not.toHaveBeenCalled();
  });

  test('a Start-only day deletes stale hash fields without merging', async () => {
    const persisted = storedValue(singleRawFPLElementFixture.now_cost, 'Start', 0);
    const staleValue: PlayerValue = {
      ...persisted,
      elementType: 4,
      elementTypeName: 'FWD',
      webName: 'Ghost Player',
      teamId: singleRawFPLElementFixture.team,
      teamName: 'Manchester City',
      teamShortName: 'MCI',
    };
    const mergeCachedValues = mock(async () => undefined);
    const deleteCachedFields = mock(async (_date: string, fields: string[]) => {
      expect(fields).toEqual(['999']);
    });
    const sync = createPlayerValuesSync(
      buildDependencies({
        findLatestForAllPlayers: async () => [
          {
            elementId: singleRawFPLElementFixture.id,
            value: singleRawFPLElementFixture.now_cost,
            changeDate: '20260802',
          },
        ],
        findByChangeDate: async () => [persisted],
        inspectCachedValues: async () => ({ fields: ['999'], entries: [['999', staleValue]] }),
        mergeCachedValues,
        deleteCachedFields,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(mergeCachedValues).not.toHaveBeenCalled();
    expect(deleteCachedFields).toHaveBeenCalledTimes(1);
  });

  test('repairs persisted history from retained player data after a roster omission', async () => {
    const currentElement = { ...singleRawFPLElementFixture, id: 2, code: 223095 };
    const persisted = storedValue(143, 'Rise', 142);
    const mergeCachedValues = mock(async (_date: string, rows: PlayerValue[]) => {
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        elementId: singleRawFPLElementFixture.id,
        webName: 'Retained Player',
        teamId: singleRawFPLElementFixture.team,
        value: 143,
      });
    });
    const findPlayersByIds = mock(async (ids: number[]) => {
      expect(ids).toEqual([singleRawFPLElementFixture.id]);
      return [
        {
          id: singleRawFPLElementFixture.id,
          code: singleRawFPLElementFixture.code,
          type: singleRawFPLElementFixture.element_type,
          teamId: singleRawFPLElementFixture.team,
          price: 143,
          startPrice: 142,
          firstName: 'Retained',
          secondName: 'Player',
          webName: 'Retained Player',
        },
      ];
    });
    const enqueuePlayerPrices = mock(async () => ({ id: 'player-prices-immediate' }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        getBootstrap: async () => ({ elements: [currentElement], teams: [] }) as never,
        findLatestForAllPlayers: async () => [
          {
            elementId: currentElement.id,
            value: currentElement.now_cost,
            changeDate: '20260802',
          },
        ],
        findByChangeDate: async () => [persisted],
        findPlayersByIds,
        mergeCachedValues,
        enqueuePlayerPrices,
      }),
    );

    expect(await sync(changeDate)).toEqual({ count: 0, eventId: 1 });
    expect(findPlayersByIds).toHaveBeenCalledTimes(1);
    expect(mergeCachedValues).toHaveBeenCalledTimes(1);
    expect(enqueuePlayerPrices).toHaveBeenCalledTimes(1);
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

    expect(await sync(changeDate)).toEqual({ count: 1, eventId: 1 });
  });
});
