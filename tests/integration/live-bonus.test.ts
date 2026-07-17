import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, it, beforeAll } from 'bun:test';
import { redisSingleton } from '../../src/cache/singleton';
import { syncLiveBonusCache } from '../../src/services/live-bonus.service';
import { syncEvents } from '../../src/services/events.service';
import { syncTeams } from '../../src/services/teams.service';
import { syncFixtures } from '../../src/services/fixtures.service';
import { syncEventLives } from '../../src/services/event-lives.service';
import { syncLiveFixtureCache } from '../../src/services/live-fixtures.service';
import { getCurrentEvent } from '../../src/services/events.service';
import { getCurrentSeason } from '../../src/utils/conditions';

describe('Live Bonus Integration Tests', () => {
  let testEventId: number;

  beforeAll(async () => {
    // Ensure prerequisites are synced
    await syncEvents();
    await syncTeams();
    await syncFixtures();

    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found');
    }
    testEventId = currentEvent.id;

    // Ensure event lives are synced (required for bonus calculation)
    await syncEventLives(testEventId);

    // Ensure live fixtures are synced (required for playing map)
    await syncLiveFixtureCache(testEventId);
  });

  it('syncLiveBonusCache populates Redis hash with TTL -1', async () => {
    const result = await syncLiveBonusCache(testEventId);
    expect(result.eventId).toBe(testEventId);
    expect(result.teamCount).toBeGreaterThanOrEqual(0);

    const redis = await redisSingleton.getClient();
    const season = getCurrentSeason();
    const key = `LiveBonus:${season}:${testEventId}`;

    // Check key exists (may be empty if no playing fixtures or no bonus-eligible teams)
    const exists = await redis.exists(key);

    // If teamCount > 0, key should exist; if 0, key may or may not exist
    if (result.teamCount > 0) {
      expect(exists).toBe(1);

      // Check TTL is -1 (no expiration)
      const ttl = await redis.ttl(key);
      expect(ttl).toBe(-1);

      // Check hash has entries
      const hash = await redis.hgetall(key);
      expect(Object.keys(hash).length).toBeGreaterThan(0);

      // Verify structure
      const firstTeamId = Object.keys(hash)[0];
      const bonusData = JSON.parse(hash[firstTeamId]);
      expect(typeof bonusData).toBe('object');
      // Each entry should be elementId -> bonus (number)
      for (const [elementId, bonus] of Object.entries(bonusData)) {
        expect(Number.parseInt(elementId, 10)).toBeGreaterThan(0);
        expect([1, 2, 3]).toContain(bonus);
      }
    } else {
      // If no teams, key may not exist (cache.clear was called)
      // This is acceptable - the sync completed successfully
      expect(result.teamCount).toBe(0);
    }
  }, 30000);
});
