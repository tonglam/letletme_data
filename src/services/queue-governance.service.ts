import type { Queue } from 'bullmq';

import { queueRedisSingleton } from '../queues/redis';
import { canonicalQueueCatalog } from '../domain/data-contracts';
import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';

export type BacklogClass =
  | 'NO_CONSUMER'
  | 'POISON_STORM'
  | 'STALLED'
  | 'DEADLINE_RISK'
  | 'PROVIDER_THROTTLED'
  | 'BURST'
  | 'HEALTHY';
export type QueueAdmissionMode = 'OPEN' | 'DRAIN_ONLY';

export type QueueHealthSnapshot = Readonly<{
  queueName: string;
  observedAt: string;
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  failed: number;
  completed: number;
  runnable: number;
  oldestRunnableAgeMs: number | null;
  arrivals: number;
  completions: number;
  failures: number;
  stalled: number;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  executionP50Ms: number | null;
  executionP95Ms: number | null;
  providerWaitP95Ms: number | null;
  provider429Rate: number | null;
  netGrowth: number;
  drainEtaMs: number | null;
  backlogClass: BacklogClass;
  admissionMode: QueueAdmissionMode;
  consumerHeartbeatAt: string | null;
  releaseSha: string;
}>;

export type QueueAdmission = Readonly<{
  queueName: string;
  mode: QueueAdmissionMode;
  expiresAt: string;
  reasonCode: string;
  changedAt: string;
  changedBy: string;
  forceCritical: boolean;
}>;

export class QueueDrainOnlyError extends Error {
  readonly status = 503;
  readonly code = 'QUEUE_DRAIN_ONLY';
  readonly retryAfterSeconds: number;

