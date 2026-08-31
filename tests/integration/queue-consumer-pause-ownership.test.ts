import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';

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
import { prepareQueuedFormalRunsForDeployment } from '../../src/content/acquisition/formal-run-repository';
import { contentAcquisitionRuns } from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
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
  await databaseSingleton.disconnect();
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

  test('operator resume does not steal an in-flight pause acquisition', async () => {
    const queue = new Queue(CONTROL_QUEUE_NAME, { connection: getQueueConnection() });
    const redis = await queueRedisSingleton.getClient();
    const acquiring = acquiringQueueConsumerPauseOwner(OWNER);
    try {
      await queue.resume();
      await redis.set(CONTROL_OWNER_KEY, acquiring, 'EX', QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS);

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
      const outputLine = (result.stdout?.toString() ?? '')
        .trim()
        .split('\n')
        .reverse()
        .find((line) => line.trimStart().startsWith('{'));
      expect(JSON.parse(outputLine ?? '{}')).toMatchObject({
        mode: 'RESUME',
        paused: false,
        owner: 'ACQUIRING',
        owned: false,
        released: false,
      });
      expect(await queue.isPaused()).toBe(false);
      expect(await redis.get(CONTROL_OWNER_KEY)).toBe(acquiring);
    } finally {
      await queue.resume();
      await redis.unlink(CONTROL_OWNER_KEY);
      await queue.close();
    }
  });

  test('prepares only confirmed pending formal-run leases during deployment preparation', async () => {
    const db = await getDb();
    const deliveredRunId = randomUUID();
    const undeliveredRunId = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    try {
      await db.insert(contentAcquisitionRuns).values([
        {
          runId: deliveredRunId,
          windowStart: now,
          windowEnd: leaseExpiresAt,
          idempotencyKey: `codex-deployment-lease-${deliveredRunId}`,
          status: 'PENDING',
          leaseExpiresAt,
          enqueueConfirmedAt: now,
        },
        {
          runId: undeliveredRunId,
          windowStart: now,
          windowEnd: leaseExpiresAt,
          idempotencyKey: `codex-deployment-lease-${undeliveredRunId}`,
          status: 'PENDING',
          leaseExpiresAt,
        },
      ]);
      expect(await prepareQueuedFormalRunsForDeployment({ db })).toBe(1);
      const runs = await db
        .select({
          runId: contentAcquisitionRuns.runId,
          leaseExpiresAt: contentAcquisitionRuns.leaseExpiresAt,
        })
        .from(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.runId, deliveredRunId));
      expect(runs).toEqual([{ runId: deliveredRunId, leaseExpiresAt: null }]);
      const pendingRuns = await db
        .select({
          runId: contentAcquisitionRuns.runId,
          leaseExpiresAt: contentAcquisitionRuns.leaseExpiresAt,
        })
        .from(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.runId, undeliveredRunId));
      expect(pendingRuns[0]?.leaseExpiresAt?.getTime()).toBe(leaseExpiresAt.getTime());
    } finally {
      await db
        .delete(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.runId, deliveredRunId));
      await db
        .delete(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.runId, undeliveredRunId));
    }
  });
});
