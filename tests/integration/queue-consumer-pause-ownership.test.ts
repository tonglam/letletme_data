import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Queue } from 'bullmq';

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
  QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS,
} from '../../src/services/queue-governance.service';
import { queueRedisSingleton } from '../../src/queues/redis';
import { getQueueConnection } from '../../src/utils/queue';

const QUEUE_NAME = `__codex-consumer-ownership-${process.pid}`;
const OWNER = deploymentQueueConsumerPauseOwner(`integration-owner-${process.pid}`);
const OTHER_OWNER = deploymentQueueConsumerPauseOwner(`integration-other-${process.pid}`);
const OWNER_KEY = queueConsumerPauseOwnerKey(QUEUE_NAME);
const CONTROL_QUEUE_NAME = 'content-x-scan';
const CONTROL_OWNER_KEY = queueConsumerPauseOwnerKey(CONTROL_QUEUE_NAME);

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

  test('operator resumes a queue with an interrupted release marker', async () => {
    const queue = new Queue(CONTROL_QUEUE_NAME, { connection: getQueueConnection() });
    const redis = await queueRedisSingleton.getClient();
    try {
      await queue.resume();
      await redis.unlink(CONTROL_OWNER_KEY);
      await queue.pause();
      await redis.set(
        CONTROL_OWNER_KEY,
        releasingQueueConsumerPauseOwner(OWNER),
        'EX',
        QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS,
      );

      const result = Bun.spawnSync(
        [
          process.execPath,
          'scripts/assert-queue-quiescence.ts',
          '--consumer-mode',
          'RESUME',
          '--consumer-queue',
          CONTROL_QUEUE_NAME,
        ],
        {
          env: { ...process.env, DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN: '' },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      expect(
        result.exitCode,
        `${result.stderr?.toString() ?? ''}\n${result.stdout?.toString() ?? ''}`,
      ).toBe(0);
      expect(await queue.isPaused()).toBe(false);
      expect(await redis.get(CONTROL_OWNER_KEY)).toBeNull();
    } finally {
      await queue.resume();
      await redis.unlink(CONTROL_OWNER_KEY);
      await queue.close();
    }
  });
});
