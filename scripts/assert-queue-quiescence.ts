/* eslint-disable no-console */
import { Queue, type JobType } from 'bullmq';
import Redis from 'ioredis';
import postgres from 'postgres';

import {
  assertQuiescenceCatalogPair,
  assertQueueQuiescence,
  assertScopedQueueQuiescence,
  findUnsettledCascades,
  type RunnableQueueCounts,
} from './queue-quiescence-gate';
import { allQueueNames } from '../src/queues/names';
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

async function readDatabaseQuiescenceState(database: postgres.Sql): Promise<{
  nonTerminalSyncRuns: number;
  stagingPublications: number;
  runningMediaLeases: number;
}> {
  const [catalog] = await database<
    {
      has_sync_runs: boolean;
      has_dataset_publications: boolean;
      has_source_media_gates: boolean;
    }[]
  >`
    SELECT
      to_regclass('ops.sync_runs') IS NOT NULL AS has_sync_runs,
      to_regclass('ops.dataset_publications') IS NOT NULL AS has_dataset_publications,
      to_regclass('content.source_media_gates') IS NOT NULL AS has_source_media_gates
  `;
  if (!catalog) throw new Error('Could not inspect the sync-run quiescence state');
  assertQuiescenceCatalogPair(catalog.has_sync_runs, catalog.has_dataset_publications);

  let nonTerminalSyncRuns = 0;
  let stagingPublications = 0;
  let runningMediaLeases = 0;
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
  if (catalog.has_source_media_gates) {
    const [row] = await database<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM content.source_media_gates
      WHERE status = 'RUNNING'
        AND lease_owner IS NOT NULL
    `;
    runningMediaLeases = row?.count ?? 0;
  }
  return { nonTerminalSyncRuns, stagingPublications, runningMediaLeases };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scoped = args.includes('--scoped');
  const modeArgs = args.filter((arg) => arg !== '--scoped');
  const databaseOnly = modeArgs.length === 1 && modeArgs[0] === '--database-only';
  const redisOnly = modeArgs.length === 1 && modeArgs[0] === '--redis-only';
  if (modeArgs.length > 0 && !databaseOnly && !redisOnly) {
    throw new Error(`Queue quiescence check does not accept arguments: ${args.join(' ')}`);
  }

  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!redisOnly && !databaseUrl) throw new Error('DATABASE_URL is required');
  const config = databaseOnly ? null : getConfig();
  const queueConnection = config ? resolveQueueRedisConfig(config) : null;
  const database = redisOnly ? null : postgres(databaseUrl as string, { max: 1, prepare: false });
  const redis = queueConnection
    ? new Redis({
        ...queueConnection,
        lazyConnect: true,
        enableReadyCheck: true,
        maxRetriesPerRequest: null,
      })
    : null;
  const queues = queueConnection
    ? allQueueNames.map((name) => new Queue(name, { connection: queueConnection }))
    : [];

  try {
    if (redis && (redis.status === 'wait' || redis.status === 'end')) await redis.connect();
    const [databaseState, cascadeKeys, queueCountRows] = await Promise.all([
      database
        ? readDatabaseQuiescenceState(database)
        : Promise.resolve({
            nonTerminalSyncRuns: 0,
            stagingPublications: 0,
            runningMediaLeases: 0,
          }),
      redis ? scan(redis, CASCADE_PATTERN) : Promise.resolve([]),
      Promise.all(
        queues.map(
          async (queue) => [queue.name, await queue.getJobCounts(...RUNNABLE_JOB_TYPES)] as const,
        ),
      ),
    ]);
    const snapshot = {
      nonTerminalSyncRuns: databaseState.nonTerminalSyncRuns,
      stagingPublications: databaseState.stagingPublications,
      runningMediaLeases: databaseState.runningMediaLeases,
      runnableQueues: Object.fromEntries(queueCountRows) as Record<string, RunnableQueueCounts>,
      unsettledCascadeIds: findUnsettledCascades(cascadeKeys),
    };
    if (scoped) assertScopedQueueQuiescence(snapshot);
    else assertQueueQuiescence(snapshot);
    console.log(
      JSON.stringify(
        { status: 'queue_quiescence_passed', mode: scoped ? 'scoped' : 'global', ...snapshot },
        null,
        2,
      ),
    );
  } finally {
    await Promise.allSettled(queues.map((queue) => queue.close()));
    redis?.disconnect();
    await database?.end();
  }
}

main().catch((error) => {
  console.error('[queue-quiescence] failed', error);
  process.exitCode = 1;
});
