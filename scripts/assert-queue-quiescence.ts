/* eslint-disable no-console */
import { Queue, type JobType } from 'bullmq';
import { and, eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import Redis from 'ioredis';
import postgres from 'postgres';

import {
  assertQuiescenceCatalogPair,
  assertQueueQuiescence,
  assertScopedQueueQuiescence,
  findUnsettledCascades,
  type RunnableQueueCounts,
} from './queue-quiescence-gate';
import { prepareQueuedFormalRunsForDeployment } from '../src/content/acquisition/formal-run-repository';
import {
  contentAcquisitionJobOutbox,
  contentAcquisitionRuns,
} from '../src/db/schemas/content.schema';
import { allQueueNames, contentQueueNames, contentXScanQueueName } from '../src/queues/names';
import {
  beginQueueConsumerPauseRelease,
  abortQueueConsumerPauseAcquisition,
  acquiringQueueConsumerPauseOwner,
  claimQueueConsumerPauseAcquisition,
  compareAndSetQueueAdmission,
  completeQueueConsumerPauseAcquisition,
  completeQueueConsumerPauseRelease,
  deploymentQueueConsumerPauseOwner,
  markQueueConsumerOperatorPaused,
  queueConsumerPauseOwnerState,
  readQueueAdmission,
  readQueueConsumerPauseOwner,
  releasingQueueConsumerPauseOwner,
  touchQueueConsumerPauseOwner,
  type QueueAdmission,
  type QueueAdmissionMode,
  QUEUE_CONSUMER_PAUSE_OPERATOR,
} from '../src/services/queue-governance.service';
import { queueRedisSingleton } from '../src/queues/redis';
import * as schema from '../src/db/schemas/index.schema';
import { getConfig, resolveQueueRedisConfig } from '../src/utils/config';
import { getQueueConnection } from '../src/utils/queue';

const RUNNABLE_JOB_TYPES = [
  'waiting',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
] as const satisfies readonly JobType[];
const CASCADE_PATTERN = 'llm:queue:coordination:tournament-cascade:*';
const DEPLOYMENT_PREPARE_PAUSED_CONTENT_RUNS = '--prepare-paused-content-runs';

export const CONTENT_X_SCAN_QUEUE = contentXScanQueueName;
export const CONTENT_CONSUMER_QUEUE_NAMES = contentQueueNames;
export const CONTENT_CONSUMER_CONTRACT_VERSION = 'content-worker-consumer-v1' as const;
export const DEPLOY_QUEUE_ADMISSION_TTL_SECONDS = 900;
export const DEPLOY_QUEUE_ADMISSION_REASON = 'DEPLOY_QUEUE_QUIESCENCE';
export const DEPLOY_QUEUE_ADMISSION_ACTOR = 'deployment';
export const DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS = 3;
export const CONTENT_CONSUMER_OWNER_TOKEN_ENV = 'DEPLOY_CONTENT_WORKER_PAUSE_OWNER_TOKEN';

type ContentConsumerQueueName = (typeof contentQueueNames)[number];
export type ContentConsumerMode = 'STATUS' | 'PAUSE' | 'RESUME';

export type ContentConsumerModeArguments = Readonly<{
  mode: ContentConsumerMode;
  queueName: ContentConsumerQueueName;
}>;

export type ContentWorkerAdmissionArguments = Readonly<{
  mode: QueueAdmissionMode;
  queueName: ContentConsumerQueueName;
}>;

function admissionUsage(): never {
  throw new Error(
    'usage: bun scripts/assert-queue-quiescence.ts --admission-mode DRAIN_ONLY|OPEN [--admission-queue CONTENT_QUEUE]',
  );
}

function consumerUsage(): never {
  throw new Error(
    'usage: bun scripts/assert-queue-quiescence.ts --consumer-mode STATUS|PAUSE|RESUME --consumer-queue QUEUE',
  );
}

export function parseContentWorkerAdmissionArguments(
  argv: readonly string[],
): ContentWorkerAdmissionArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) admissionUsage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      const key = token.slice(2, separator);
      if ((key !== 'admission-mode' && key !== 'admission-queue') || values.has(key)) {
        admissionUsage();
      }
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (
      (key !== 'admission-mode' && key !== 'admission-queue') ||
      !value ||
      value.startsWith('--') ||
      values.has(key)
    ) {
      admissionUsage();
    }
    values.set(key, value);
    index += 1;
  }

  const mode = values.get('admission-mode');
  if (mode !== 'DRAIN_ONLY' && mode !== 'OPEN') admissionUsage();
  const queueName = values.get('admission-queue') ?? CONTENT_X_SCAN_QUEUE;
  if (!isContentConsumerQueueName(queueName)) admissionUsage();
  return { mode, queueName };
}

