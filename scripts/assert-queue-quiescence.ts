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
import {
  compareAndSetQueueAdmission,
  readQueueAdmission,
  type QueueAdmission,
  type QueueAdmissionMode,
} from '../src/services/queue-governance.service';
import { queueRedisSingleton } from '../src/queues/redis';
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

export const CONTENT_X_SCAN_QUEUE = 'content-x-scan' as const;
export const DEPLOY_QUEUE_ADMISSION_TTL_SECONDS = 900;
export const DEPLOY_QUEUE_ADMISSION_REASON = 'DEPLOY_QUEUE_QUIESCENCE';
export const DEPLOY_QUEUE_ADMISSION_ACTOR = 'deployment';
export const DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS = 3;

export type ContentXScanAdmissionArguments = Readonly<{
  mode: QueueAdmissionMode;
}>;

function admissionUsage(): never {
  throw new Error('usage: bun scripts/assert-queue-quiescence.ts --admission-mode DRAIN_ONLY|OPEN');
}

export function parseContentXScanAdmissionArguments(
  argv: readonly string[],
): ContentXScanAdmissionArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) admissionUsage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      const key = token.slice(2, separator);
      if (key !== 'admission-mode' || values.has(key)) admissionUsage();
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (key !== 'admission-mode' || !value || value.startsWith('--') || values.has(key)) {
      admissionUsage();
    }
    values.set(key, value);
    index += 1;
  }

  const mode = values.get('admission-mode');
  if (mode !== 'DRAIN_ONLY' && mode !== 'OPEN') admissionUsage();
  return { mode };
}

function isDeploymentAdmission(admission: QueueAdmission | null): boolean {
  return (
    admission?.mode === 'DRAIN_ONLY' &&
    admission.changedBy === DEPLOY_QUEUE_ADMISSION_ACTOR &&
    admission.reasonCode === DEPLOY_QUEUE_ADMISSION_REASON
  );
}

function admissionSummary(input: {
  mode: QueueAdmissionMode;
  changed: boolean;
  admission: QueueAdmission | null;
  previousMode: QueueAdmissionMode | null;
}) {
  return {
    contractVersion: 'queue-admission-v2',
    queueName: CONTENT_X_SCAN_QUEUE,
    mode: input.mode,
    changed: input.changed,
    previousMode: input.previousMode,
    admission: input.admission
      ? {
          mode: input.admission.mode,
          expiresAt: input.admission.expiresAt,
          reasonCode: input.admission.reasonCode,
          changedBy: input.admission.changedBy,
        }
      : null,
  };
}

async function applyContentXScanAdmission(args: ContentXScanAdmissionArguments) {
  let expected = await readQueueAdmission(CONTENT_X_SCAN_QUEUE);
  const previousMode = expected?.mode ?? null;

  for (let attempt = 0; attempt < DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    if (expected?.mode === 'DRAIN_ONLY' && !isDeploymentAdmission(expected)) {
      return admissionSummary({
        mode: args.mode,
        changed: false,
        admission: expected,
        previousMode,
      });
    }

    const result = await compareAndSetQueueAdmission({
      queueName: CONTENT_X_SCAN_QUEUE,
      expected,
      mode: args.mode,
      ttlSeconds: DEPLOY_QUEUE_ADMISSION_TTL_SECONDS,
      reasonCode: DEPLOY_QUEUE_ADMISSION_REASON,
      changedBy: DEPLOY_QUEUE_ADMISSION_ACTOR,
    });
    if (result.swapped) {
      if (!result.admission) throw new Error('Queue admission CAS returned no replacement');
      return admissionSummary({
        mode: args.mode,
        changed: true,
        admission: result.admission,
        previousMode,
      });
    }

    expected = result.admission;
  }

  throw new Error('Queue admission changed concurrently; refusing non-CAS update');
}

function hasContentXScanAdmissionArguments(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--admission-mode' || arg.startsWith('--admission-mode='));
}

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
  if (hasContentXScanAdmissionArguments(args)) {
    const admissionArguments = parseContentXScanAdmissionArguments(args);
    try {
      process.stdout.write(
        `${JSON.stringify(await applyContentXScanAdmission(admissionArguments))}\n`,
      );
    } finally {
      await queueRedisSingleton.disconnect();
    }
    return;
  }

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

if (import.meta.main) {
  main().catch((error) => {
    console.error('[queue-quiescence] failed', error);
    process.exitCode = 1;
  });
}
