import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import Redis from 'ioredis';

import {
  publishCoreSnapshotCache,
  readCoreSnapshotCache,
} from '../../src/cache/core-snapshot-cache';
import { eventRepository } from '../../src/repositories/events';
import { fixtureRepository } from '../../src/repositories/fixtures';
import { phaseRepository } from '../../src/repositories/phases';
import { playerRepository } from '../../src/repositories/players';
import { seasonRepository } from '../../src/repositories/seasons';
import { teamRepository } from '../../src/repositories/teams';

const SCOPE_PATTERN = 'llm:v3:data:fpl:core:2526:*';
const PUBLICATION_ID = '30000000-0000-4000-8000-000000000001';
const REVISION = 9_000_000_001;
const b0Test = process.env.RUN_B0_ACCEPTANCE === '1' ? test : test.skip;

function redisClient(): Redis {
  return new Redis({
    host: process.env.CACHE_REDIS_HOST,
    port: Number(process.env.CACHE_REDIS_PORT),
    password: process.env.CACHE_REDIS_PASSWORD,
    db: Number(process.env.CACHE_REDIS_DB),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
}

async function unlinkPattern(redis: Redis): Promise<void> {
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', SCOPE_PATTERN, 'COUNT', 100);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

describe('B0 full core Redis publication budget', () => {
  const redis = redisClient();

  beforeAll(async () => {
    await redis.connect();
    await unlinkPattern(redis);
  });

  afterAll(async () => {
    await unlinkPattern(redis);
    await redis.quit();
  });

  b0Test('reads and atomically publishes the complete 2526 core within five minutes', async () => {
    const startedAt = performance.now();
    const season = await seasonRepository.requireByCode('2526');
    const [events, teams, players, phases, fixtures] = await Promise.all([
      eventRepository.findAll(season),
      teamRepository.findAll(season),
      playerRepository.findAll(season),
      phaseRepository.findAll(season),
      fixtureRepository.findAll(season),
    ]);
    const publication = await publishCoreSnapshotCache(
      {
        season: season.seasonCode,
        events,
        teams,
        players,
        phases,
        fixtures,
      },
      {
        revision: REVISION,
        publicationId: PUBLICATION_ID,
        sourceCheckedAt: new Date('2026-08-09T01:00:00.000Z'),
        redis,
      },
    );
    const elapsedMs = performance.now() - startedAt;

    expect(publication.published).toBe(true);
    expect(events).toHaveLength(38);
    expect(teams).toHaveLength(20);
    expect(players).toHaveLength(841);
    expect(fixtures).toHaveLength(380);
    expect(elapsedMs).toBeLessThanOrEqual(5 * 60 * 1_000);

    const active = await readCoreSnapshotCache('2526', redis);
    expect(active?.manifest).toMatchObject({
      publicationId: PUBLICATION_ID,
      revision: REVISION,
    });
    expect(active?.events).toHaveLength(38);
    expect(active?.teams).toHaveLength(20);
    expect(active?.players).toHaveLength(841);
    expect(active?.fixtures).toHaveLength(380);
    for (const item of active?.manifest.items ?? []) {
      expect(await redis.pttl(item.key)).toBe(-1);
    }

    // Keep one machine-readable benchmark line in the acceptance artifact.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        benchmark: 'full-fpl-core-redis-publication',
        season: season.seasonCode,
        elapsedMs: Number(elapsedMs.toFixed(2)),
        counts: {
          events: events.length,
          teams: teams.length,
          players: players.length,
          phases: phases.length,
          fixtures: fixtures.length,
        },
      }),
    );
  });
});
