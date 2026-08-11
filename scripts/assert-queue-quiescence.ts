/* eslint-disable no-console */
import { Queue, type JobType } from 'bullmq';
import Redis from 'ioredis';
import postgres from 'postgres';

import {
  assertQueueQuiescence,
  findUnsettledCascades,
  type RunnableQueueCounts,
} from './queue-quiescence-gate';
import { queueNames } from '../src/queues/names';
import { getConfig, resolveQueueRedisConfig } from '../src/utils/config';

const RUNNABLE_JOB_TYPES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
] as const satisfies readonly JobType[];
const CASCADE_PATTERN = 'llm:queue:coordination:tournament-cascade:*';

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

async function readDatabaseQuiescenceState(
  database: postgres.Sql,
): Promise<{ nonTerminalSyncRuns: number; stagingPublications: number }> {
  const [catalog] = await database<
    {
      has_sync_runs: boolean;
      has_dataset_publications: boolean;
    }[]
  >`
    SELECT
      to_regclass('ops.sync_runs') IS NOT NULL AS has_sync_runs,
      to_regclass('ops.dataset_publications') IS NOT NULL AS has_dataset_publications
  `;
  if (!catalog) throw new Error('Could not inspect the sync-run quiescence state');

  let nonTerminalSyncRuns = 0;
  let stagingPublications = 0;
  if (catalog.has_sync_runs) {
    const [row] = await database<{ count: number }[]>`
      SELECT count(*) FILTER (
        WHERE status IN ('pending', 'running', 'ready_to_publish')
      )::integer AS count
      FROM ops.sync_runs
    `;
    nonTerminalSyncRuns = row?.count ?? 0;
  }
  if (catalog.has_dataset_publications) {
    const [row] = await database<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM ops.dataset_publications
      WHERE status = 'staging'
    `;
    stagingPublications = row?.count ?? 0;
  }
  return { nonTerminalSyncRuns, stagingPublications };
}

async function main(): Promise<void> {
  if (process.argv.length !== 2) throw new Error('Queue quiescence check takes no arguments');
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
    const [databaseState, cascadeKeys, queueCountRows] = await Promise.all([
      readDatabaseQuiescenceState(database),
      scan(redis, CASCADE_PATTERN),
      Promise.all(
        queues.map(
          async (queue) => [queue.name, await queue.getJobCounts(...RUNNABLE_JOB_TYPES)] as const,
        ),
      ),
    ]);
    const snapshot = {
      nonTerminalSyncRuns: databaseState.nonTerminalSyncRuns,
      stagingPublications: databaseState.stagingPublications,
      runnableQueues: Object.fromEntries(queueCountRows) as Record<string, RunnableQueueCounts>,
      unsettledCascadeIds: findUnsettledCascades(cascadeKeys),
    };
    assertQueueQuiescence(snapshot);
    console.log(JSON.stringify({ status: 'queue_quiescence_passed', ...snapshot }, null, 2));
  } finally {
    await Promise.allSettled(queues.map((queue) => queue.close()));
    redis.disconnect();
    await database.end();
  }
}

main().catch((error) => {
  console.error('[queue-quiescence] failed', error);
  process.exitCode = 1;
});
