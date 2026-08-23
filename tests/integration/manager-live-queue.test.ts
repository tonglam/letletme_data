import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  advanceManagerLiveHotState,
  MANAGER_LIVE_HOT_SCOPE_SECONDS,
  loadManagerLiveHotState,
  managerLiveHotStateKey,
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
  await redis.unlink(managerLiveHotStateKey(scope));
  await Promise.all([...createdJobIds].map((jobId) => managerLiveQueue.remove(jobId)));
  createdJobIds.clear();
}

beforeAll(cleanup);
beforeEach(cleanup);
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
    const ttl = await redis.ttl(managerLiveHotStateKey(scope));
    expect(ttl).toBeGreaterThan(MANAGER_LIVE_HOT_SCOPE_SECONDS - 10);
    expect(ttl).toBeLessThanOrEqual(MANAGER_LIVE_HOT_SCOPE_SECONDS);
    expect(first.data.generation).toBeString();
    expect(first.data.summaryRotationCursor).toBe(0);
    expect(first.data.classicStandingsCursorEpoch).toBe(0);
  });

  test('does not schedule a follow-up after the hot marker expires', async () => {
    const redis = await queueRedisSingleton.getClient();
    await redis.unlink(managerLiveHotStateKey(scope));
    const data: ManagerLiveJobData = {
      version: MANAGER_LIVE_JOB_VERSION,
      seasonId: scope.seasonId,
      seasonCode: scope.seasonCode,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      generation: 'old-generation',
      summaryRotationCursor: 0,
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
    const followup = await scheduleNextManagerLiveRefresh(
      markerJob.data,
      new Date(Date.now() + 75_000).toISOString(),
      7,
    );
    if (followup?.id) createdJobIds.add(followup.id);

    expect(followup).not.toBeNull();
    expect(followup?.data.classicStandingsPage).toBe(7);
    expect(followup?.data.summaryRotationCursor).toBe(1);
    expect(followup?.data.classicStandingsCursorEpoch).toBe(0);
    const redis = await queueRedisSingleton.getClient();
    await expect(loadManagerLiveHotState(redis, scope)).resolves.toMatchObject({
      generation: markerJob.data.generation,
      summaryRotationCursor: 1,
      classicStandingsPage: 7,
    });
    await expect(
      advanceManagerLiveHotState(
        redis,
        scope,
        markerJob.data.generation ?? 'missing-generation',
        markerJob.data.summaryRotationCursor ?? 0,
        7,
        1,
      ),
    ).resolves.toMatchObject({ summaryRotationCursor: 1, classicStandingsPage: 7 });
  });

  test('keeps completed classic cursor closed across stale page-one order and races', async () => {
    const markerJob = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt: new Date(Date.now() + 155_000),
    });
    if (markerJob.id) createdJobIds.add(markerJob.id);
    const redis = await queueRedisSingleton.getClient();
    const generation = markerJob.data.generation ?? 'missing-generation';
    const initialEpoch = markerJob.data.classicStandingsCursorEpoch ?? 0;

    const completed = await advanceManagerLiveHotState(
      redis,
      scope,
      generation,
      markerJob.data.summaryRotationCursor ?? 0,
      null,
      1,
      initialEpoch,
    );
    expect(completed).toMatchObject({
      classicStandingsPage: null,
      classicStandingsCursorEpoch: initialEpoch + 1,
    });

    // This is the delayed page-one job from the previous crawl. It must not
    // turn the explicit completion marker back into a later-page cursor.
    const stale = await advanceManagerLiveHotState(
      redis,
      scope,
      generation,
      markerJob.data.summaryRotationCursor ?? 0,
      7,
      1,
      initialEpoch,
    );
    expect(stale).toMatchObject({
      classicStandingsPage: null,
      classicStandingsCursorEpoch: initialEpoch + 1,
    });

    // A new crawl carries the new epoch. Redis must accept it even when it
    // races the stale update, while the stale epoch remains rejected.
    await Promise.all([
      advanceManagerLiveHotState(redis, scope, generation, 0, 7, 1, initialEpoch),
      advanceManagerLiveHotState(redis, scope, generation, 0, 7, 1, initialEpoch + 1),
    ]);
    await expect(loadManagerLiveHotState(redis, scope)).resolves.toMatchObject({
      classicStandingsPage: 7,
      classicStandingsCursorEpoch: initialEpoch + 1,
    });
  });

  test('keeps one same-bucket job while advancing the logical cursor', async () => {
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
    const continuation = await scheduleNextManagerLiveRefresh(request.data, runAt.toISOString(), 7);
    if (continuation?.id) createdJobIds.add(continuation.id);

    expect(continuation).not.toBeNull();
    expect(continuation?.id).toBe(request.id);
    expect(request.data.classicStandingsPage).toBeUndefined();
    expect(continuation?.data.summaryRotationCursor).toBe(1);
  });

  test('rejects an old generation after hot scope restart and resets both cursors atomically', async () => {
    const redis = await queueRedisSingleton.getClient();
    const oldJob = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt: new Date(Date.now() + 125_000),
    });
    if (oldJob.id) createdJobIds.add(oldJob.id);
    const oldState = await loadManagerLiveHotState(redis, scope);
    expect(oldState?.generation).toBe(oldJob.data.generation);

    await redis.unlink(managerLiveHotStateKey(scope));

    const newJob = await enqueueManagerLiveRefresh({
      season: TEST_SEASON,
      eventId: scope.eventId,
      entryIds: scope.entryIds,
      tournamentId: scope.tournamentId,
      runAt: new Date(Date.now() + 125_000),
    });
    if (newJob.id) createdJobIds.add(newJob.id);

    expect(newJob.data.generation).not.toBe(oldJob.data.generation);
    expect(newJob.data.summaryRotationCursor).toBe(0);
    expect(newJob.data.classicStandingsPage).toBeUndefined();
    await expect(
      advanceManagerLiveHotState(
        redis,
        scope,
        oldState?.generation ?? 'missing-old-generation',
        oldJob.data.summaryRotationCursor ?? 0,
        9,
        1,
      ),
    ).resolves.toBeNull();
    await expect(
      scheduleNextManagerLiveRefresh(oldJob.data, new Date(Date.now() + 30_000).toISOString(), 9),
    ).resolves.toBeNull();
    await expect(loadManagerLiveHotState(redis, scope)).resolves.toMatchObject({
      generation: newJob.data.generation,
      summaryRotationCursor: 0,
      classicStandingsPage: null,
    });
  });
});
