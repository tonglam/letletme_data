import { describe, expect, mock, test } from 'bun:test';

import type { StoredPlayerValue } from '../../src/repositories/player-values';
import {
  createPlayerValuesSync,
  type PlayerValuesSyncDependencies,
} from '../../src/services/player-values.service';
import { singleRawFPLElementFixture } from '../fixtures/player-values.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const changeDate = '20260803';
const captureTime = new Date('2026-08-03T01:00:00.000Z');
const rawTeam = {
  id: singleRawFPLElementFixture.team,
  name: 'Manchester City',
  short_name: 'MCI',
};

const sourceArtifact = {
  artifactId: '11111111-1111-4111-8111-111111111111',
  seasonId: TEST_SEASON.seasonId,
  sourceDay: changeDate,
  sourceTimezone: 'Asia/Shanghai' as const,
  sourceUrl: 'https://fantasy.premierleague.com/api/bootstrap-static/',
  bucket: 'fpl-raw-snapshots',
  objectKey: `fpl/bootstrap-static/${TEST_SEASON.seasonCode}/${changeDate}/${'a'.repeat(64)}.json`,
  sha256: 'a'.repeat(64),
  byteSize: 1,
  contentType: 'application/json' as const,
  retrievedAt: captureTime,
  schemaVersion: 1 as const,
  itemCounts: { events: 1, teams: 1, elements: 1, phases: 0 },
  createdAt: captureTime,
};

function storedValue(
  changeType: StoredPlayerValue['changeType'],
  value = singleRawFPLElementFixture.now_cost,
  lastValue = value - 1,
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
    resolveBootstrapSourceArtifact: async () =>
      ({
        artifact: sourceArtifact,
        bootstrap: { elements: [singleRawFPLElementFixture], teams: [rawTeam] },
        provenance: 'captured',
      }) as never,
    resolvePlayerSyncEvent: async () => ({ event: { id: 1 }, phase: 'current' }) as never,
    persistMarketSnapshot: async (_season, _eventId, snapshots) => ({
      snapshotDate: '2026-08-03',
      persistedCount: snapshots.length,
    }),
    findByChangeDate: async () => [],
    enqueuePlayerPrices: async () => ({ id: 'player-prices-immediate' }) as never,
    notify: async () => undefined,
    getCurrentChangeDate: () => changeDate,
    ...overrides,
  };
}