function isContentConsumerQueueName(value: string): value is ContentConsumerQueueName {
  return (contentQueueNames as readonly string[]).includes(value);
}

function readContentConsumerOwnerToken(): string | null {
  const token = process.env[CONTENT_CONSUMER_OWNER_TOKEN_ENV]?.trim();
  return token ? token : null;
}

export function parseContentConsumerModeArguments(
  argv: readonly string[],
): ContentConsumerModeArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith('--')) consumerUsage();
    const separator = token.indexOf('=');
    if (separator > 2) {
      const key = token.slice(2, separator);
      if ((key !== 'consumer-mode' && key !== 'consumer-queue') || values.has(key)) {
        consumerUsage();
      }
      values.set(key, token.slice(separator + 1));
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (
      (key !== 'consumer-mode' && key !== 'consumer-queue') ||
      !value ||
      value.startsWith('--') ||
      values.has(key)
    ) {
      consumerUsage();
    }
    values.set(key, value);
    index += 1;
  }

  const mode = values.get('consumer-mode');
  const queueName = values.get('consumer-queue');
  if (
    (mode !== 'STATUS' && mode !== 'PAUSE' && mode !== 'RESUME') ||
    !queueName ||
    !isContentConsumerQueueName(queueName) ||
    values.size !== 2
  ) {
    consumerUsage();
  }
  return { mode, queueName };
}

