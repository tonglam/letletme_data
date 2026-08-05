import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import {
  buildCoreSnapshotCachePlan,
  CORE_SNAPSHOT_PENDING_PUBLICATION_KEY,
  finalizeCoreSnapshotCachePublication,
  publishCoreSnapshotCache,
  readPendingCoreSnapshotCachePublication,
  rollbackCoreSnapshotCachePublication,
} from '../../src/cache/core-snapshot-cache';
import { clearStaleSeasonCache, resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';
import { eventFixtures, events, players } from '../../src/db/schemas/index.schema';
import { getDb, type DbHandle } from '../../src/db/singleton';
import { prepareCoreSnapshot, type CoreSnapshot } from '../../src/domain/core-snapshot';
import { allocateCoreSnapshotRevision } from '../../src/repositories/core-snapshot-authority';
import { createFixtureRepository } from '../../src/repositories/fixtures';
import { createPlayerRepository } from '../../src/repositories/players';
import {
  persistCoreSnapshot,
  persistCoreSnapshotWithFinalizer,
  readCoreSnapshotOrderingTimestamp,
} from '../../src/services/core-snapshot-persistence.service';
import {
  commitCoreSnapshotPublication,
  recoverPendingCoreSnapshotPublication,
} from '../../src/services/core-snapshot-publication.service';
import {
  syncCoreSnapshot,
  type CoreSnapshotMilestone,
} from '../../src/services/core-snapshot.service';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';

const describeAtomicity =
  process.env.RUN_CORE_SNAPSHOT_INTEGRATION === '1' ? describe : describe.skip;

describeAtomicity('core snapshot atomicity', () => {
  let snapshot: CoreSnapshot;

  beforeAll(() => {
    const input = buildCoreSnapshotFixture({ playerCount: 600 });
    snapshot = prepareCoreSnapshot(input.bootstrap, input.fixtures);
  });

  beforeEach(async () => {
    const redis = await redisSingleton.getClient();
    const transientKeys = await redis.keys('CoreSnapshot*');
    if (transientKeys.length > 0) await redis.del(...transientKeys);
    await redis.set('Season:active', snapshot.season);
    resetActiveSeasonMemo();
  });

  test('keeps the published cache view unchanged when staging fails', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    await redis.del(`Event:${snapshot.season}`);
    await redis.hset(`Event:${snapshot.season}`, 'sentinel', 'old-view');
    resetActiveSeasonMemo();

    await expect(
      publishCoreSnapshotCache(snapshot, {
        redis,
        publicationId: randomUUID(),
        afterStage: async () => {
          const stagingKeys = await redis.keys(`CoreSnapshotStage:${snapshot.season}:*`);
          expect(stagingKeys.length).toBeGreaterThan(0);
          for (const key of stagingKeys) expect(await redis.pttl(key)).toBeGreaterThan(0);
          throw new Error('injected staging failure');
        },
      }),
    ).rejects.toThrow('injected staging failure');

    expect(await redis.get('Season:active')).toBe(snapshot.season);
    expect(await redis.hgetall(`Event:${snapshot.season}`)).toEqual({ sentinel: 'old-view' });
    expect(await redis.keys(`CoreSnapshotStage:${snapshot.season}:*`)).toEqual([]);
  });

  test('checks every staged hash atomically before replacing any published key', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    await redis.del(`Event:${snapshot.season}`);
    await redis.hset(`Event:${snapshot.season}`, 'sentinel', 'old-view');

    await expect(
      publishCoreSnapshotCache(snapshot, {
        redis,
        publicationId: randomUUID(),
        afterStage: async () => {
          const stagingKeys = await redis.keys(`CoreSnapshotStage:${snapshot.season}:*`);
          expect(stagingKeys.length).toBeGreaterThan(1);
          await redis.del(stagingKeys[0]);
        },
      }),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_PUBLICATION_FAILED' });

    expect(await redis.get('Season:active')).toBe(snapshot.season);
    expect(await redis.hgetall(`Event:${snapshot.season}`)).toEqual({ sentinel: 'old-view' });
    expect(await redis.exists(CORE_SNAPSHOT_PENDING_PUBLICATION_KEY)).toBe(0);
  });

  test('declines publication when the active-season authority is malformed', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', 'bad-season');

    await expect(
      publishCoreSnapshotCache(snapshot, { publicationId: randomUUID(), redis }),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_ACTIVE_SEASON_INVALID' });
    expect(await redis.keys(`CoreSnapshotStage:${snapshot.season}:*`)).toEqual([]);
    expect(await redis.exists(CORE_SNAPSHOT_PENDING_PUBLICATION_KEY)).toBe(0);
  });

  test('publishes all core cache families together after persistence', async () => {
    const input = buildCoreSnapshotFixture({ playerCount: 600 });
    let bootstrapCalls = 0;
    let fixtureCalls = 0;
    const milestones: CoreSnapshotMilestone[] = [];

    const redis = await redisSingleton.getClient();
    await redis.set('EntryInfo:2526:sentinel', 'stale');

    const result = await syncCoreSnapshot({
      getBootstrap: async () => {
        bootstrapCalls += 1;
        return input.bootstrap;
      },
      getFixtures: async () => {
        fixtureCalls += 1;
        return input.fixtures;
      },
      getActiveSeason: async () => snapshot.season,
      readOrderingTimestamp: readCoreSnapshotOrderingTimestamp,
      reserveRevision: allocateCoreSnapshotRevision,
      createPublicationId: randomUUID,
      recoverPending: recoverPendingCoreSnapshotPublication,
      commit: commitCoreSnapshotPublication,
      cleanup: clearStaleSeasonCache,
      withPersistenceLock: async (operation) => operation(),
      onMilestone: (milestone) => milestones.push(milestone),
    });

    expect(result.outcome).toBe('ready');
    expect(bootstrapCalls).toBe(1);
    expect(fixtureCalls).toBe(1);
    expect(milestones).toEqual(['fetched', 'validated', 'locked', 'persisted', 'published']);
    expect(await redis.hlen(`Event:${snapshot.season}`)).toBe(38);
    expect(await redis.hlen(`Team:${snapshot.season}`)).toBe(20);
    expect(await redis.hlen(`Player:${snapshot.season}`)).toBe(600);
    expect(await redis.hlen(`Phase:${snapshot.season}`)).toBe(1);
    expect(await redis.keys(`Fixtures:${snapshot.season}:*`)).toHaveLength(38);
    expect(await redis.keys(`FixturesByTeam:${snapshot.season}:*`)).toHaveLength(20);
    expect(await redis.exists('EntryInfo:2526:sentinel')).toBe(0);
  });

  test('preserves fixture hashes owned by a published Live snapshot', async () => {
    const redis = await redisSingleton.getClient();
    const eventId = 1;
    const fixtureKey = `Fixtures:${snapshot.season}:${eventId}`;
    const metaKey = `LiveSnapshotMeta:${snapshot.season}:${eventId}`;
    await redis.del(fixtureKey, metaKey);
    await redis.hset(fixtureKey, 'sentinel', 'live-owned-view');
    await redis.set(metaKey, 'published');

    try {
      const publication = await publishCoreSnapshotCache(snapshot, {
        publicationId: randomUUID(),
        redis,
      });

      expect(publication.published).toBe(true);
      expect(publication.receipt?.finalKeys).not.toContain(fixtureKey);
      expect(publication.receipt?.backups.some((backup) => backup.key === fixtureKey)).toBe(false);
      expect(await redis.hgetall(fixtureKey)).toEqual({ sentinel: 'live-owned-view' });
      expect(await redis.hlen(`Event:${snapshot.season}`)).toBe(38);

      if (!publication.receipt) throw new Error('Core publication receipt is missing');
      await finalizeCoreSnapshotCachePublication(publication.receipt, redis);
    } finally {
      await redis.del(fixtureKey, metaKey);
    }
  });

  test('preserves a Live-owned durable fixture when a core fetch predates it', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const fixture = snapshot.fixtures.find((candidate) => candidate.event !== null)!;
    const sourceCheckedAt = await readCoreSnapshotOrderingTimestamp();
    const liveCheckedAt = new Date(sourceCheckedAt.getTime() + 60_000);
    let publishedFixture: CoreSnapshot['fixtures'][number] | undefined;

    try {
      await db
        .update(events)
        .set({ liveSnapshotCheckedAt: liveCheckedAt })
        .where(eq(events.id, fixture.event!));
      await db
        .update(eventFixtures)
        .set({
          minutes: 88,
          started: true,
          teamHScore: 7,
          teamAScore: 6,
          updatedAt: liveCheckedAt,
        })
        .where(eq(eventFixtures.id, fixture.id));

      const result = await persistCoreSnapshotWithFinalizer(snapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt,
        finalize: async (reconciled) => {
          publishedFixture = reconciled.fixtures.find((candidate) => candidate.id === fixture.id);
          return { published: true };
        },
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(result.status).toBe('committed');
      expect(publishedFixture).toMatchObject({
        minutes: 88,
        started: true,
        teamHScore: 7,
        teamAScore: 6,
      });
      expect(
        await db
          .select({ minutes: eventFixtures.minutes, teamHScore: eventFixtures.teamHScore })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, fixture.id)),
      ).toEqual([{ minutes: 88, teamHScore: 7 }]);
    } finally {
      await db
        .update(events)
        .set({ liveSnapshotCheckedAt: null })
        .where(eq(events.id, fixture.event!));
      await persistCoreSnapshot(snapshot);
    }
  });

  test('retires a durable scheduled fixture omitted by a complete core snapshot', async () => {
    const db = await getDb();
    const ghostFixtureId = 999_999;

    await persistCoreSnapshot(snapshot);
    await db.insert(eventFixtures).values({
      id: ghostFixtureId,
      code: ghostFixtureId,
      eventId: 1,
      finished: false,
      finishedProvisional: false,
      kickoffTime: new Date('2026-08-15T14:00:00.000Z'),
      minutes: 0,
      provisionalStartTime: false,
      started: false,
      teamAId: 1,
      teamAScore: null,
      teamHId: 1,
      teamHScore: null,
      stats: [],
      teamHDifficulty: 3,
      teamADifficulty: 3,
      pulseId: ghostFixtureId,
    });

    try {
      await persistCoreSnapshotWithFinalizer(snapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        finalize: async () => ({ published: true }),
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(
        await db
          .select({ eventId: eventFixtures.eventId })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, ghostFixtureId)),
      ).toEqual([{ eventId: null }]);
    } finally {
      await db.delete(eventFixtures).where(eq(eventFixtures.id, ghostFixtureId));
    }
  });

  test('retires an omitted fixture before inserting an upstream fixture-id replacement', async () => {
    const db = await getDb();
    const originalFixture = snapshot.fixtures.find((fixture) => fixture.event !== null)!;
    const replacementFixtureId = 999_998;
    const replacementFixture = {
      ...originalFixture,
      id: replacementFixtureId,
      code: originalFixture.code,
      pulseId: replacementFixtureId,
    };
    const replacementSnapshot: CoreSnapshot = {
      ...snapshot,
      fixtures: [
        ...snapshot.fixtures.filter((fixture) => fixture.id !== originalFixture.id),
        replacementFixture,
      ],
    };

    await persistCoreSnapshot(snapshot);

    try {
      await persistCoreSnapshotWithFinalizer(replacementSnapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        finalize: async () => ({ published: true }),
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(
        await db
          .select({ id: eventFixtures.id })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, originalFixture.id)),
      ).toEqual([]);
      expect(
        await db
          .select({ eventId: eventFixtures.eventId })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, replacementFixtureId)),
      ).toEqual([{ eventId: originalFixture.event }]);
    } finally {
      await db.delete(eventFixtures).where(eq(eventFixtures.id, replacementFixtureId));
      await persistCoreSnapshot(snapshot);
    }
  });

  test('preserves a newer durable player price in the published core snapshot', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const player = snapshot.players[0];
    const sourceCheckedAt = await readCoreSnapshotOrderingTimestamp();
    const priceCheckedAt = new Date(sourceCheckedAt.getTime() + 60_000);
    const newerPrice = player.price + 3;
    let publishedPrice: number | undefined;

    try {
      await db
        .update(players)
        .set({
          price: newerPrice,
          priceSourceCheckedAt: priceCheckedAt,
          updatedAt: priceCheckedAt,
        })
        .where(eq(players.id, player.id));

      const result = await persistCoreSnapshotWithFinalizer(snapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt,
        finalize: async (reconciled) => {
          publishedPrice = reconciled.players.find(
            (candidate) => candidate.id === player.id,
          )?.price;
          return { published: true };
        },
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(result.status).toBe('committed');
      expect(publishedPrice).toBe(newerPrice);
      expect(
        await db.select({ price: players.price }).from(players).where(eq(players.id, player.id)),
      ).toEqual([{ price: newerPrice }]);
    } finally {
      await persistCoreSnapshot(snapshot);
    }
  });

  test('does not mistake an earlier core upsert for newer price evidence', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const player = snapshot.players[0];
    const sourceCheckedAt = await readCoreSnapshotOrderingTimestamp();
    const candidatePrice = player.price + 5;
    let publishedPrice: number | undefined;

    const earlierCoreSnapshot: CoreSnapshot = {
      ...snapshot,
      players: snapshot.players.map((candidate) =>
        candidate.id === player.id ? { ...candidate, price: player.price - 1 } : candidate,
      ),
    };
    const winningSnapshot: CoreSnapshot = {
      ...snapshot,
      players: snapshot.players.map((candidate) =>
        candidate.id === player.id ? { ...candidate, price: candidatePrice } : candidate,
      ),
    };

    try {
      await createPlayerRepository(db).upsertBatch(earlierCoreSnapshot.players);

      const result = await persistCoreSnapshotWithFinalizer(winningSnapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt,
        finalize: async (reconciled) => {
          publishedPrice = reconciled.players.find(
            (candidate) => candidate.id === player.id,
          )?.price;
          return { published: true };
        },
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(result.status).toBe('committed');
      expect(publishedPrice).toBe(candidatePrice);
      expect(
        await db.select({ price: players.price }).from(players).where(eq(players.id, player.id)),
      ).toEqual([{ price: candidatePrice }]);
    } finally {
      await persistCoreSnapshot(snapshot);
    }
  });

  test('carries newer price authority through successive waiting core revisions', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const player = snapshot.players[0];
    const firstCoreCheckedAt = await readCoreSnapshotOrderingTimestamp();
    const secondCoreCheckedAt = new Date(firstCoreCheckedAt.getTime() + 1_000);
    const priceCheckedAt = new Date(firstCoreCheckedAt.getTime() + 2_000);
    const partialPrice = player.price + 7;
    const firstCoreSnapshot: CoreSnapshot = {
      ...snapshot,
      players: snapshot.players.map((candidate) =>
        candidate.id === player.id ? { ...candidate, price: player.price + 1 } : candidate,
      ),
    };
    const secondCoreSnapshot: CoreSnapshot = {
      ...snapshot,
      players: snapshot.players.map((candidate) =>
        candidate.id === player.id ? { ...candidate, price: player.price + 2 } : candidate,
      ),
    };

    try {
      await db
        .update(players)
        .set({ price: partialPrice, priceSourceCheckedAt: priceCheckedAt })
        .where(eq(players.id, player.id));

      const first = await persistCoreSnapshotWithFinalizer(firstCoreSnapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt: firstCoreCheckedAt,
        finalize: async () => ({ published: true }),
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });
      expect(first.status).toBe('committed');
      expect(
        await db
          .select({
            price: players.price,
            priceSourceCheckedAt: players.priceSourceCheckedAt,
          })
          .from(players)
          .where(eq(players.id, player.id)),
      ).toEqual([{ price: partialPrice, priceSourceCheckedAt: priceCheckedAt }]);

      let publishedPrice: number | undefined;
      const second = await persistCoreSnapshotWithFinalizer(secondCoreSnapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt: secondCoreCheckedAt,
        finalize: async (reconciled) => {
          publishedPrice = reconciled.players.find(
            (candidate) => candidate.id === player.id,
          )?.price;
          return { published: true };
        },
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(second.status).toBe('committed');
      expect(publishedPrice).toBe(partialPrice);
      expect(
        await db
          .select({
            price: players.price,
            priceSourceCheckedAt: players.priceSourceCheckedAt,
          })
          .from(players)
          .where(eq(players.id, player.id)),
      ).toEqual([{ price: partialPrice, priceSourceCheckedAt: priceCheckedAt }]);
    } finally {
      await createPlayerRepository(db).upsertBatch(snapshot.players);
    }
  });

  test('rolls database writes back when cache publication fails', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const before = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    const candidate: CoreSnapshot = {
      ...snapshot,
      events: snapshot.events.map((event) =>
        event.id === 1 ? { ...event, name: 'Must Roll Back On Cache Failure' } : event,
      ),
    };
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    await redis.del(`Event:${snapshot.season}`);
    await redis.hset(`Event:${snapshot.season}`, 'sentinel', 'old-view');
    resetActiveSeasonMemo();

    const publicationId = randomUUID();
    await expect(
      persistCoreSnapshotWithFinalizer(candidate, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId,
        previousActiveSeason: snapshot.season,
        finalize: () =>
          publishCoreSnapshotCache(candidate, {
            publicationId,
            redis,
            afterStage: async () => {
              throw new Error('injected cache publication failure');
            },
          }),
        compensate: async (publication) => {
          if (publication.receipt) {
            await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
          }
        },
        afterCommit: async (publication) => {
          if (publication.receipt) {
            await finalizeCoreSnapshotCachePublication(publication.receipt, redis);
          }
        },
      }),
    ).rejects.toThrow('injected cache publication failure');

    const after = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    expect(after).toEqual(before);
    expect(await redis.hgetall(`Event:${snapshot.season}`)).toEqual({ sentinel: 'old-view' });
    expect(await redis.exists(CORE_SNAPSHOT_PENDING_PUBLICATION_KEY)).toBe(0);
  });

  test('compensates Redis when the database transaction fails after publication', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const before = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    const candidate: CoreSnapshot = {
      ...snapshot,
      events: snapshot.events.map((event) =>
        event.id === 1 ? { ...event, name: 'Must Compensate Cache' } : event,
      ),
    };
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    await redis.del(`Event:${snapshot.season}`);
    await redis.hset(`Event:${snapshot.season}`, 'sentinel', 'old-view');
    const publicationId = randomUUID();

    await db.execute(sql`
      CREATE OR REPLACE FUNCTION public.fail_core_snapshot_authority_for_test()
      RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'injected authority commit failure';
      END
      $$
    `);
    await db.execute(sql`
      DROP TRIGGER IF EXISTS fail_core_snapshot_authority_for_test
      ON public.core_snapshot_authority
    `);
    await db.execute(sql`
      CREATE TRIGGER fail_core_snapshot_authority_for_test
      BEFORE INSERT OR UPDATE ON public.core_snapshot_authority
      FOR EACH ROW EXECUTE FUNCTION public.fail_core_snapshot_authority_for_test()
    `);
    try {
      await expect(
        persistCoreSnapshotWithFinalizer(candidate, {
          revision: await allocateCoreSnapshotRevision(),
          publicationId,
          previousActiveSeason: snapshot.season,
          finalize: () => publishCoreSnapshotCache(candidate, { publicationId, redis }),
          compensate: async (publication) => {
            if (publication.receipt) {
              await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
            }
          },
          afterCommit: async (publication) => {
            if (publication.receipt) {
              await finalizeCoreSnapshotCachePublication(publication.receipt, redis);
            }
          },
        }),
      ).rejects.toThrow('injected authority commit failure');
    } finally {
      await db.execute(sql`
        DROP TRIGGER IF EXISTS fail_core_snapshot_authority_for_test
        ON public.core_snapshot_authority
      `);
      await db.execute(sql`DROP FUNCTION IF EXISTS public.fail_core_snapshot_authority_for_test()`);
    }

    const after = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    expect(after).toEqual(before);
    expect(await redis.hgetall(`Event:${snapshot.season}`)).toEqual({ sentinel: 'old-view' });
    expect(await redis.exists(CORE_SNAPSHOT_PENDING_PUBLICATION_KEY)).toBe(0);
  });

  test('reconciles a durable commit whose client response is lost', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const candidate: CoreSnapshot = {
      ...snapshot,
      events: snapshot.events.map((event) =>
        event.id === 1 ? { ...event, name: 'Committed Despite Lost Response' } : event,
      ),
    };
    const redis = await redisSingleton.getClient();
    const publicationId = randomUUID();
    let rejectNextTransactionResponse = true;
    let compensated = false;
    const ambiguousCommitDb = {
      transaction: async <T>(operation: Parameters<DbHandle['transaction']>[0]) => {
        const result = await db.transaction(operation);
        if (rejectNextTransactionResponse) {
          rejectNextTransactionResponse = false;
          throw new Error('simulated lost PostgreSQL commit response');
        }
        return result as T;
      },
    } as unknown as DbHandle;

    const result = await persistCoreSnapshotWithFinalizer(
      candidate,
      {
        revision: await allocateCoreSnapshotRevision(),
        publicationId,
        previousActiveSeason: snapshot.season,
        finalize: () => publishCoreSnapshotCache(candidate, { publicationId, redis }),
        compensate: async (publication) => {
          compensated = true;
          if (publication.receipt) {
            await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
          }
        },
        afterCommit: async (publication) => {
          if (publication.receipt) {
            await finalizeCoreSnapshotCachePublication(publication.receipt, redis);
          }
        },
      },
      ambiguousCommitDb,
    );

    expect(result.status).toBe('committed');
    expect(compensated).toBe(false);
    expect(await readPendingCoreSnapshotCachePublication(redis)).toBeNull();
    expect(await db.select({ name: events.name }).from(events).where(eq(events.id, 1))).toEqual([
      { name: 'Committed Despite Lost Response' },
    ]);
  });

  test('preserves the recovery receipt while an ambiguous commit cannot be queried', async () => {
    const db = await getDb();
    const redis = await redisSingleton.getClient();
    const publicationId = randomUUID();
    let transactionCalls = 0;
    const unavailableAfterCommitDb = {
      transaction: async (operation: Parameters<DbHandle['transaction']>[0]) => {
        transactionCalls += 1;
        if (transactionCalls > 1) {
          throw new Error('simulated PostgreSQL reconciliation outage');
        }
        await db.transaction(operation);
        throw new Error('simulated lost PostgreSQL commit response');
      },
    } as unknown as DbHandle;

    await expect(
      persistCoreSnapshotWithFinalizer(
        snapshot,
        {
          revision: await allocateCoreSnapshotRevision(),
          publicationId,
          previousActiveSeason: snapshot.season,
          finalize: () => publishCoreSnapshotCache(snapshot, { publicationId, redis }),
          compensate: async (publication) => {
            if (publication.receipt) {
              await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
            }
          },
          afterCommit: async (publication) => {
            if (publication.receipt) {
              await finalizeCoreSnapshotCachePublication(publication.receipt, redis);
            }
          },
        },
        unavailableAfterCommitDb,
      ),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_COMMIT_OUTCOME_UNKNOWN' });

    expect((await readPendingCoreSnapshotCachePublication(redis))?.publicationId).toBe(
      publicationId,
    );

    // A derivative failure must leave the committed receipt available for the
    // next recovery attempt instead of declaring the publication complete.
    await redis.set('Season:active', 'bad-season');
    resetActiveSeasonMemo();
    await expect(recoverPendingCoreSnapshotPublication()).rejects.toThrow(
      'Season:active is missing or malformed',
    );
    expect((await readPendingCoreSnapshotCachePublication(redis))?.publicationId).toBe(
      publicationId,
    );

    await redis.set('Season:active', snapshot.season);
    resetActiveSeasonMemo();
    expect(await recoverPendingCoreSnapshotPublication()).toBe('finalized');
    expect(await readPendingCoreSnapshotCachePublication(redis)).toBeNull();
  });

  test('serializes recovery behind an in-flight database publication', async () => {
    const redis = await redisSingleton.getClient();
    const publicationId = randomUUID();
    let signalPublished!: () => void;
    let releaseTransaction!: () => void;
    const published = new Promise<void>((resolve) => {
      signalPublished = resolve;
    });
    const transactionRelease = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const persistence = persistCoreSnapshotWithFinalizer(snapshot, {
      revision: await allocateCoreSnapshotRevision(),
      publicationId,
      previousActiveSeason: snapshot.season,
      finalize: async () => {
        const publication = await publishCoreSnapshotCache(snapshot, { publicationId, redis });
        signalPublished();
        await transactionRelease;
        return publication;
      },
      compensate: async (publication) => {
        if (publication.receipt) {
          await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
        }
      },
      // Leave the receipt for the concurrently waiting recovery attempt.
      afterCommit: async () => undefined,
    });
    await published;

    const recovery = recoverPendingCoreSnapshotPublication();
    const prematureResult = await Promise.race([
      recovery.then(() => 'resolved'),
      new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 100)),
    ]);
    expect(prematureResult).toBe('waiting');

    releaseTransaction();
    await expect(persistence).resolves.toMatchObject({ status: 'committed' });
    expect(await recovery).toBe('finalized');
    expect(await redis.hlen(`Event:${snapshot.season}`)).toBe(38);
    expect(await readPendingCoreSnapshotCachePublication(redis)).toBeNull();
  });

  test('recovers a committed publication left pending by a worker crash', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    const publicationId = randomUUID();

    await expect(
      persistCoreSnapshotWithFinalizer(snapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId,
        previousActiveSeason: snapshot.season,
        finalize: () => publishCoreSnapshotCache(snapshot, { publicationId, redis }),
        compensate: async (publication) => {
          if (publication.receipt) {
            await rollbackCoreSnapshotCachePublication(publication.receipt, redis);
          }
        },
        afterCommit: async () => {
          throw new Error('simulated worker crash after database commit');
        },
      }),
    ).rejects.toThrow('simulated worker crash');

    expect((await readPendingCoreSnapshotCachePublication(redis))?.publicationId).toBe(
      publicationId,
    );
    expect(await recoverPendingCoreSnapshotPublication()).toBe('finalized');
    expect(await readPendingCoreSnapshotCachePublication(redis)).toBeNull();
    expect(await redis.hlen(`Event:${snapshot.season}`)).toBe(38);
  });

  test('rolls back an uncommitted pending publication during recovery', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    await redis.del(`Event:${snapshot.season}`);
    await redis.hset(`Event:${snapshot.season}`, 'sentinel', 'old-view');
    const publication = await publishCoreSnapshotCache(snapshot, {
      publicationId: randomUUID(),
      redis,
    });
    expect(publication.published).toBe(true);

    expect(await recoverPendingCoreSnapshotPublication()).toBe('rolled_back');
    expect(await redis.hgetall(`Event:${snapshot.season}`)).toEqual({ sentinel: 'old-view' });
    expect(await readPendingCoreSnapshotCachePublication(redis)).toBeNull();
  });

  test('rollback preserves partial writers that completed after the core cache swap', async () => {
    const db = await getDb();
    const redis = await redisSingleton.getClient();
    const player = snapshot.players[0];
    const omittedPlayer = snapshot.players.at(-1);
    const fixture = snapshot.fixtures.find((candidate) => candidate.event === 1);
    if (!player || !omittedPlayer || !fixture) {
      throw new Error('Core fixture is missing recovery test rows');
    }

    await persistCoreSnapshot(snapshot);
    await redis.set('Season:active', snapshot.season);
    const fixtureKey = `Fixtures:${snapshot.season}:1`;
    const playerKey = `Player:${snapshot.season}`;
    const metaKey = `LiveSnapshotMeta:${snapshot.season}:1`;
    const derivedKeys = [
      `EventLive:${snapshot.season}:1`,
      `LiveFixture:${snapshot.season}:1`,
      `LiveFixtureV2:${snapshot.season}:1`,
      `LiveBonus:${snapshot.season}:1`,
      `LiveBonusV2:${snapshot.season}:1`,
    ];
    await redis.del(metaKey, ...derivedKeys);

    const baselineSnapshot = {
      ...snapshot,
      players: snapshot.players.filter((candidate) => candidate.id !== omittedPlayer.id),
    };
    const baseline = await publishCoreSnapshotCache(baselineSnapshot, {
      publicationId: randomUUID(),
      redis,
    });
    if (!baseline.receipt) throw new Error('Baseline publication receipt is missing');
    await finalizeCoreSnapshotCachePublication(baseline.receipt, redis);
    expect(await redis.hexists(playerKey, String(omittedPlayer.id))).toBe(0);

    const pending = await publishCoreSnapshotCache(snapshot, {
      publicationId: randomUUID(),
      redis,
    });
    if (!pending.receipt) throw new Error('Pending publication receipt is missing');
    expect(await redis.hexists(playerKey, String(omittedPlayer.id))).toBe(1);

    const durablePrice = player.price + 7;
    const durableFixture = {
      ...fixture,
      finished: true,
      finishedProvisional: true,
      started: true,
      teamHScore: 4,
      teamAScore: 3,
    };
    const checkedAt = new Date('2026-08-04T13:00:00.000Z');
    await db
      .update(players)
      .set({ price: durablePrice, priceSourceCheckedAt: checkedAt, updatedAt: checkedAt })
      .where(eq(players.id, player.id));
    await db
      .update(eventFixtures)
      .set({
        finished: durableFixture.finished,
        finishedProvisional: durableFixture.finishedProvisional,
        started: durableFixture.started,
        teamHScore: durableFixture.teamHScore,
        teamAScore: durableFixture.teamAScore,
      })
      .where(eq(eventFixtures.id, fixture.id));
    await db.update(events).set({ liveSnapshotCheckedAt: checkedAt }).where(eq(events.id, 1));

    await redis.hset(
      playerKey,
      String(player.id),
      JSON.stringify({ ...player, price: durablePrice }),
    );
    await redis.del(fixtureKey);
    await redis.hset(fixtureKey, String(fixture.id), JSON.stringify(durableFixture));
    for (const key of derivedKeys) await redis.hset(key, 'sentinel', 'durable-live-view');
    await redis.set(
      metaKey,
      JSON.stringify({
        schemaVersion: 1,
        season: snapshot.season,
        eventId: 1,
        revision: 'd'.repeat(24),
        state: 'settled',
        publishedAt: checkedAt.toISOString(),
        checkedAt: checkedAt.toISOString(),
        eventLiveCount: 1,
        fixtureCount: snapshot.fixtures.filter((candidate) => candidate.event === 1).length,
        fixtureTeamCount: 2,
        bonusTeamCount: 0,
      }),
    );

    expect(await recoverPendingCoreSnapshotPublication()).toBe('rolled_back');
    const recoveredPlayer = JSON.parse(
      (await redis.hget(playerKey, String(player.id))) ?? '{}',
    ) as {
      price?: number;
    };
    const recoveredFixture = JSON.parse(
      (await redis.hget(fixtureKey, String(fixture.id))) ?? '{}',
    ) as { teamHScore?: number; teamAScore?: number };
    expect(recoveredPlayer.price).toBe(durablePrice);
    expect(await redis.hlen(playerKey)).toBe(baselineSnapshot.players.length);
    expect(await redis.hexists(playerKey, String(omittedPlayer.id))).toBe(0);
    expect(recoveredFixture).toMatchObject({ teamHScore: 4, teamAScore: 3 });
    expect(await redis.exists(metaKey)).toBe(1);
    for (const key of derivedKeys) {
      expect(await redis.hget(key, 'sentinel')).toBe('durable-live-view');
    }

    await redis.del(metaKey, ...derivedKeys);
  });

  test('does not let an older same-season revision republish', async () => {
    const redis = await redisSingleton.getClient();
    await redis.set('Season:active', snapshot.season);
    const newerRevision = await allocateCoreSnapshotRevision();
    const committed = await persistCoreSnapshotWithFinalizer(snapshot, {
      revision: newerRevision,
      publicationId: randomUUID(),
      previousActiveSeason: snapshot.season,
      finalize: async () => ({ published: true }),
      compensate: async () => undefined,
      afterCommit: async () => undefined,
    });
    expect(committed.status).toBe('committed');

    let finalized = false;
    const stale = await persistCoreSnapshotWithFinalizer(snapshot, {
      revision: newerRevision - 1,
      publicationId: randomUUID(),
      previousActiveSeason: snapshot.season,
      finalize: async () => {
        finalized = true;
        return { published: true };
      },
      compensate: async () => undefined,
      afterCommit: async () => undefined,
    });
    expect(stale.status).toBe('stale');
    expect(finalized).toBe(false);
  });

  test('fails safely at the separately gated destructive season-rollover boundary', async () => {
    let finalized = false;
    await expect(
      persistCoreSnapshotWithFinalizer(
        { ...snapshot, season: '2728' },
        {
          revision: await allocateCoreSnapshotRevision(),
          publicationId: randomUUID(),
          previousActiveSeason: snapshot.season,
          finalize: async () => {
            finalized = true;
            return { published: true };
          },
          compensate: async () => undefined,
          afterCommit: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_MANUAL_ROLLOVER_REQUIRED' });
    expect(finalized).toBe(false);
  });

  test('rejects same-season identity reassignment before any upsert', async () => {
    const conflicting: CoreSnapshot = {
      ...snapshot,
      teams: snapshot.teams.map((team) =>
        team.id === 1 ? { ...team, code: snapshot.teams[1].code } : team,
      ),
    };
    let finalized = false;
    await expect(
      persistCoreSnapshotWithFinalizer(conflicting, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        finalize: async () => {
          finalized = true;
          return { published: true };
        },
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'CORE_SNAPSHOT_IDENTITY_CONFLICT' });
    expect(finalized).toBe(false);
  });

  test('rolls back every earlier core table write when a later fixture write fails', async () => {
    const db = await getDb();
    const before = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    expect(before).toHaveLength(1);

    const invalidSnapshot: CoreSnapshot = {
      ...snapshot,
      events: snapshot.events.map((event) =>
        event.id === 1 ? { ...event, name: 'Must Roll Back' } : event,
      ),
      fixtures: snapshot.fixtures.map((fixture, index) =>
        index === 0 ? { ...fixture, teamH: 999 } : fixture,
      ),
    };

    await expect(persistCoreSnapshot(invalidSnapshot)).rejects.toThrow();
    const after = await db.select({ name: events.name }).from(events).where(eq(events.id, 1));
    expect(after).toEqual(before);
  });

  test('retires a previously scheduled fixture while retaining it for cache publication', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const unscheduledFixtureId = snapshot.fixtures[0].id;
    const candidate: CoreSnapshot = {
      ...snapshot,
      fixtures: snapshot.fixtures.map((fixture, index) =>
        index === 0 ? { ...fixture, event: null } : fixture,
      ),
    };

    const persistence = await persistCoreSnapshot(candidate);
    expect(persistence.fixtures).toBe(candidate.fixtures.length - 1);
    expect(
      await db
        .select({ id: eventFixtures.id, eventId: eventFixtures.eventId })
        .from(eventFixtures)
        .where(eq(eventFixtures.id, unscheduledFixtureId)),
    ).toEqual([{ id: unscheduledFixtureId, eventId: null }]);
    expect(
      buildCoreSnapshotCachePlan(candidate).hashes.get(`Fixtures:${snapshot.season}:unscheduled`),
    ).toHaveProperty(String(unscheduledFixtureId));
  });

  test('retires a scheduled fixture omitted from the complete snapshot', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const sourceFixture = snapshot.fixtures.find((fixture) => fixture.event !== null);
    if (!sourceFixture) throw new Error('Core snapshot fixture requires one scheduled row');
    const unusedAwayTeam = snapshot.teams.find(
      (team) =>
        team.id !== sourceFixture.teamH &&
        !snapshot.fixtures.some(
          (fixture) =>
            fixture.event === sourceFixture.event &&
            fixture.teamH === sourceFixture.teamH &&
            fixture.teamA === team.id,
        ),
    );
    if (!unusedAwayTeam) throw new Error('Core snapshot requires an unused fixture pairing');
    const ghostFixture = {
      ...sourceFixture,
      id: sourceFixture.id + 1_000_000,
      code: sourceFixture.code + 1_000_000,
      pulseId: sourceFixture.pulseId + 1_000_000,
      teamA: unusedAwayTeam.id,
    };

    try {
      await createFixtureRepository(db).upsertBatch([ghostFixture]);

      await persistCoreSnapshot(snapshot);

      expect(
        await db
          .select({ id: eventFixtures.id, eventId: eventFixtures.eventId })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, ghostFixture.id)),
      ).toEqual([{ id: ghostFixture.id, eventId: null }]);
    } finally {
      await db.delete(eventFixtures).where(eq(eventFixtures.id, ghostFixture.id));
    }
  });

  test('preserves an omitted fixture owned by newer durable evidence', async () => {
    const db = await getDb();
    await persistCoreSnapshot(snapshot);
    const sourceFixture = snapshot.fixtures.find((fixture) => fixture.event !== null);
    if (!sourceFixture || sourceFixture.event === null) {
      throw new Error('Core snapshot fixture requires one scheduled row');
    }
    const unusedAwayTeam = snapshot.teams.find(
      (team) =>
        team.id !== sourceFixture.teamH &&
        !snapshot.fixtures.some(
          (fixture) =>
            fixture.event === sourceFixture.event &&
            fixture.teamH === sourceFixture.teamH &&
            fixture.teamA === team.id,
        ),
    );
    if (!unusedAwayTeam) throw new Error('Core snapshot requires an unused fixture pairing');
    const ghostFixture = {
      ...sourceFixture,
      id: sourceFixture.id + 1_000_001,
      code: sourceFixture.code + 1_000_001,
      pulseId: sourceFixture.pulseId + 1_000_001,
      teamA: unusedAwayTeam.id,
    };
    const sourceCheckedAt = await readCoreSnapshotOrderingTimestamp();
    const liveCheckedAt = new Date(sourceCheckedAt.getTime() + 60_000);

    try {
      await createFixtureRepository(db).upsertBatch([ghostFixture]);
      await db
        .update(events)
        .set({ liveSnapshotCheckedAt: liveCheckedAt })
        .where(eq(events.id, sourceFixture.event));

      await persistCoreSnapshotWithFinalizer(snapshot, {
        revision: await allocateCoreSnapshotRevision(),
        publicationId: randomUUID(),
        previousActiveSeason: snapshot.season,
        sourceCheckedAt,
        finalize: async () => ({ published: true }),
        compensate: async () => undefined,
        afterCommit: async () => undefined,
      });

      expect(
        await db
          .select({ id: eventFixtures.id, eventId: eventFixtures.eventId })
          .from(eventFixtures)
          .where(eq(eventFixtures.id, ghostFixture.id)),
      ).toEqual([{ id: ghostFixture.id, eventId: sourceFixture.event }]);
    } finally {
      await db
        .update(events)
        .set({ liveSnapshotCheckedAt: null })
        .where(eq(events.id, sourceFixture.event));
      await db.delete(eventFixtures).where(eq(eventFixtures.id, ghostFixture.id));
    }
  });
});
