import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { syncEvents } from '../../src/services/events.service';
import { syncFixtures } from '../../src/services/fixtures.service';
import { syncTeams } from '../../src/services/teams.service';
import { getCurrentEvent } from '../../src/services/events.service';
import { syncLiveFixtureCache } from '../../src/services/live-fixtures.service';
import { getCurrentSeason } from '../../src/utils/conditions';

describe('Live Fixtures Integration Tests', () => {
  let eventId: number;

  beforeAll(async () => {
    // Ensure base data exists (events/teams/fixtures)
    await syncEvents();
    await syncTeams();

    const currentEvent = await getCurrentEvent();
    if (!currentEvent) throw new Error('No current event found');
    eventId = currentEvent.id;

    await syncFixtures(eventId);
  });

  test('syncLiveFixtureCache populates Redis hash with TTL -1', async () => {
    const result = await syncLiveFixtureCache(eventId);
    expect(result.eventId).toBe(eventId);

    const season = getCurrentSeason();
    const key = `LiveFixture:${season}:${eventId}`;

    const redis = await redisSingleton.getClient();
    const exists = await redis.exists(key);
    expect(exists).toBe(1);

    const ttl = await redis.ttl(key);
    // TTL -1 means no expiration
    expect(ttl).toBe(-1);

    const size = await redis.hlen(key);
    expect(size).toBeGreaterThan(0);

    const sampleTeamId = (await redis.hkeys(key))[0];
    const sample = await redis.hget(key, sampleTeamId);
    expect(sample).not.toBeNull();

    const parsed = JSON.parse(sample!);
    expect(parsed).toHaveProperty('Playing');
    expect(parsed).toHaveProperty('Not_Start');
    expect(parsed).toHaveProperty('Finished');
  }, 30000);
});
