import { Queue, type JobType } from 'bullmq';
import Redis from 'ioredis';
import postgres from 'postgres';

import {
  assertQueueQuiescence,
  findUnsettledCascades,
  type QueueQuiescenceSnapshot,
  type RunnableQueueCounts,
} from './deployment-queue-quiescence.service';
import { queueNames } from '../queues/names';
import { getConfig, resolveQueueRedisConfig } from '../utils/config';

const RUNNABLE_JOB_TYPES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
] as const satisfies readonly JobType[];
const CASCADE_PATTERNS = [
  'llm:queue:coordination:tournament-cascade:*',
  'llm:v*:queue:coordination:tournament-cascade:*',
] as const;

async function scan(redis: Redis, pattern: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 250);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return [...new Set(keys)].sort();
}

export async function inspectAndAssertDeploymentQueueQuiescence(): Promise<QueueQuiescenceSnapshot> {
  const config = getConfig();
  const databaseUrl = config.DATABASE_URL.trim();
  const queueConnection = resolveQueueRedisConfig(config);
  const database = postgres(databaseUrl, { max: 1, prepare: false });
  const redis = new Redis({
    ...queueConnection,
    lazyConnect: true,
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
  });
  const queues = queueNames.map((name) => new Queue(name, { connection: queueConnection }));

  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    const [databaseRows, cascadeKeyGroups, queueCountRows] = await Promise.all([
      database<Array<{ non_terminal_sync_runs: number; staging_publications: number }>>`
        SELECT
          count(*) FILTER (
            WHERE status IN ('pending', 'running', 'ready_to_publish')
          )::integer AS non_terminal_sync_runs,
          (
            SELECT count(*)::integer
            FROM ops.dataset_publications
            WHERE status = 'staging'
          ) AS staging_publications
        FROM ops.sync_runs
      `,
      Promise.all(CASCADE_PATTERNS.map((pattern) => scan(redis, pattern))),
      Promise.all(
        queues.map(
          async (queue) => [queue.name, await queue.getJobCounts(...RUNNABLE_JOB_TYPES)] as const,
        ),
      ),
    ]);
    const databaseState = databaseRows[0];
    if (!databaseState) throw new Error('Could not read the sync-run quiescence state');

    const snapshot = {
      nonTerminalSyncRuns: databaseState.non_terminal_sync_runs,
      stagingPublications: databaseState.staging_publications,
      runnableQueues: Object.fromEntries(queueCountRows) as Record<string, RunnableQueueCounts>,
      unsettledCascadeIds: findUnsettledCascades(cascadeKeyGroups.flat()),
    };
    assertQueueQuiescence(snapshot);
    return snapshot;
  } finally {
    await Promise.allSettled(queues.map((queue) => queue.close()));
    redis.disconnect();
    await database.end();
  }
}
