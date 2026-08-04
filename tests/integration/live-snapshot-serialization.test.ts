import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { events } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import {
  withFixtureSyncSerialization,
  withLiveSnapshotDurableWriteFence,
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

  test('durable writes reject an older checkedAt after a newer winner commits', async () => {
    const eventId = 2_000_000_021;
    const db = await getDb();
    await db.delete(events).where(eq(events.id, eventId));
    await db.insert(events).values({ id: eventId, name: 'Live snapshot fence integration' });
    const writes: string[] = [];

    try {
      const newer = await withLiveSnapshotDurableWriteFence(
        eventId,
        new Date('2026-08-04T01:00:02.000Z'),
        async () => {
          writes.push('newer');
        },
      );
      const older = await withLiveSnapshotDurableWriteFence(
        eventId,
        new Date('2026-08-04T01:00:01.000Z'),
        async () => {
          writes.push('older');
        },
      );

      expect(newer.accepted).toBe(true);
      expect(older).toMatchObject({
        accepted: false,
        winnerCheckedAt: new Date('2026-08-04T01:00:02.000Z'),
      });
      expect(writes).toEqual(['newer']);
      const [stored] = await db
        .select({ checkedAt: events.liveSnapshotCheckedAt })
        .from(events)
        .where(eq(events.id, eventId));
      expect(stored.checkedAt).toEqual(new Date('2026-08-04T01:00:02.000Z'));
    } finally {
      await db.delete(events).where(eq(events.id, eventId));
    }
  });
});
