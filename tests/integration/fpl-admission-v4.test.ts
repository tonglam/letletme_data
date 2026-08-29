import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import {
  acquireFplRequest,
  closeFplCriticalWindow,
  openFplCriticalWindow,
  readFplAdmissionStats,
} from '../../src/utils/fpl-admission';
import { queueRedisSingleton } from '../../src/queues/redis';

const PREFIX =
  process.env.FPL_ADMISSION_KEY_PREFIX?.trim() || `llm:fpl:admission:integration:${process.pid}`;

async function unlinkPrefix(): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) await redis.unlink(...keys);
  } while (cursor !== '0');
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error('Timed out waiting for distributed admission state');
}

async function readyContenderCount(): Promise<number> {
  const redis = await queueRedisSingleton.getClient();
  let cursor = '0';
  let count = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}:ready:*`, 'COUNT', 200);
    cursor = next;
    count += keys.length;
  } while (cursor !== '0');
  return count;
}

function spawnContender(priority: 'deadline-critical' | 'live' | 'bulk') {
  const source = `
    import { acquireFplRequest } from './src/utils/fpl-admission.ts';
    import { queueRedisSingleton } from './src/queues/redis.ts';
    const priority = process.env.CHILD_PRIORITY;
    const prefix = process.env.FPL_ADMISSION_KEY_PREFIX;
    const redis = await queueRedisSingleton.getClient();
    await redis.set(prefix + ':ready:' + process.pid, '1', 'PX', 10000);
    while (!(await redis.get(prefix + ':gate'))) await Bun.sleep(5);
    const lease = await acquireFplRequest(priority, { deadlineAt: Date.now() + 5000 });
    const grantedAt = Date.now();
    console.log(JSON.stringify({ priority, grantedAt }));
    await Bun.sleep(50);
    await lease.release();
    await queueRedisSingleton.disconnect();
  `;
  return Bun.spawn([process.execPath, '-e', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      FPL_ADMISSION_KEY_PREFIX: PREFIX,
      CHILD_PRIORITY: priority,
      FPL_ADMISSION_TEST_MODE: 'false',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

async function childResult(child: ReturnType<typeof spawnContender>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Admission contender failed: ${stderr || stdout}`);
  const line = stdout
    .trim()
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) throw new Error(`Admission contender returned no result: ${stderr}`);
  return JSON.parse(line) as { priority: string; grantedAt: number };
}

