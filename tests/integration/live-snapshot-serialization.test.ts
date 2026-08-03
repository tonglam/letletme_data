import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';

import {
  withFixtureSyncSerialization,
  withLiveSnapshotSerialization,
} from '../../src/services/live-snapshot.service';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('live snapshot PostgreSQL serialization', () => {
  test('blocks the same event while allowing a different event to run', async () => {
    const eventId = 2_000_000_001;
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();
    const otherEventEntered = deferred();
    const sharedCheckedAt: Date[] = [];

    const first = withLiveSnapshotSerialization(eventId, async (checkedAt) => {
      sharedCheckedAt.push(checkedAt);
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const second = withLiveSnapshotSerialization(eventId, async () => {
      secondEntered.resolve();
    });
    const otherEvent = withLiveSnapshotSerialization(eventId + 1, async () => {
      otherEventEntered.resolve();
    });

    await otherEventEntered.promise;
    const sameEventState = await Promise.race([
      secondEntered.promise.then(() => 'entered' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 75)),
    ]);

    releaseFirst.resolve();
    await Promise.all([first, second, otherEvent]);

    expect(sameEventState).toBe('blocked');
    expect(sharedCheckedAt[0]).toBeInstanceOf(Date);
    expect(Number.isFinite(sharedCheckedAt[0]?.getTime())).toBe(true);
  });

  test('serializes fixture ownership discovery even for different events', async () => {
    const firstOperationEntered = deferred();
    const releaseFirst = deferred();
    const secondPrepareEntered = deferred();

    const first = withFixtureSyncSerialization(
      async () => ({ eventIds: [2_000_000_011], context: undefined }),
      async () => {
        firstOperationEntered.resolve();
        await releaseFirst.promise;
      },
    );
    await firstOperationEntered.promise;

    const second = withFixtureSyncSerialization(
      async () => {
        secondPrepareEntered.resolve();
        return { eventIds: [2_000_000_012], context: undefined };
      },
      async () => {},
    );
    const prepareState = await Promise.race([
      secondPrepareEntered.promise.then(() => 'entered' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 75)),
    ]);

    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(prepareState).toBe('blocked');
  });
});
