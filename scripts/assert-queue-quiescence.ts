/* eslint-disable no-console */
import { Queue, type JobType } from 'bullmq';
import Redis from 'ioredis';
import postgres from 'postgres';

import {
  assertQueueQuiescence,
  findUnsettledRetiredCascades,
  type RunnableQueueCounts,
} from './queue-quiescence-gate';
import { getConfig, resolveQueueRedisConfig } from '../src/utils/config';

const TIERED_QUEUE_BASE_NAMES = [
  'data-sync',
  'entry-sync',
  'league-sync',
  'live-data',
  'tournament-sync',
  'tournament-setup',
] as const;
const QUEUE_TIERS = ['p0', 'p1', 'p2', 'p3'] as const;
const UNDERSTAT_QUEUE_NAMES = ['understat-player-sync', 'understat-team-sync'] as const;
const RUNNABLE_JOB_TYPES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
] as const satisfies readonly JobType[];
const RETIRED_CASCADE_PATTERN = 'llm:*:queue:coordination:tournament-cascade:*';

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
  const queueNames = [
    ...TIERED_QUEUE_BASE_NAMES.flatMap((base) => QUEUE_TIERS.map((tier) => `${base}-${tier}`)),
    ...UNDERSTAT_QUEUE_NAMES,
  ];
  const queues = queueNames.map((name) => new Queue(name, { connection: queueConnection }));

  try {
    if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
    const [databaseRows, retiredCascadeKeys, queueCountRows] = await Promise.all([
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
      scan(redis, RETIRED_CASCADE_PATTERN),
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
      unsettledRetiredCascadeIds: findUnsettledRetiredCascades(retiredCascadeKeys),
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