describe('distributed FPL admission v4', () => {
  beforeEach(async () => {
    await unlinkPrefix();
  });

  afterAll(async () => {
    await unlinkPrefix();
    await queueRedisSingleton.disconnect();
  });

  test('prioritizes critical across three independent processes and stays within caps', async () => {
    const owner = `integration-${process.pid}`;
    const held = await Promise.all([
      ...Array.from({ length: 3 }, () => acquireFplRequest('bulk')),
      ...Array.from({ length: 2 }, () => acquireFplRequest('live')),
    ]);
    await openFplCriticalWindow({ owner, untilMs: Date.now() + 3_000 });
    const children = (['live', 'bulk', 'deadline-critical'] as const).map(spawnContender);

    await waitFor(async () => (await readyContenderCount()) === children.length);
    const redis = await queueRedisSingleton.getClient();
    await redis.set(`${PREFIX}:gate`, '1', 'PX', 10_000);
    await waitFor(async () => {
      const stats = await readFplAdmissionStats();
      return (
        stats.queuedByPriority.live === 1 &&
        stats.queuedByPriority.bulk === 1 &&
        stats.queuedByPriority['deadline-critical'] === 1
      );
    });
    const beforeRelease = await readFplAdmissionStats();
    expect(beforeRelease.inflight).toBe(5);
    expect(beforeRelease.inflight).toBeLessThanOrEqual(beforeRelease.maxInflight);

    await held[0]!.release();
    const resultsPromise = Promise.all(children.map(childResult));
    await waitFor(async () => (await readFplAdmissionStats()).criticalInflight === 1);
    const atCriticalGrant = await readFplAdmissionStats();
    expect(atCriticalGrant.inflight).toBeLessThanOrEqual(atCriticalGrant.maxInflight);

    await Promise.all(held.slice(1).map((lease) => lease.release()));
    const results = await resultsPromise;
    const ordered = [...results].sort((left, right) => left.grantedAt - right.grantedAt);
    expect(ordered.map((item) => item.priority)).toEqual(['deadline-critical', 'live', 'bulk']);
    await closeFplCriticalWindow(owner);
  }, 15_000);

  test('cancels a distributed waiter without leaving queue state behind', async () => {
    const held = await Promise.all([
      ...Array.from({ length: 3 }, () => acquireFplRequest('bulk')),
      ...Array.from({ length: 2 }, () => acquireFplRequest('live')),
    ]);
    const controller = new AbortController();
    const blocked = acquireFplRequest('live', {
      deadlineAt: Date.now() + 5_000,
      signal: controller.signal,
    });
    await waitFor(async () => (await readFplAdmissionStats()).queuedByPriority.live === 1);
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' });
    expect((await readFplAdmissionStats()).queued).toBe(0);
    await Promise.all(held.map((lease) => lease.release()));
  }, 15_000);

  test('keeps one distributed slot reserved while the critical window is idle', async () => {
    const owner = `reservation-${process.pid}`;
    await openFplCriticalWindow({ owner, untilMs: Date.now() + 3_000 });
    const leases = await Promise.all([
      acquireFplRequest('live'),
      acquireFplRequest('live'),
      acquireFplRequest('live'),
    ]);
    await Bun.sleep(550);
    const fourth = await acquireFplRequest('live', { deadlineAt: Date.now() + 1_000 });
    expect((await readFplAdmissionStats()).inflight).toBe(4);
    const blocked = acquireFplRequest('live', { deadlineAt: Date.now() + 50 });
    await expect(blocked).rejects.toMatchObject({ code: 'FPL_ADMISSION_DEADLINE_EXCEEDED' });
    expect((await readFplAdmissionStats()).inflight).toBe(4);
    await fourth.release();
    await Promise.all(leases.map((lease) => lease.release()));
    await closeFplCriticalWindow(owner);
  }, 15_000);

  test('reports distributed token refill while admission is idle', async () => {
    const redis = await queueRedisSingleton.getClient();
    await redis.hset(`${PREFIX}:state`, 'tokens', '0', 'lastRefillMs', String(Date.now() - 2_000));
    const stats = await readFplAdmissionStats();
    expect(stats.tokens).toBeGreaterThan(3.5);
    expect(stats.tokens).toBeLessThanOrEqual(stats.tokenBucketCapacity);
  });

  test('purges expired leases and waiters before reporting idle stats', async () => {
    const redis = await queueRedisSingleton.getClient();
    const leaseToken = `stale-lease-${process.pid}`;
    const waiterToken = `stale-waiter-${process.pid}`;
    const expiredAt = Date.now() - 1_000;
    await redis.hset(`${PREFIX}:state`, {
      inflight: '1',
      live: '1',
      critical: '0',
      bulk: '0',
    });
    await redis.hset(`${PREFIX}:lease-meta`, leaseToken, 'live');
    await redis.set(`${PREFIX}:lease:${leaseToken}`, 'live', 'PX', 10_000);
    await redis.zadd(`${PREFIX}:leases`, expiredAt, leaseToken);
    await redis.hset(`${PREFIX}:waiters:priority`, waiterToken, 'bulk');
    await redis.zadd(`${PREFIX}:waiters:bulk`, expiredAt, waiterToken);
    await redis.zadd(`${PREFIX}:waiters:expiry`, expiredAt, waiterToken);

    const stats = await readFplAdmissionStats();
    expect(stats.inflight).toBe(0);
    expect(stats.liveInflight).toBe(0);
    expect(stats.queued).toBe(0);
    expect(await redis.exists(`${PREFIX}:lease:${leaseToken}`)).toBe(0);
    expect(await redis.hget(`${PREFIX}:lease-meta`, leaseToken)).toBeNull();
    expect(await redis.hget(`${PREFIX}:waiters:priority`, waiterToken)).toBeNull();
  });

  test('recovers the adaptive bulk limit while reporting idle stats', async () => {
    const redis = await queueRedisSingleton.getClient();
    const previousErrorAt = Date.now() - 300_001;
    await redis.hset(`${PREFIX}:state`, {
      bulkLimit: '1',
      lastBulkErrorMs: String(previousErrorAt),
    });

    const stats = await readFplAdmissionStats();
    expect(stats.bulkMaxInflight).toBeGreaterThan(1);
    const lastErrorAt = Number(await redis.hget(`${PREFIX}:state`, 'lastBulkErrorMs'));
    expect(lastErrorAt).toBeGreaterThan(previousErrorAt);
    expect(lastErrorAt).toBeLessThanOrEqual(Date.now());
  });
});