export function parseAllowedPausedQueueNames(
  raw = process.env.DEPLOY_QUIESCENCE_ALLOW_PAUSED_QUEUES ?? '',
): readonly ContentConsumerQueueName[] {
  const names = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const unique = new Set<ContentConsumerQueueName>();
  for (const name of names) {
    if (!isContentConsumerQueueName(name)) {
      throw new Error(`Invalid deployment paused queue name: ${name}`);
    }
    if (unique.has(name)) throw new Error(`Duplicate deployment paused queue name: ${name}`);
    unique.add(name);
  }
  return [...unique];
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
  queueName: ContentConsumerQueueName;
  changed: boolean;
  admission: QueueAdmission | null;
  previousMode: QueueAdmissionMode | null;
}) {
  return {
    contractVersion: 'queue-admission-v2',
    queueName: input.queueName,
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

async function applyContentWorkerAdmission(args: ContentWorkerAdmissionArguments) {
  let expected = await readQueueAdmission(args.queueName);
  const previousMode = expected?.mode ?? null;

  for (let attempt = 0; attempt < DEPLOY_QUEUE_ADMISSION_CAS_ATTEMPTS; attempt += 1) {
    if (expected?.mode === 'DRAIN_ONLY' && !isDeploymentAdmission(expected)) {
      return admissionSummary({
        mode: args.mode,
        queueName: args.queueName,
        changed: false,
        admission: expected,
        previousMode,
      });
    }

    const result = await compareAndSetQueueAdmission({
      queueName: args.queueName,
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
        queueName: args.queueName,
        changed: true,
        admission: result.admission,
        previousMode,
      });
    }

    expected = result.admission;
  }

  throw new Error('Queue admission changed concurrently; refusing non-CAS update');
}

async function applyContentConsumerMode(args: ContentConsumerModeArguments) {
  const queue = new Queue(args.queueName, { connection: getQueueConnection() });
  const ownerToken = readContentConsumerOwnerToken();
  const callerOwner = ownerToken
    ? deploymentQueueConsumerPauseOwner(ownerToken)
    : QUEUE_CONSUMER_PAUSE_OPERATOR;
  const acquiringOwner = ownerToken ? acquiringQueueConsumerPauseOwner(callerOwner) : null;

  const resultSummary = (input: {
    mode: ContentConsumerMode;
    previousPaused: boolean;
    paused: boolean;
    owner: string | null;
    owned: boolean;
    released?: boolean;
  }) => ({
    contractVersion: CONTENT_CONSUMER_CONTRACT_VERSION,
    queueName: args.queueName,
    mode: input.mode,
    previousPaused: input.previousPaused,
    paused: input.paused,
    changed: input.previousPaused !== input.paused,
    owner: queueConsumerPauseOwnerState(input.owner),
    owned: input.owned,
    released: input.released ?? false,
  });

  try {
    const previousPaused = await queue.isPaused();
    let owner = await readQueueConsumerPauseOwner(args.queueName);

    if (args.mode === 'STATUS') {
      let owned = owner === callerOwner || owner === acquiringOwner;
      if (ownerToken && owned && previousPaused && owner) {
        owned = await touchQueueConsumerPauseOwner(args.queueName, owner);
        if (!owned) owner = await readQueueConsumerPauseOwner(args.queueName);
      }
      return resultSummary({
        mode: args.mode,
        previousPaused,
        paused: previousPaused,
        owner,
        owned,
      });
    }

    if (args.mode === 'PAUSE') {
      if (owner?.startsWith('releasing:')) {
        throw new Error(`Content consumer pause is being released: ${args.queueName}`);
      }
      if (ownerToken && owner && owner !== callerOwner && owner !== acquiringOwner) {
        return resultSummary({
          mode: args.mode,
          previousPaused,
          paused: previousPaused,
          owner,
          owned: false,
        });
      }

      if (ownerToken && !previousPaused && owner !== callerOwner) {
        if (!(await claimQueueConsumerPauseAcquisition(args.queueName, callerOwner))) {
          owner = await readQueueConsumerPauseOwner(args.queueName);
          return resultSummary({
            mode: args.mode,
            previousPaused,
            paused: await queue.isPaused(),
            owner,
            owned: false,
          });
        }
        owner = acquiringOwner;
      }

      let paused: boolean;
      try {
        if (!previousPaused) await queue.pause();
        paused = await queue.isPaused();
      } catch (error) {
        if (ownerToken && owner === acquiringOwner) {
          try {
            // Only roll back an interrupted reservation after confirming that
            // BullMQ is still open.  If Redis cannot answer, keep the marker
            // so an operator can safely reconcile the possibly-paused queue.
            if (!(await queue.isPaused())) {
              await abortQueueConsumerPauseAcquisition(args.queueName, callerOwner);
            }
          } catch {
            // Preserve the acquisition marker when the queue state is unknown.
          }
        }
        throw error;
      }
      if (!paused) {
        if (ownerToken && owner === acquiringOwner) {
          try {
            if (await abortQueueConsumerPauseAcquisition(args.queueName, callerOwner)) {
              owner = await readQueueConsumerPauseOwner(args.queueName);
            }
          } catch {
            // Preserve the marker when Redis cannot complete the rollback.
          }
        }
        throw new Error(
          `Content consumer did not reach requested mode: ${args.queueName}=${args.mode}`,
        );
      }

      let owned = false;
      if (ownerToken) {
        owned =
          owner === acquiringOwner
            ? await completeQueueConsumerPauseAcquisition(args.queueName, callerOwner)
            : owner === callerOwner
              ? await touchQueueConsumerPauseOwner(args.queueName, callerOwner)
              : false;
        owner = await readQueueConsumerPauseOwner(args.queueName);
        if (!owned && !owner) {
          // A lost Redis marker after BullMQ confirmed the pause is still
          // recoverable as an explicit operator-owned pause rather than an
          // unowned global stop.  A concurrent operator/release marker wins
          // inside the same Lua CAS.
          await markQueueConsumerOperatorPaused(args.queueName);
          owner = await readQueueConsumerPauseOwner(args.queueName);
        }
      } else {
        owned = await markQueueConsumerOperatorPaused(args.queueName);
        owner = await readQueueConsumerPauseOwner(args.queueName);
      }
      return resultSummary({
        mode: args.mode,
        previousPaused,
        paused,
        owner,
        owned: owned && owner === callerOwner,
      });
    }

    let releaseOwner = callerOwner;
    const releasingOwner = releasingQueueConsumerPauseOwner(callerOwner);
    const canRelease =
      owner === callerOwner || owner === acquiringOwner || owner === releasingOwner;
    if (ownerToken && !canRelease) {
      return resultSummary({
        mode: args.mode,
        previousPaused,
        paused: previousPaused,
        owner,
        owned: false,
      });
    }
    if (!ownerToken && owner && owner !== QUEUE_CONSUMER_PAUSE_OPERATOR && !canRelease) {
      if (owner.startsWith('acquiring:')) {
        // An operator RESUME cannot take ownership from an in-flight deployment
        // pause.  Returning the unchanged state lets the deployment finish its
        // BullMQ transition; converting it to an operator pause would allow a
        // later operator release to erase the deployment's ownership marker.
        return resultSummary({
          mode: args.mode,
          previousPaused,
          paused: previousPaused,
          owner,
          owned: false,
        });
      }
      // An explicit operator resume may recover a queue left in an interrupted
      // release. Keep the exact releasing owner so completion can delete only
      // that marker after the observed BullMQ state reaches OPEN.
      if (owner.startsWith('releasing:')) {
        releaseOwner = owner.slice('releasing:'.length);
        if (!releaseOwner) {
          throw new Error(`Content consumer release owner is invalid: ${args.queueName}`);
        }
      } else {
        // A deployment owner without an active release may be converted to an
        // explicit operator-owned pause before the operator releases it.
        if (!(await markQueueConsumerOperatorPaused(args.queueName))) {
          throw new Error(`Content consumer operator release was fenced: ${args.queueName}`);
        }
        owner = QUEUE_CONSUMER_PAUSE_OPERATOR;
      }
    }

    if (owner) {
      if (!(await beginQueueConsumerPauseRelease(args.queueName, releaseOwner))) {
        owner = await readQueueConsumerPauseOwner(args.queueName);
        return resultSummary({
          mode: args.mode,
          previousPaused,
          paused: previousPaused,
          owner,
          owned: false,
        });
      }
    }

    if (previousPaused) await queue.resume();
    const paused = await queue.isPaused();
    if (paused) {
      throw new Error(
        `Content consumer did not reach requested mode: ${args.queueName}=${args.mode}`,
      );
    }
    if (owner && !(await completeQueueConsumerPauseRelease(args.queueName, releaseOwner))) {
      throw new Error(`Content consumer release ownership changed: ${args.queueName}`);
    }
    return resultSummary({
      mode: args.mode,
      previousPaused,
      paused,
      owner: null,
      owned: Boolean(owner),
      released: Boolean(owner),
    });
  } finally {
    await queue.close();
  }
}

function hasContentWorkerAdmissionArguments(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--admission-mode' || arg.startsWith('--admission-mode='));
}

function hasContentConsumerModeArguments(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === '--consumer-mode' || arg.startsWith('--consumer-mode='));
}

