import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';

import { resetActiveSeasonMemo, setActiveCacheSeason } from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';
import { events } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import {
  withFixtureSyncSerialization,
  withLiveSnapshotDurableEventsWriteFence,
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

  test('blocks active-season rollover until in-flight live commits finish', async () => {
    const eventId = 2_000_000_006;
    const snapshotEntered = deferred();
    const releaseSnapshot = deferred();
    const redis = await redisSingleton.getClient();
    const previousActiveSeason = await redis.get('Season:active');
    await redis.set('Season:active', '2526');
    resetActiveSeasonMemo();

    const snapshot = withLiveSnapshotSerialization(eventId, async () => {
      snapshotEntered.resolve();
      await releaseSnapshot.promise;
    });
    await snapshotEntered.promise;

    const rollover = setActiveCacheSeason('2627');
    const rolloverState = await Promise.race([
      rollover.then(() => 'advanced' as const),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 75)),
    ]);

    try {
      expect(rolloverState).toBe('blocked');
      expect(await redis.get('Season:active')).toBe('2526');
      releaseSnapshot.resolve();
      await Promise.all([snapshot, rollover]);
      expect(await redis.get('Season:active')).toBe('2627');
    } finally {
      releaseSnapshot.resolve();
      await snapshot.catch(() => undefined);
      await rollover.catch(() => undefined);
      if (previousActiveSeason === null) {
        await redis.del('Season:active');
      } else {
        await redis.set('Season:active', previousActiveSeason);
      }
      resetActiveSeasonMemo();
    }
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

  test('multi-event fixture fence rolls back every earlier claim when one event is newer', async () => {
    const firstEventId = 2_000_000_031;
    const secondEventId = 2_000_000_032;
    const firstOriginal = new Date('2026-08-04T01:00:00.000Z');
    const incoming = new Date('2026-08-04T01:00:01.000Z');
    const secondWinner = new Date('2026-08-04T01:00:02.000Z');
    const db = await getDb();
    await db.delete(events).where(eq(events.id, firstEventId));
    await db.delete(events).where(eq(events.id, secondEventId));
    await db.insert(events).values([
      {
        id: firstEventId,
        name: 'Fixture fence rollback first',
        liveSnapshotCheckedAt: firstOriginal,
      },
      {
        id: secondEventId,
        name: 'Fixture fence rollback winner',
        liveSnapshotCheckedAt: secondWinner,
      },
    ]);
    const writes: string[] = [];

    try {
      const result = await withLiveSnapshotDurableEventsWriteFence(
        [secondEventId, firstEventId],
        incoming,
        async () => {
          writes.push('stale-fixtures');
        },
      );

      expect(result).toMatchObject({
        accepted: false,
        rejectedEventId: secondEventId,
        winnerCheckedAt: secondWinner,
      });
      expect(writes).toEqual([]);
      const stored = await db
        .select({ id: events.id, checkedAt: events.liveSnapshotCheckedAt })
        .from(events)
        .where(eq(events.id, firstEventId));
      expect(stored).toEqual([{ id: firstEventId, checkedAt: firstOriginal }]);
    } finally {
      await db.delete(events).where(eq(events.id, firstEventId));
      await db.delete(events).where(eq(events.id, secondEventId));
    }
  });

  test('rejects a fixture payload fetched before a competing live snapshot commits', async () => {
    const eventId = 2_000_000_041;
    const fixtureFetchEntered = deferred();
    const releaseFixtureFetch = deferred();
    const db = await getDb();
    await db.delete(events).where(eq(events.id, eventId));
    await db.insert(events).values({ id: eventId, name: 'Fixture fetch ordering fence' });
    const writes: string[] = [];

    try {
      const fixtureWrite = withFixtureSyncSerialization(
        async () => {
          fixtureFetchEntered.resolve();
          await releaseFixtureFetch.promise;
          return { eventIds: [eventId], context: undefined };
        },
        async (_context, fixtureCheckedAt, lockedEventIds) =>
          withLiveSnapshotDurableEventsWriteFence(lockedEventIds, fixtureCheckedAt, async () => {
            writes.push('fixture');
          }),
      );
      await fixtureFetchEntered.promise;

      const liveWrite = await withLiveSnapshotSerialization(eventId, async (liveCheckedAt) =>
        withLiveSnapshotDurableWriteFence(eventId, liveCheckedAt, async () => {
          writes.push('live');
        }),
      );
      releaseFixtureFetch.resolve();
      const fixtureResult = await fixtureWrite;

      expect(liveWrite.accepted).toBe(true);
      expect(fixtureResult).toMatchObject({
        accepted: false,
        rejectedEventId: eventId,
        winnerCheckedAt: liveWrite.winnerCheckedAt,
      });
      expect(writes).toEqual(['live']);
    } finally {
      releaseFixtureFetch.resolve();
      await db.delete(events).where(eq(events.id, eventId));
    }
  });
});
