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
    const [databaseContractRows, cascadeKeyGroups, queueCountRows] = await Promise.all([
      database<Array<{ sync_runs_exists: boolean; publications_exists: boolean }>>`
        SELECT
          to_regclass('ops.sync_runs') IS NOT NULL AS sync_runs_exists,
          to_regclass('ops.dataset_publications') IS NOT NULL AS publications_exists
      `,
      Promise.all(CASCADE_PATTERNS.map((pattern) => scan(redis, pattern))),
      Promise.all(
        queues.map(
          async (queue) => [queue.name, await queue.getJobCounts(...RUNNABLE_JOB_TYPES)] as const,
        ),
      ),
    ]);
    const databaseContract = databaseContractRows[0];
    if (!databaseContract) throw new Error('Could not read the database quiescence state');
    if (databaseContract.sync_runs_exists !== databaseContract.publications_exists) {
      throw new Error('Database quiescence tables are only partially initialized');
    }

    let databaseState = { nonTerminalSyncRuns: 0, stagingPublications: 0 };
    if (databaseContract.sync_runs_exists) {
      const databaseRows = await database<
        Array<{ non_terminal_sync_runs: number; staging_publications: number }>
      >`
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
      `;
      const row = databaseRows[0];
      if (!row) throw new Error('Could not read the sync-run quiescence state');
      databaseState = {
        nonTerminalSyncRuns: row.non_terminal_sync_runs,
        stagingPublications: row.staging_publications,
      };
    }

    const snapshot = {
      nonTerminalSyncRuns: databaseState.nonTerminalSyncRuns,
      stagingPublications: databaseState.stagingPublications,
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
