import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  MANAGER_LIVE_HOT_SCOPE_SECONDS,
  loadManagerLiveClassicCursor,
  managerLiveClassicCursorKey,
  managerLiveHotScopeKey,
  writeManagerLiveClassicCursor,
  type ManagerLiveRefreshScope,
} from '../../src/domain/manager-live-refresh';
import {
  enqueueManagerLiveRefresh,
  scheduleNextManagerLiveRefresh,
} from '../../src/jobs/manager-live.jobs';
import {
  MANAGER_LIVE_JOB_VERSION,
  managerLiveQueue,
  type ManagerLiveJobData,
} from '../../src/queues/manager-live.queue';
import { queueRedisSingleton } from '../../src/queues/redis';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const scope: ManagerLiveRefreshScope = {
  seasonId: TEST_SEASON.seasonId,
  seasonCode: TEST_SEASON.seasonCode,
  eventId: 38,
  entryIds: [990001, 990002],
  tournamentId: 987654,
};
const createdJobIds = new Set<string>();

async function cleanup(): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.unlink(managerLiveHotScopeKey(scope), managerLiveClassicCursorKey(scope));
  await Promise.all([...createdJobIds].map((jobId) => managerLiveQueue.remove(jobId)));
  createdJobIds.clear();
}

beforeAll(cleanup);
afterAll(cleanup);

describe('manager live queue integration', () => {
  test('deduplicates one hot-scope refresh per 30-second bucket', async () => {
    const now = Date.now();
    const nextBucket = Math.floor(now / 30_000) * 30_000 + 35_000;
    const runAt = new Date(nextBucket);
    const first = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt,
    });
    const duplicate = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: [...scope.entryIds].reverse(),
      tournamentId: scope.tournamentId,
      runAt: new Date(runAt.getTime() + 1_000),
    });
    if (first.id) createdJobIds.add(first.id);
    if (duplicate.id) createdJobIds.add(duplicate.id);

    expect(duplicate.id).toBe(first.id);
    expect(await first.getState()).toBe('delayed');
    const redis = await queueRedisSingleton.getClient();
    const ttl = await redis.ttl(managerLiveHotScopeKey(scope));
    expect(ttl).toBeGreaterThan(MANAGER_LIVE_HOT_SCOPE_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(MANAGER_LIVE_HOT_SCOPE_SECONDS);
  });

  test('does not schedule a follow-up after the hot marker expires', async () => {
    const redis = await queueRedisSingleton.getClient();
    await redis.unlink(managerLiveHotScopeKey(scope));
    const data: ManagerLiveJobData = {
      version: MANAGER_LIVE_JOB_VERSION,
      seasonId: scope.seasonId,
      seasonCode: scope.seasonCode,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      source: 'followup',
      triggeredAt: new Date().toISOString(),
    };
    await expect(
      scheduleNextManagerLiveRefresh(data, new Date(Date.now() + 30_000).toISOString()),
    ).resolves.toBeNull();
  });

  test('carries a bounded classic standings cursor into the next bucket', async () => {
    const markerJob = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt: new Date(Date.now() + 35_000),
    });
    if (markerJob.id) createdJobIds.add(markerJob.id);
    const data: ManagerLiveJobData = {
      version: MANAGER_LIVE_JOB_VERSION,
      seasonId: scope.seasonId,
      seasonCode: scope.seasonCode,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      source: 'followup',
      triggeredAt: new Date().toISOString(),
    };

    const followup = await scheduleNextManagerLiveRefresh(
      data,
      new Date(Date.now() + 75_000).toISOString(),
      7,
    );
    if (followup?.id) createdJobIds.add(followup.id);

    expect(followup).not.toBeNull();
    expect(followup?.data.classicStandingsPage).toBe(7);
    const redis = await queueRedisSingleton.getClient();
    await expect(loadManagerLiveClassicCursor(redis, scope)).resolves.toBe(7);
  });

  test('keeps one same-bucket job while persisting the continuation cursor', async () => {
    const nextBucket = Math.floor(Date.now() / 30_000) * 30_000 + 95_000;
    const runAt = new Date(nextBucket);
    const request = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt,
    });
    if (request.id) createdJobIds.add(request.id);
    const data: ManagerLiveJobData = {
      version: MANAGER_LIVE_JOB_VERSION,
      seasonId: scope.seasonId,
      seasonCode: scope.seasonCode,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      source: 'followup',
      triggeredAt: new Date().toISOString(),
    };

    const continuation = await scheduleNextManagerLiveRefresh(data, runAt.toISOString(), 7);
    if (continuation?.id) createdJobIds.add(continuation.id);

    expect(continuation).not.toBeNull();
    expect(continuation?.id).toBe(request.id);
    expect(request.data.classicStandingsPage).toBeUndefined();
    const redis = await queueRedisSingleton.getClient();
    await expect(loadManagerLiveClassicCursor(redis, scope)).resolves.toBe(7);
  });

  test('clears an orphaned cursor when a new hot scope begins', async () => {
    const redis = await queueRedisSingleton.getClient();
    await redis.unlink(managerLiveHotScopeKey(scope));
    await writeManagerLiveClassicCursor(redis, scope, 7);

    const job = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt: new Date(Date.now() + 125_000),
    });
    if (job.id) createdJobIds.add(job.id);

    await expect(loadManagerLiveClassicCursor(redis, scope)).resolves.toBeNull();
  });
});