  constructor(queueName: string, retryAfterSeconds = 60) {
    super(`Queue ${queueName} is drain-only; new work is temporarily paused`);
    this.name = 'QueueDrainOnlyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SNAPSHOT_PREFIX = 'ops:queue-health:';
const ADMISSION_PREFIX = 'ops:queue-admission:';
const RED_SAMPLE_PREFIX = 'ops:queue-admission-red:';
const GREEN_SAMPLE_PREFIX = 'ops:queue-admission-green-since:';
const MONITOR_LEASE_PREFIX = 'ops:queue-monitor-leader:';
export const QUEUE_MONITOR_LEASE_TTL_SECONDS = 75;
const AUTO_GATED_QUEUES = new Set(['data-repair', 'housekeeping', 'entry-onboarding']);
const AUTO_GATE_RED_CLASSES = new Set<BacklogClass>([
  'NO_CONSUMER',
  'POISON_STORM',
  'STALLED',
  'DEADLINE_RISK',
  'PROVIDER_THROTTLED',
]);
const CRITICAL_QUEUES = new Set([
  'live-data',
  'live-picks',
  'official-h2h-live',
  'publication-outbox',
  'my-fpl-orchestration',
]);

export function classifyBacklog(
  input: Readonly<{
    waiting: number;
    active: number;
    failed: number;
    stalled?: number;
    oldestRunnableAgeMs?: number | null;
    dispatchBudgetMs?: number;
    providerWaitP95Ms?: number | null;
    provider429Rate?: number | null;
    arrivalsPerMinute?: number;
    completionsPerMinute?: number;
    /** Failed events observed in the current telemetry window. */
    failuresPerMinute?: number;
    consumerHeartbeatAgeMs?: number | null;
  }>,
): BacklogClass {
  if (
    input.waiting > 0 &&
    input.consumerHeartbeatAgeMs !== undefined &&
    (input.consumerHeartbeatAgeMs === null || input.consumerHeartbeatAgeMs > 90_000)
  ) {
    return 'NO_CONSUMER';
  }
  // `failed` is BullMQ's retained total and can represent weeks of history.
  // Poison classification is only meaningful for failures observed in this
  // window. Unit callers that provide arrivals but no explicit event count
  // retain the old shorthand; production monitor calls always provide it.
  const failuresInWindow =
    input.failuresPerMinute ?? (input.arrivalsPerMinute === undefined ? 0 : input.failed);
  if (
    failuresInWindow >= 5 &&
    failuresInWindow >= Math.max(1, input.arrivalsPerMinute ?? 0) * 0.5
  ) {
    return 'POISON_STORM';
  }
  if ((input.stalled ?? 0) > 0) return 'STALLED';
  if (
    input.oldestRunnableAgeMs !== null &&
    input.oldestRunnableAgeMs !== undefined &&
    input.dispatchBudgetMs !== undefined &&
    input.oldestRunnableAgeMs > input.dispatchBudgetMs
  ) {
    return 'DEADLINE_RISK';
  }
  if ((input.providerWaitP95Ms ?? 0) > 5_000 || (input.provider429Rate ?? 0) >= 0.05) {
    return 'PROVIDER_THROTTLED';
  }
  if ((input.arrivalsPerMinute ?? 0) > (input.completionsPerMinute ?? 0) * 1.5) {
    return 'BURST';
  }
  return 'HEALTHY';
}

export function calculateDrainEtaMs(
  runnable: number,
  arrivalsPerMinute: number,
  completionsPerMinute: number,
): number | null {
  const rate = completionsPerMinute - arrivalsPerMinute;
  if (runnable <= 0) return 0;
  if (rate <= 0) return null;
  return Math.ceil((runnable / rate) * 60_000);
}

export function percentile(values: readonly number[], percentileRank: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(1, Math.max(0, percentileRank));
  return sorted[Math.min(sorted.length - 1, Math.ceil(rank * sorted.length) - 1)] ?? null;
}

export function queueHealthSnapshotKey(queueName: string): string {
  return `${SNAPSHOT_PREFIX}${queueName}`;
}

export function queueAdmissionKey(queueName: string): string {
  return `${ADMISSION_PREFIX}${queueName}`;
}

export function queueMonitorLeaseKey(queueName: string): string {
  return `${MONITOR_LEASE_PREFIX}${queueName}`;
}

/**
 * Claim one short lease per queue for the minute-window writer. Rolling
 * deployments can therefore run two consumers without double-counting red
 * samples or inserting competing aggregate rows.
 */
export async function acquireQueueMonitorLease(
  queueName: string,
  owner: string,
  ttlSeconds = QUEUE_MONITOR_LEASE_TTL_SECONDS,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  const key = queueMonitorLeaseKey(queueName);
  const claimed = await redis.set(key, owner, 'EX', ttlSeconds, 'NX');
  if (claimed === 'OK') return true;
  const current = await redis.get(key);
  if (current !== owner) return false;
  await redis.expire(key, ttlSeconds);
  return true;
}

export async function releaseQueueMonitorLease(queueName: string, owner: string): Promise<void> {
  try {
    const redis = await queueRedisSingleton.getClient();
    const key = queueMonitorLeaseKey(queueName);
    if ((await redis.get(key)) === owner) await redis.del(key);
  } catch (error) {
    logError('Queue monitor lease release failed', error, { queueName });
  }
}

export async function writeQueueHealthSnapshot(snapshot: QueueHealthSnapshot): Promise<void> {
  const redis = await queueRedisSingleton.getClient();
  await redis.set(
    queueHealthSnapshotKey(snapshot.queueName),
    JSON.stringify(snapshot),
    'EX',
    getConfig().QUEUE_HEALTH_SNAPSHOT_TTL_SECONDS,
  );
}

export async function readQueueHealthSnapshot(
  queueName: string,
): Promise<QueueHealthSnapshot | null> {
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(queueHealthSnapshotKey(queueName));
    return raw ? (JSON.parse(raw) as QueueHealthSnapshot) : null;
  } catch (error) {
    logError('Queue health snapshot read failed', error, { queueName });
    return null;
  }
}

export async function setQueueAdmission(input: {
  queueName: string;
  mode: QueueAdmissionMode;
  ttlSeconds: number;
  reasonCode: string;
  changedBy: string;
  forceCritical?: boolean;
}): Promise<QueueAdmission> {
  if (!(canonicalQueueCatalog as readonly string[]).includes(input.queueName)) {
    throw new Error(`Unknown canonical queue: ${input.queueName}`);
  }
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 900) {
    throw new Error('Queue admission TTL must be between 1 and 900 seconds');
  }
  if (!input.reasonCode.trim()) throw new Error('Queue admission requires a reason code');
  if (
    input.mode === 'DRAIN_ONLY' &&
    CRITICAL_QUEUES.has(input.queueName) &&
    input.forceCritical !== true
  ) {
    throw new Error(`Critical queue ${input.queueName} requires forceCritical=true`);
  }
  const now = new Date();
  const admission: QueueAdmission = {
    queueName: input.queueName,
    mode: input.mode,
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
    reasonCode: input.reasonCode.trim().slice(0, 120),
    changedAt: now.toISOString(),
    changedBy: input.changedBy.slice(0, 120),
    forceCritical: input.forceCritical === true,
  };
  const redis = await queueRedisSingleton.getClient();
  await redis.set(
    queueAdmissionKey(input.queueName),
    JSON.stringify(admission),
    'EX',
    input.ttlSeconds,
  );
  logInfo('Queue admission changed', {
    queue: input.queueName,
    mode: input.mode,
    reasonCode: admission.reasonCode,
    expiresAt: admission.expiresAt,
  });
  return admission;
}