function hasDeploymentPrepareArguments(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === DEPLOYMENT_PREPARE_PAUSED_CONTENT_RUNS);
}

async function preparePausedContentRunsForDeployment(argv: readonly string[]): Promise<void> {
  if (argv.length !== 1 || argv[0] !== DEPLOYMENT_PREPARE_PAUSED_CONTENT_RUNS) {
    throw new Error(`Queue quiescence check does not accept arguments: ${argv.join(' ')}`);
  }
  const config = getConfig();
  const queueConnection = resolveQueueRedisConfig(config);
  const queues = contentQueueNames.map((name) => new Queue(name, { connection: queueConnection }));
  const databaseClient = postgres(config.DATABASE_URL, { max: 1, prepare: false });
  try {
    const pauseStates = await Promise.all(
      queues.map(async (queue) => ({ queueName: queue.name, paused: await queue.isPaused() })),
    );
    const unpaused = pauseStates.filter((state) => !state.paused).map((state) => state.queueName);
    if (unpaused.length > 0) {
      throw new Error(
        `Deployment formal-run deferral requires every content queue to remain paused: ${unpaused.join(', ')}`,
      );
    }
    const db = drizzle(databaseClient, { schema });
    const candidates = await db
      .select({
        runId: contentAcquisitionRuns.runId,
        queueName: contentAcquisitionJobOutbox.queueName,
        jobId: contentAcquisitionJobOutbox.jobId,
      })
      .from(contentAcquisitionRuns)
      .innerJoin(
        contentAcquisitionJobOutbox,
        eq(contentAcquisitionJobOutbox.runId, contentAcquisitionRuns.runId),
      )
      .where(
        and(
          eq(contentAcquisitionRuns.status, 'PENDING'),
          isNotNull(contentAcquisitionRuns.leaseExpiresAt),
          isNotNull(contentAcquisitionRuns.enqueueConfirmedAt),
        ),
      );
    const queuesByName = new Map(queues.map((queue) => [queue.name, queue]));
    const queuedRunIds = new Set<string>();
    await Promise.all(
      candidates.map(async (candidate) => {
        if (!isContentConsumerQueueName(candidate.queueName)) {
          throw new Error(`Invalid formal acquisition queue: ${candidate.queueName}`);
        }
        const queue = queuesByName.get(candidate.queueName);
        if (!queue) {
          throw new Error(`Formal acquisition queue is not configured: ${candidate.queueName}`);
        }
        const job = await queue.getJob(candidate.jobId);
        if (!job) return;
        const state = await job.getState();
        if (RUNNABLE_JOB_TYPES.includes(state as (typeof RUNNABLE_JOB_TYPES)[number])) {
          queuedRunIds.add(candidate.runId);
        }
      }),
    );
    const prepared = await prepareQueuedFormalRunsForDeployment({ db, queuedRunIds });
    process.stdout.write(
      `${JSON.stringify({ status: 'paused_content_runs_prepared', prepared })}\n`,
    );
  } finally {
    await Promise.allSettled([...queues.map((queue) => queue.close()), databaseClient.end()]);
  }
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
  if (hasDeploymentPrepareArguments(args)) {
    await preparePausedContentRunsForDeployment(args);
    return;
  }
  if (hasContentWorkerAdmissionArguments(args)) {
    const admissionArguments = parseContentWorkerAdmissionArguments(args);
    try {
      process.stdout.write(
        `${JSON.stringify(await applyContentWorkerAdmission(admissionArguments))}\n`,
      );
    } finally {
      await queueRedisSingleton.disconnect();
    }
    return;
  }
  if (hasContentConsumerModeArguments(args)) {
    const consumerArguments = parseContentConsumerModeArguments(args);
    try {
      process.stdout.write(
        `${JSON.stringify(await applyContentConsumerMode(consumerArguments))}\n`,
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
  const allowPausedQueueNames = scoped ? parseAllowedPausedQueueNames() : [];
  const allowPausedQueueSet = new Set(allowPausedQueueNames);
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
        queues.map(async (queue) => {
          const counts = await queue.getJobCounts(...RUNNABLE_JOB_TYPES);
          if (allowPausedQueueSet.has(queue.name as ContentConsumerQueueName)) {
            if (!(await queue.isPaused())) {
              throw new Error(`Deployment paused queue is no longer paused: ${queue.name}`);
            }
          }
          return [queue.name, counts] as const;
        }),
      ),
    ]);
    const snapshot = {
      nonTerminalSyncRuns: databaseState.nonTerminalSyncRuns,
      stagingPublications: databaseState.stagingPublications,
      runningMediaLeases: databaseState.runningMediaLeases,
      runnableQueues: Object.fromEntries(queueCountRows) as Record<string, RunnableQueueCounts>,
      unsettledCascadeIds: findUnsettledCascades(cascadeKeys),
    };
    if (scoped) {
      assertScopedQueueQuiescence(snapshot, { allowPausedQueueNames });
    } else assertQueueQuiescence(snapshot);
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
