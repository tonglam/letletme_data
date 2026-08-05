import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';

import { deriveSeasonFromFixtures } from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';
import { fplClient } from '../../src/clients/fpl';
import { eventFixtures } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { fixtureRepository } from '../../src/repositories/fixtures';
import { getCurrentEvent } from '../../src/services/events.service';
import { syncAllGameweeks, syncFixtures } from '../../src/services/fixtures.service';
import { transformFixture } from '../../src/transformers/fixtures';
import { ensureTeams } from './helpers/reference-data';

// This file calls the real FPL API during setup and recovery verification.
setDefaultTimeout(30000);

describe('Fixtures Integration Tests', () => {
  beforeAll(async () => {
    // Fixtures reference events and both home/away teams. These calls use the
    // real FPL API, so keep the hook aligned with the explicit network-test
    // budgets below rather than Bun's five-second unit-test default.
    await ensureTeams();
    await syncFixtures();
  });

  test('syncFixtures persists data to database', async () => {
    const db = await getDb();
    const rows = await db.select({ id: eventFixtures.id }).from(eventFixtures);
    expect(rows.length).toBeGreaterThan(0);
  });

  test('counts fixtures whose existing ownership is successfully cleared', async () => {
    const originalGetFixtures = fplClient.getFixtures;
    const fetchFixtures = originalGetFixtures.bind(fplClient);
    const fullFixtureFeed = await fetchFixtures();
    const assignedFixture = fullFixtureFeed.find((fixture) => fixture.event !== null);
    if (!assignedFixture) throw new Error('FPL fixture feed contains no assigned fixture');

    const correctedFeed = fullFixtureFeed.map((fixture) =>
      fixture.id === assignedFixture.id ? { ...fixture, event: null } : fixture,
    );
    const correctedFixtures = correctedFeed.map(transformFixture);
    const unscheduledIds = correctedFixtures
      .filter((fixture) => fixture.event === null)
      .map((fixture) => fixture.id);
    const persistedUnscheduled = await fixtureRepository.findEventIdsByFixtureIds(unscheduledIds);
    const expectedCount =
      correctedFixtures.filter((fixture) => fixture.event !== null).length +
      persistedUnscheduled.size;

    try {
      fplClient.getFixtures = async () => correctedFeed;

      const result = await syncFixtures();

      expect(result.count).toBe(expectedCount);
      expect(result.count).toBeGreaterThan(
        correctedFixtures.filter((fixture) => fixture.event !== null).length,
      );
    } finally {
      fplClient.getFixtures = originalGetFixtures;
      await syncFixtures();
    }
  }, 30000);

  test('should have valid fixture structure', async () => {
    const db = await getDb();
    const fixtures = await db.select().from(eventFixtures).limit(1);
    expect(fixtures.length).toBeGreaterThan(0);

    const fixture = fixtures[0];
    expect(typeof fixture.id).toBe('number');
    expect(typeof fixture.code).toBe('number');
    expect(typeof fixture.finished).toBe('boolean');
    expect(typeof fixture.kickoffTime).toBe('object'); // Date or null
  });

  test('should have fixtures with event assignment', async () => {
    const db = await getDb();
    const fixtures = await db.select().from(eventFixtures).limit(5);

    expect(fixtures.length).toBeGreaterThan(0);

    // Some fixtures may not be assigned to an event yet
    const assignedFixtures = fixtures.filter((f) => f.eventId !== null);
    expect(assignedFixtures.length).toBeGreaterThan(0);
  });

  test('event-scoped sync recovers a fixture omitted after moving to another event', async () => {
    const originalGetFixtures = fplClient.getFixtures;
    const fetchFixtures = originalGetFixtures.bind(fplClient);
    const fullFixtureFeed = await fetchFixtures();
    const movedFixture = fullFixtureFeed.find(
      (fixture) => fixture.event !== null && fixture.event >= 1 && fixture.event <= 38,
    );
    if (!movedFixture || movedFixture.event === null) {
      throw new Error('FPL fixture feed contains no event-assigned fixture for recovery test');
    }

    const sourceEventId = movedFixture.event;
    const destinationEventId = sourceEventId === 38 ? 37 : sourceEventId + 1;
    const season = deriveSeasonFromFixtures(fullFixtureFeed);
    if (!season) throw new Error('Could not derive cache season from the FPL fixture feed');

    const movedFullFixtureFeed = fullFixtureFeed.map((fixture) =>
      fixture.id === movedFixture.id ? { ...fixture, event: destinationEventId } : fixture,
    );
    const requestedEvents: Array<number | undefined> = [];
    const redis = await redisSingleton.getClient();
    const sourceMetaKey = `LiveSnapshotMeta:${season}:${sourceEventId}`;
    const destinationMetaKey = `LiveSnapshotMeta:${season}:${destinationEventId}`;
    const snapshotMeta = (eventId: number, revision: string) =>
      JSON.stringify({
        schemaVersion: 1,
        season,
        eventId,
        revision,
        state: 'scheduled',
        publishedAt: '2026-08-04T00:00:00.000Z',
        checkedAt: '2026-08-04T00:00:00.000Z',
        eventLiveCount: 1,
        fixtureCount: 1,
        fixtureTeamCount: 1,
        bonusTeamCount: 0,
      });

    try {
      // These pointers represent complete published snapshots. A fixture move
      // makes both event identities stale, so both must disappear before the
      // database/cache ownership change is exposed.
      await redis.mset(
        sourceMetaKey,
        snapshotMeta(sourceEventId, 'a'.repeat(24)),
        destinationMetaKey,
        snapshotMeta(destinationEventId, 'b'.repeat(24)),
      );

      fplClient.getFixtures = async (requestedEventId?: number) => {
        requestedEvents.push(requestedEventId);
        return requestedEventId === undefined
          ? movedFullFixtureFeed
          : movedFullFixtureFeed.filter((fixture) => fixture.event === requestedEventId);
      };

      const result = await syncFixtures(sourceEventId);

      expect(requestedEvents).toEqual([sourceEventId, undefined]);
      expect(result.count).toBe(
        movedFullFixtureFeed.filter((fixture) => fixture.event !== null).length,
      );

      const sourceFixtures = await fixtureRepository.findByEvent(sourceEventId);
      const destinationFixtures = await fixtureRepository.findByEvent(destinationEventId);
      expect(sourceFixtures.some((fixture) => fixture.id === movedFixture.id)).toBe(false);
      expect(destinationFixtures.some((fixture) => fixture.id === movedFixture.id)).toBe(true);

      expect(await redis.exists(sourceMetaKey)).toBe(0);
      expect(await redis.exists(destinationMetaKey)).toBe(0);
      expect(
        await redis.hexists(`Fixtures:${season}:${sourceEventId}`, String(movedFixture.id)),
      ).toBe(0);
      expect(
        await redis.hexists(`Fixtures:${season}:${destinationEventId}`, String(movedFixture.id)),
      ).toBe(1);
    } finally {
      fplClient.getFixtures = originalGetFixtures;
      // Restore the real upstream ownership for subsequent integration tests
      // and leave no sentinel snapshot state behind even when an assertion fails.
      try {
        await syncFixtures();
      } finally {
        await redis.del(sourceMetaKey, destinationMetaKey);
      }
    }
  }, 30000);

  test('full sync reconciles a non-current snapshot-owned event correction', async () => {
    const originalGetFixtures = fplClient.getFixtures;
    const fetchFixtures = originalGetFixtures.bind(fplClient);
    const fullFixtureFeed = await fetchFixtures();
    const currentEventId = (await getCurrentEvent())?.id;
    const targetRawFixture = fullFixtureFeed.find(
      (fixture) => fixture.event !== null && fixture.event !== currentEventId,
    );
    if (!targetRawFixture || targetRawFixture.event === null) {
      throw new Error('FPL fixture feed contains no non-current assigned fixture');
    }
    const eventId = targetRawFixture.event;
    const season = deriveSeasonFromFixtures(fullFixtureFeed);
    if (!season) throw new Error('Could not derive cache season from the FPL fixture feed');

    const redis = await redisSingleton.getClient();
    const fixturesKey = `Fixtures:${season}:${eventId}`;
    const metaKey = `LiveSnapshotMeta:${season}:${eventId}`;
    const derivedKeys = [
      `EventLive:${season}:${eventId}`,
      `LiveFixture:${season}:${eventId}`,
      `LiveFixtureV2:${season}:${eventId}`,
      `LiveBonus:${season}:${eventId}`,
      `LiveBonusV2:${season}:${eventId}`,
    ];
    const expectedFixture = transformFixture(targetRawFixture);
    const cachedRaw = await redis.hget(fixturesKey, String(targetRawFixture.id));
    if (!cachedRaw) throw new Error(`Missing fixture cache field ${targetRawFixture.id}`);
    const staleFixture = JSON.parse(cachedRaw) as { teamHScore: number | null };
    staleFixture.teamHScore = (expectedFixture.teamHScore ?? 0) + 99;
    const fixtureCount = fullFixtureFeed.filter((fixture) => fixture.event === eventId).length;
    const snapshotMeta = JSON.stringify({
      schemaVersion: 1,
      season,
      eventId,
      revision: 'c'.repeat(24),
      state: 'settled',
      publishedAt: '2026-08-04T00:00:00.000Z',
      checkedAt: '2026-08-04T00:00:00.000Z',
      eventLiveCount: 1,
      fixtureCount,
      fixtureTeamCount: 1,
      bonusTeamCount: 0,
    });

    try {
      const seed = redis.multi();
      seed.set(metaKey, snapshotMeta);
      seed.hset(fixturesKey, String(targetRawFixture.id), JSON.stringify(staleFixture));
      for (const key of derivedKeys) seed.hset(key, 'sentinel', 'stale');
      await seed.exec();

      fplClient.getFixtures = async (requestedEventId?: number) =>
        requestedEventId === undefined
          ? fullFixtureFeed
          : fullFixtureFeed.filter((fixture) => fixture.event === requestedEventId);

      await syncFixtures();

      expect(await redis.exists(metaKey)).toBe(0);
      for (const key of derivedKeys.slice(0, 4)) {
        expect(await redis.exists(key)).toBe(0);
      }
      const correctedRaw = await redis.hget(fixturesKey, String(targetRawFixture.id));
      if (!correctedRaw) throw new Error('Corrected fixture source hash was not republished');
      const correctedFixture = JSON.parse(correctedRaw) as { teamHScore: number | null };
      expect(correctedFixture.teamHScore).toBe(expectedFixture.teamHScore);
    } finally {
      fplClient.getFixtures = originalGetFixtures;
      await redis.del(metaKey, ...derivedKeys);
    }
  }, 30000);

  test.skip('syncAllGameweeks returns summary for each event', async () => {
    // Skip: Long-running operation, tested in production
    const summary = await syncAllGameweeks();
    expect(summary.totalCount).toBeGreaterThan(0);
    expect(summary.perGameweek.length).toBeGreaterThan(0);
  });
});