export async function readQueueAdmission(queueName: string): Promise<QueueAdmission | null> {
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(queueAdmissionKey(queueName));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as QueueAdmission;
    if (Date.parse(parsed.expiresAt) <= Date.now()) return null;
    return parsed;
  } catch (error) {
    logError('Queue admission read failed', error, { queueName });
    return null;
  }
}

export async function isQueueDrainOnly(queueName: string): Promise<boolean> {
  return (await readQueueAdmission(queueName))?.mode === 'DRAIN_ONLY';
}

async function updateAdmissionSample(
  redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>,
  queueName: string,
  red: boolean,
): Promise<number> {
  const redKey = `${RED_SAMPLE_PREFIX}${queueName}`;
  const greenKey = `${GREEN_SAMPLE_PREFIX}${queueName}`;
  if (red) {
    const count = await redis.incr(redKey);
    await redis.expire(redKey, 900);
    // A new red sample invalidates the previous all-green interval.
    await redis.del(greenKey);
    return count;
  }
  await redis.del(redKey);
  const currentGreenSince = await redis.get(greenKey);
  if (!currentGreenSince) {
    await redis.set(greenKey, String(Date.now()), 'EX', 900);
  }
  return 0;
}

async function criticalAdmissionState(
  redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>,
): Promise<{ red: boolean; greenSince: number | null }> {
  let red = false;
  let latestGreenSince = 0;
  let missing = false;
  for (const queueName of CRITICAL_QUEUES) {
    const redCount = Number(await redis.get(`${RED_SAMPLE_PREFIX}${queueName}`));
    if (Number.isFinite(redCount) && redCount >= 2) red = true;
    const since = Number(await redis.get(`${GREEN_SAMPLE_PREFIX}${queueName}`));
    if (!Number.isFinite(since) || since <= 0) {
      // A missing sample is not green. Keep the all-green interval invalid
      // until every critical lane has emitted a valid sample again.
      missing = true;
      continue;
    }
    // The all-green interval begins only after the last critical lane turns
    // green. Using the minimum would allow an old healthy lane to shorten the
    // required five-minute interval while another lane had just recovered.
    latestGreenSince = Math.max(latestGreenSince, since);
  }
  return { red, greenSince: missing || latestGreenSince <= 0 ? null : latestGreenSince };
}

/**
 * Apply the conservative automatic gate policy. It only gates low-priority
 * lanes after two consecutive red samples and never deletes/requeues jobs.
 */
export async function evaluateAutomaticAdmission(
  snapshot: QueueHealthSnapshot,
): Promise<QueueAdmission | null> {
  if (!getConfig().QUEUE_ADMISSION_AUTOMATION_ENABLED) return null;
  const redis = await queueRedisSingleton.getClient();
  const ownRed = await updateAdmissionSample(
    redis,
    snapshot.queueName,
    AUTO_GATE_RED_CLASSES.has(snapshot.backlogClass),
  );
  const criticalState = await criticalAdmissionState(redis);

  // Critical queues are never gated, but their red samples protect the
  // lower-priority lanes. This is deliberately evaluated on every critical
  // monitor pass so a provider or consumer incident can stop new repair work
  // before it amplifies the outage.
  if (CRITICAL_QUEUES.has(snapshot.queueName)) return null;
  if (!AUTO_GATED_QUEUES.has(snapshot.queueName)) return null;

  const red = Math.max(ownRed, criticalState.red ? 2 : 0);
  const existing = await readQueueAdmission(snapshot.queueName);
  if (red < 2) {
    const ownGreenSince = Number(await redis.get(`${GREEN_SAMPLE_PREFIX}${snapshot.queueName}`));
    const allGreenSince =
      criticalState.greenSince === null
        ? null
        : ownGreenSince > 0
          ? Math.max(ownGreenSince, criticalState.greenSince)
          : null;
    if (
      existing?.changedBy === 'queue-governance' &&
      allGreenSince !== null &&
      Date.now() - allGreenSince >= getConfig().QUEUE_ADMISSION_GREEN_CLEAR_MS
    ) {
      await redis.del(queueAdmissionKey(snapshot.queueName));
    } else if (existing?.changedBy === 'queue-governance' && criticalState.red) {
      // A critical incident still exists even if this low lane is locally
      // healthy; do not let its short Redis TTL silently reopen admission.
      await redis.expire(
        queueAdmissionKey(snapshot.queueName),
        getConfig().QUEUE_ADMISSION_GATE_TTL_SECONDS,
      );
    }
    return null;
  }
  const current = await readQueueAdmission(snapshot.queueName);
  if (current?.mode === 'DRAIN_ONLY') {
    if (current.changedBy === 'queue-governance') {
      await redis.expire(
        queueAdmissionKey(snapshot.queueName),
        getConfig().QUEUE_ADMISSION_GATE_TTL_SECONDS,
      );
    }
    return current;
  }
  return setQueueAdmission({
    queueName: snapshot.queueName,
    mode: 'DRAIN_ONLY',
    ttlSeconds: getConfig().QUEUE_ADMISSION_GATE_TTL_SECONDS,
    reasonCode: criticalState.red ? 'AUTO_CRITICAL_BACKLOG' : `AUTO_${snapshot.backlogClass}`,
    changedBy: 'queue-governance',
  });
}