describe('daily player market snapshot synchronization', () => {
  test('loads a historical source day through the archive path without current event lookup', async () => {
    const resolveBootstrapSourceArtifact = mock(
      async () =>
        ({
          artifact: sourceArtifact,
          bootstrap: {
            elements: [singleRawFPLElementFixture],
            teams: [rawTeam],
            events: [{ id: 1, is_current: true, is_next: false, is_previous: false }],
          },
          provenance: 'archive',
        }) as never,
    );
    const resolvePlayerSyncEvent = mock(async () => null);
    const sync = createPlayerValuesSync(
      buildDependencies({
        resolveBootstrapSourceArtifact,
        resolvePlayerSyncEvent,
        getCurrentChangeDate: () => '20260804',
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({
      count: 0,
      sourceArtifactId: sourceArtifact.artifactId,
      sourceProvenance: 'archive',
    });
    expect(resolvePlayerSyncEvent).not.toHaveBeenCalled();
    expect(resolveBootstrapSourceArtifact).toHaveBeenCalledWith(TEST_SEASON, changeDate);
  });

  test('reports the explicit target before a later upstream failure', async () => {
    const resolvedEvents: number[] = [];
    const sync = createPlayerValuesSync(
      buildDependencies({
        resolveBootstrapSourceArtifact: async () => {
          throw new Error('bootstrap unavailable');
        },
      }),
    );

    await expect(
      sync(TEST_SEASON, changeDate, {
        onTargetEventResolved: (eventId) => resolvedEvents.push(eventId),
      }),
    ).rejects.toThrow('bootstrap unavailable');
    expect(resolvedEvents).toEqual([1]);
  });

  test('persists one complete canonical snapshot without writing a second values store', async () => {
    const persistMarketSnapshot = mock(
      async (
        _season,
        _eventId,
        snapshots: readonly unknown[],
        expectedCount: number,
        _sourceArtifactId: string,
      ) => ({
        snapshotDate: '2026-08-03',
        persistedCount: snapshots.length,
        expectedCount,
      }),
    );
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);
    const notify = mock(async (_message: string) => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({ persistMarketSnapshot, enqueuePlayerPrices, notify }),
    );

    const result = await sync(TEST_SEASON, changeDate);
    expect(result).toMatchObject({
      count: 0,
      eventId: 1,
      marketSnapshotCount: 1,
      requiredUnits: 1,
      succeededUnits: 1,
      failedUnits: 0,
    });
    expect(result.timings).toEqual({
      bootstrap: expect.any(Number),
      snapshotWrite: expect.any(Number),
      derivedView: expect.any(Number),
    });
    expect(persistMarketSnapshot).toHaveBeenCalledTimes(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[0]).toEqual(TEST_SEASON);
    expect(persistMarketSnapshot.mock.calls[0]?.[1]).toBe(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[2]).toHaveLength(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[3]).toBe(1);
    expect(persistMarketSnapshot.mock.calls[0]?.[4]).toBe(sourceArtifact.artifactId);
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  test('derives changed rows from reporting data, then enqueues reconciliation and notifies', async () => {
    const enqueuePlayerPrices = mock(async () => ({ id: 'prices' }) as never);
    const notify = mock(async (_message: string) => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Rise')],
        enqueuePlayerPrices,
        notify,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({
      count: 1,
      eventId: 1,
      marketSnapshotCount: 1,
    });
    expect(enqueuePlayerPrices).toHaveBeenCalledWith(TEST_SEASON, 'cascade', {
      changeDate,
      jobId: `player-prices-${changeDate}-immediate`,
      removeOnSettle: false,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]?.[0]).toContain('Haaland (MCI)');
  });

  test('can defer the dependent price enqueue until the parent transaction commits', async () => {
    const enqueuePlayerPrices = mock(async () => ({ id: 'prices' }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Rise')],
        enqueuePlayerPrices,
      }),
    );

    await expect(
      sync(TEST_SEASON, changeDate, { deferPriceSyncEnqueue: true }),
    ).resolves.toMatchObject({ count: 1 });
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
  });

  test('can defer notifications until publication is committed', async () => {
    const notify = mock(async (_message: string) => undefined);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Rise')],
        notify,
      }),
    );

    const result = await sync(TEST_SEASON, changeDate, { deferNotification: true });

    expect(notify).not.toHaveBeenCalled();
    expect(result.notificationMessage).toContain('Haaland (MCI)');
  });

  test('historical replay reconciles prices without sending stale change notifications', async () => {
    const notify = mock(async (_message: string) => undefined);
    const enqueuePlayerPrices = mock(async () => ({ id: 'prices' }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        getCurrentChangeDate: () => '20260804',
        resolveBootstrapSourceArtifact: async () =>
          ({
            artifact: sourceArtifact,
            bootstrap: {
              elements: [singleRawFPLElementFixture],
              teams: [rawTeam],
              events: [{ id: 1, is_current: true, is_next: false, is_previous: false }],
            },
            provenance: 'archive',
          }) as never,
        findByChangeDate: async () => [storedValue('Rise')],
        enqueuePlayerPrices,
        notify,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({
      count: 1,
      sourceProvenance: 'archive',
    });
    expect(enqueuePlayerPrices).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test('does not treat Start rows as a price change', async () => {
    const enqueuePlayerPrices = mock(async () => ({ id: 'unexpected' }) as never);
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Start', 142, 0)],
        enqueuePlayerPrices,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({ count: 0 });
    expect(enqueuePlayerPrices).not.toHaveBeenCalled();
  });

  test('rejects a persisted snapshot whose canonical calendar day differs', async () => {
    const findByChangeDate = mock(async () => []);
    const sync = createPlayerValuesSync(
      buildDependencies({
        persistMarketSnapshot: async () => ({
          snapshotDate: '2026-08-02',
          persistedCount: 1,
        }),
        findByChangeDate,
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).rejects.toThrow(
      'Market snapshot date 2026-08-02 does not match requested date 20260803',
    );
    expect(findByChangeDate).not.toHaveBeenCalled();
  });

  test('notification failure does not invalidate a complete canonical capture', async () => {
    const sync = createPlayerValuesSync(
      buildDependencies({
        findByChangeDate: async () => [storedValue('Faller', 140, 141)],
        notify: async () => {
          throw new Error('notification unavailable');
        },
      }),
    );

    await expect(sync(TEST_SEASON, changeDate)).resolves.toMatchObject({ count: 1 });
  });

  test('attaches bounded work and completed phase evidence to a failed attempt', async () => {
    const sync = createPlayerValuesSync(
      buildDependencies({
        persistMarketSnapshot: async () => {
          throw new Error('write failed');
        },
      }),
    );

    try {
      await sync(TEST_SEASON, changeDate);
      throw new Error('expected sync failure');
    } catch (error) {
      expect(error).toMatchObject({
        requiredUnits: 1,
        succeededUnits: 0,
        failedUnits: 1,
        timings: {
          bootstrap: expect.any(Number),
          snapshotWrite: expect.any(Number),
        },
      });
    }
  });
});
