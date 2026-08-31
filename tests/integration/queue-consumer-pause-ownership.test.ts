import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  abortQueueConsumerPauseAcquisition,
  acquiringQueueConsumerPauseOwner,
  beginQueueConsumerPauseRelease,
  claimQueueConsumerPauseAcquisition,
  completeQueueConsumerPauseAcquisition,
  completeQueueConsumerPauseRelease,
  deploymentQueueConsumerPauseOwner,
  queueConsumerPauseOwnerKey,
  readQueueConsumerPauseOwner,
  releasingQueueConsumerPauseOwner,
} from '../../src/services/queue-governance.service';
import { queueRedisSingleton } from '../../src/queues/redis';

const QUEUE_NAME = `__codex-consumer-ownership-${process.pid}`;
const OWNER = deploymentQueueConsumerPauseOwner(`integration-owner-${process.pid}`);
const OTHER_OWNER = deploymentQueueConsumerPauseOwner(`integration-other-${process.pid}`);
const OWNER_KEY = queueConsumerPauseOwnerKey(QUEUE_NAME);

async function clearOwner(): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.unlink(OWNER_KEY);
}

beforeEach(clearOwner);

afterAll(async () => {
  await clearOwner();
  await queueRedisSingleton.disconnect();
});

describe('queue consumer pause ownership', () => {
  test('reserves before pause, completes idempotently, and fences release', async () => {
    expect(await claimQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await claimQueueConsumerPauseAcquisition(QUEUE_NAME, OTHER_OWNER)).toBe(false);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBe(
      acquiringQueueConsumerPauseOwner(OWNER),
    );

    expect(await completeQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await completeQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBe(OWNER);

    expect(await beginQueueConsumerPauseRelease(QUEUE_NAME, OWNER)).toBe(true);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBe(
      releasingQueueConsumerPauseOwner(OWNER),
    );
    expect(await completeQueueConsumerPauseRelease(QUEUE_NAME, OWNER)).toBe(true);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBeNull();
  });

  test('aborts only the matching interrupted acquisition', async () => {
    expect(await claimQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await abortQueueConsumerPauseAcquisition(QUEUE_NAME, OTHER_OWNER)).toBe(false);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBe(
      acquiringQueueConsumerPauseOwner(OWNER),
    );
    expect(await abortQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBeNull();
  });

  test('releases an interrupted acquisition without requiring a completed owner', async () => {
    expect(await claimQueueConsumerPauseAcquisition(QUEUE_NAME, OWNER)).toBe(true);
    expect(await beginQueueConsumerPauseRelease(QUEUE_NAME, OWNER)).toBe(true);
    expect(await completeQueueConsumerPauseRelease(QUEUE_NAME, OWNER)).toBe(true);
    expect(await readQueueConsumerPauseOwner(QUEUE_NAME)).toBeNull();
  });
});