export async function inspectQueue(
  queue: Queue,
  input: {
    releaseSha?: string;
    dispatchBudgetMs?: number;
    consumerHeartbeatAt?: string | null;
    providerWaitP95Ms?: number | null;
    provider429Rate?: number | null;
    waitP50Ms?: number | null;
    waitP95Ms?: number | null;
    executionP50Ms?: number | null;
    executionP95Ms?: number | null;
  } = {},
): Promise<QueueHealthSnapshot> {
  const counts = await queue.getJobCounts(
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'waiting-children',
    'failed',
    'completed',
  );
  const waiting = counts.waiting ?? 0;
  const active = counts.active ?? 0;
  const delayed = counts.delayed ?? 0;
  const prioritized = counts.prioritized ?? 0;
  const waitingChildren = counts['waiting-children'] ?? 0;
  const failed = counts.failed ?? 0;
  const completed = counts.completed ?? 0;
  const oldest =
    waiting + prioritized > 0
      ? (await queue.getJobs(['waiting', 'prioritized'], 0, 0, true))[0]
      : undefined;
  const oldestRunnableAgeMs = oldest ? Math.max(0, Date.now() - oldest.timestamp) : null;
  const arrivals = waiting + active;
  const completions = 0;
  const admission = await readQueueAdmission(queue.name);
  const heartbeatEvidence = Object.prototype.hasOwnProperty.call(input, 'consumerHeartbeatAt')
    ? {
        consumerHeartbeatAgeMs: input.consumerHeartbeatAt
          ? Math.max(0, Date.now() - Date.parse(input.consumerHeartbeatAt))
          : null,
      }
    : {};
  const backlogClass = classifyBacklog({
    waiting,
    active,
    failed,
    oldestRunnableAgeMs,
    dispatchBudgetMs: input.dispatchBudgetMs,
    providerWaitP95Ms: input.providerWaitP95Ms,
    provider429Rate: input.provider429Rate,
    ...heartbeatEvidence,
  });
  return {
    queueName: queue.name,
    observedAt: new Date().toISOString(),
    waiting,
    active,
    delayed,
    prioritized,
    waitingChildren,
    failed,
    completed,
    runnable: waiting + prioritized,
    oldestRunnableAgeMs,
    arrivals,
    completions,
    failures: 0,
    stalled: 0,
    waitP50Ms: input.waitP50Ms ?? null,
    waitP95Ms: input.waitP95Ms ?? null,
    executionP50Ms: input.executionP50Ms ?? null,
    executionP95Ms: input.executionP95Ms ?? null,
    providerWaitP95Ms: input.providerWaitP95Ms ?? null,
    provider429Rate: input.provider429Rate ?? null,
    netGrowth: arrivals - completions,
    drainEtaMs: calculateDrainEtaMs(waiting + prioritized, arrivals, completions),
    backlogClass,
    admissionMode: admission?.mode ?? 'OPEN',
    consumerHeartbeatAt: input.consumerHeartbeatAt ?? null,
    releaseSha: input.releaseSha ?? process.env.DEPLOY_SHA ?? 'unknown',
  };
}
