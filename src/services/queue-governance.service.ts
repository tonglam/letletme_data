import type { Job, Queue } from 'bullmq';

import { queueRedisSingleton } from '../queues/redis';
import { canonicalQueueCatalog } from '../domain/data-contracts';
import { getConfig } from '../utils/config';
import { logError, logInfo } from '../utils/logger';
import type { QueueMonitorRuntimeState } from '../utils/runtime-heartbeat';

export type BacklogClass =
  | 'NO_CONSUMER'
  | 'POISON_STORM'
  | 'STALLED'
  | 'DEADLINE_RISK'
  | 'ADMISSION_SATURATED'
  | 'PROVIDER_THROTTLED'
  | 'BURST'
  | 'HEALTHY';
export type QueueAdmissionMode = 'OPEN' | 'DRAIN_ONLY';

export type QueueHealthSnapshot = Readonly<{
  queueName: string;
  observedAt: string;
  /** Budget selected for the oldest runnable job, when one is available. */
  dispatchBudgetMs?: number;
  waiting: number;
  active: number;
  delayed: number;
  prioritized: number;
  waitingChildren: number;
  consumerPaused: boolean;
  pausedCount: number;
  pauseOwnerState: QueueConsumerPauseOwnerState;
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
  admissionWaitP95Ms?: number | null;
  admissionDeadlineExceeded?: number;
  admissionStoreUnavailable?: number;
  netGrowth: number;
  drainEtaMs: number | null;
  backlogClass: BacklogClass;
  admissionMode: QueueAdmissionMode;
  consumerHeartbeatAt: string | null;
  releaseSha: string;
}>;

/**
 * A missing point-in-time snapshot is not itself proof that a queue has no
 * consumer. Optional feature queues may deliberately have no worker when the
 * feature is disabled, while an enabled queue with no snapshot is an
 * observation gap. Keep that distinction explicit in status responses rather
 * than manufacturing a healthy-looking snapshot.
 */
export type QueueHealthState = 'OBSERVED' | 'DISABLED' | 'UNOBSERVED';

export function resolveQueueHealthState(input: {
  snapshot: QueueHealthSnapshot | null;
  monitorEnabled?: boolean;
  monitorState?: QueueMonitorRuntimeState;
}): QueueHealthState {
  if (input.monitorEnabled === false || input.monitorState === 'DISABLED') return 'DISABLED';
  return input.snapshot ? 'OBSERVED' : 'UNOBSERVED';
}

export type QueueAdmission = Readonly<{
  queueName: string;
  mode: QueueAdmissionMode;
  expiresAt: string;
  reasonCode: string;
  changedAt: string;
  changedBy: string;
  forceCritical: boolean;
}>;

export type QueueAdmissionMutationInput = Readonly<{
  queueName: string;
  mode: QueueAdmissionMode;
  ttlSeconds: number;
  reasonCode: string;
  changedBy: string;
  forceCritical?: boolean;
}>;

export type QueueAdmissionCompareAndSetResult = Readonly<{
  swapped: boolean;
  admission: QueueAdmission | null;
}>;

export class QueueDrainOnlyError extends Error {
  readonly status = 503;
  readonly code = 'QUEUE_DRAIN_ONLY';
  readonly queueName: string;
  readonly retryAfterSeconds: number;

  constructor(queueName: string, retryAfterSeconds = 60) {
    super(`Queue ${queueName} is drain-only; new work is temporarily paused`);
    this.name = 'QueueDrainOnlyError';
    this.queueName = queueName;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const SNAPSHOT_PREFIX = 'ops:queue-health:';
const ADMISSION_PREFIX = 'ops:queue-admission:';
const CONSUMER_PAUSE_OWNER_PREFIX = 'ops:queue-consumer-pause-owner:';
const RED_SAMPLE_PREFIX = 'ops:queue-admission-red:';
const GREEN_SAMPLE_PREFIX = 'ops:queue-admission-green-since:';
const MONITOR_LEASE_PREFIX = 'ops:queue-monitor-leader:';
export const QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS = 3_600;
// A pause acquisition is only an in-flight control transition. Keep its
// marker short-lived so a process that dies between BullMQ pause and owner
// finalization cannot hold the queue for the full completed-owner TTL.
export const QUEUE_CONSUMER_PAUSE_ACQUISITION_TTL_SECONDS = 60;
export const QUEUE_CONSUMER_PAUSE_OPERATOR = 'operator';
const QUEUE_CONSUMER_PAUSE_ACQUIRING_PREFIX = 'acquiring:';
const QUEUE_CONSUMER_PAUSE_RELEASING_PREFIX = 'releasing:';

/**
 * Consumer pause is a BullMQ queue-level state, so BullMQ itself has no
 * ownership token that can be checked when a deployment later resumes it.
 * Keep that ownership in a separate Redis key and fence the release with a
 * short atomic transition.  The marker is deliberately not part of the
 * queue payload or business data.
 */
export const MARK_QUEUE_CONSUMER_OPERATOR_PAUSE_LUA = `
local current = redis.call('GET', KEYS[1])
local releasingPrefix = ARGV[1]
if current and string.sub(current, 1, string.len(releasingPrefix)) == releasingPrefix then
  return 0
end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;
export const CLAIM_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA = `
local current = redis.call('GET', KEYS[1])
local owner = ARGV[1]
local acquiring = ARGV[2]
if current == owner then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end
if current and current ~= acquiring then return 0 end
redis.call('SET', KEYS[1], acquiring, 'EX', ARGV[3])
return 1
`;
export const COMPLETE_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA = `
local current = redis.call('GET', KEYS[1])
if current == ARGV[2] then
  redis.call('EXPIRE', KEYS[1], ARGV[3])
  return 1
end
if current ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
export const ABORT_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
export const TOUCH_QUEUE_CONSUMER_PAUSE_OWNER_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('EXPIRE', KEYS[1], ARGV[2])
`;
export const BEGIN_QUEUE_CONSUMER_PAUSE_RELEASE_LUA = `
local current = redis.call('GET', KEYS[1])
local owner = ARGV[1]
local acquiring = ARGV[2]
local releasing = ARGV[3]
if current == owner then
  redis.call('SET', KEYS[1], releasing, 'EX', ARGV[4])
  return 1
end
if current == acquiring then
  redis.call('SET', KEYS[1], releasing, 'EX', ARGV[4])
  return 1
end
if current == releasing then
  redis.call('EXPIRE', KEYS[1], ARGV[4])
  return 1
end
return 0
`;
export const COMPLETE_QUEUE_CONSUMER_PAUSE_RELEASE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;
export const COMPARE_AND_SET_QUEUE_ADMISSION_LUA = `
local current = redis.call('GET', KEYS[1])
local expected = ARGV[1]
if ARGV[4] == 'OPEN' and #KEYS >= 2 and redis.call('HGET', KEYS[2], 'paused') == '1' then
  return {0, current or ''}
end
if expected == '' then
  if current then return {0, current} end
elseif not current or current ~= expected then
  return {0, current or ''}
end
local replacement = ARGV[2]
redis.call('SET', KEYS[1], replacement, 'EX', ARGV[3])
return {1, replacement}
`;
export const QUEUE_HEALTH_RETENTION_LEASE_QUEUE = '__queue-health-retention__';
export const QUEUE_HEALTH_RETENTION_DAYS = 35;
export const QUEUE_HEALTH_RETENTION_BATCH_SIZE = 5_000;
export const QUEUE_HEALTH_RETENTION_MAX_BATCHES = 20;
export const QUEUE_MONITOR_LEASE_TTL_SECONDS = 75;
const AUTO_GATED_QUEUES = new Set(['data-repair', 'housekeeping', 'entry-onboarding']);
const AUTO_GATE_RED_CLASSES = new Set<BacklogClass>([
  'NO_CONSUMER',
  'POISON_STORM',
  'STALLED',
  'DEADLINE_RISK',
  'ADMISSION_SATURATED',
  'PROVIDER_THROTTLED',
]);
const CRITICAL_QUEUES = new Set([
  'live-data',
  'live-picks',
  'official-h2h-live',
  'publication-outbox',
  'my-fpl-orchestration',
  'fpl-price-watch',
]);

export function queueHealthRetentionCutoff(
  now = new Date(),
  retentionDays = QUEUE_HEALTH_RETENTION_DAYS,
): Date {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) {
    throw new Error('Queue health retention days must be a positive integer');
  }
  return new Date(now.getTime() - retentionDays * 86_400_000);
}

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
    admissionWaitP95Ms?: number | null;
    admissionDeadlineExceeded?: number;
    admissionStoreUnavailable?: number;
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
  if (
    (input.admissionDeadlineExceeded ?? 0) > 0 ||
    (input.admissionStoreUnavailable ?? 0) > 0 ||
    (input.admissionWaitP95Ms ?? 0) > 500
  ) {
    return 'ADMISSION_SATURATED';
  }
  // Provider throttling is reserved for real FPL 429 responses. Local
  // admission wait and 5xx/network failures have separate classifications.
  if ((input.provider429Rate ?? 0) >= 0.05) {
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

export function queueConsumerMetaKey(queueName: string): string {
  return `bull:${queueName}:meta`;
}

export function queueConsumerPauseOwnerKey(queueName: string): string {
  const normalized = queueName.trim();
  if (!normalized) throw new Error('Queue consumer pause owner requires a queue name');
  return `${CONSUMER_PAUSE_OWNER_PREFIX}${normalized}`;
}

export function deploymentQueueConsumerPauseOwner(ownerToken: string): string {
  const normalized = ownerToken.trim();
  if (!normalized) throw new Error('Queue consumer pause owner requires an owner token');
  return `deployment:${normalized}`;
}

export function acquiringQueueConsumerPauseOwner(owner: string): string {
  const normalized = owner.trim();
  if (!normalized) throw new Error('Queue consumer pause owner requires an owner token');
  return `${QUEUE_CONSUMER_PAUSE_ACQUIRING_PREFIX}${normalized}`;
}

export function releasingQueueConsumerPauseOwner(owner: string): string {
  return `${QUEUE_CONSUMER_PAUSE_RELEASING_PREFIX}${owner}`;
}

export type QueueConsumerPauseOwnerState =
  | 'NONE'
  | 'DEPLOYMENT'
  | 'ACQUIRING'
  | 'OPERATOR'
  | 'RELEASING';

export function queueConsumerPauseOwnerState(owner: string | null): QueueConsumerPauseOwnerState {
  if (!owner) return 'NONE';
  if (owner === QUEUE_CONSUMER_PAUSE_OPERATOR) return 'OPERATOR';
  if (owner.startsWith(QUEUE_CONSUMER_PAUSE_RELEASING_PREFIX)) return 'RELEASING';
  if (owner.startsWith(QUEUE_CONSUMER_PAUSE_ACQUIRING_PREFIX)) return 'ACQUIRING';
  if (owner.startsWith('deployment:')) return 'DEPLOYMENT';
  return 'NONE';
}

export async function readQueueConsumerPauseOwner(queueName: string): Promise<string | null> {
  const redis = await queueRedisSingleton.getClient();
  return redis.get(queueConsumerPauseOwnerKey(queueName));
}

export async function claimQueueConsumerPauseAcquisition(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        CLAIM_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        owner,
        acquiringQueueConsumerPauseOwner(owner),
        String(QUEUE_CONSUMER_PAUSE_ACQUISITION_TTL_SECONDS),
      ),
    ) === 1
  );
}

export async function completeQueueConsumerPauseAcquisition(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        COMPLETE_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        acquiringQueueConsumerPauseOwner(owner),
        owner,
        String(QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS),
      ),
    ) === 1
  );
}

export async function abortQueueConsumerPauseAcquisition(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        ABORT_QUEUE_CONSUMER_PAUSE_ACQUISITION_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        acquiringQueueConsumerPauseOwner(owner),
      ),
    ) === 1
  );
}

export async function touchQueueConsumerPauseOwner(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        TOUCH_QUEUE_CONSUMER_PAUSE_OWNER_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        owner,
        String(QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS),
      ),
    ) === 1
  );
}

/** Mark a no-token pause as an explicit operator-owned pause. */
export async function markQueueConsumerOperatorPaused(queueName: string): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  const result = (await redis.eval(
    MARK_QUEUE_CONSUMER_OPERATOR_PAUSE_LUA,
    1,
    queueConsumerPauseOwnerKey(queueName),
    QUEUE_CONSUMER_PAUSE_RELEASING_PREFIX,
    QUEUE_CONSUMER_PAUSE_OPERATOR,
  )) as number | string;
  return Number(result) === 1;
}

/**
 * Move an exact owner to a releasing marker.  A concurrent supported pause
 * operation cannot overwrite a releasing marker, so it cannot be undone by
 * the deployment's later BullMQ resume call.
 */
export async function beginQueueConsumerPauseRelease(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        BEGIN_QUEUE_CONSUMER_PAUSE_RELEASE_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        owner,
        acquiringQueueConsumerPauseOwner(owner),
        releasingQueueConsumerPauseOwner(owner),
        String(QUEUE_CONSUMER_PAUSE_OWNER_TTL_SECONDS),
      ),
    ) === 1
  );
}

export async function completeQueueConsumerPauseRelease(
  queueName: string,
  owner: string,
): Promise<boolean> {
  const redis = await queueRedisSingleton.getClient();
  return (
    Number(
      await redis.eval(
        COMPLETE_QUEUE_CONSUMER_PAUSE_RELEASE_LUA,
        1,
        queueConsumerPauseOwnerKey(queueName),
        releasingQueueConsumerPauseOwner(owner),
      ),
    ) === 1
  );
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
  // Unit tests run without Redis by design. Integration tests set the
  // explicit RUN_INTEGRATION flag and retain the real queue-health reader.
  if (process.env.NODE_ENV === 'test' && process.env.RUN_INTEGRATION !== '1') return null;
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(queueHealthSnapshotKey(queueName));
    return raw ? (JSON.parse(raw) as QueueHealthSnapshot) : null;
  } catch (error) {
    logError('Queue health snapshot read failed', error, { queueName });
    return null;
  }
}

function validateQueueAdmissionInput(input: QueueAdmissionMutationInput): void {
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
}

function buildQueueAdmission(input: QueueAdmissionMutationInput, now = new Date()): QueueAdmission {
  validateQueueAdmissionInput(input);
  return {
    queueName: input.queueName,
    mode: input.mode,
    expiresAt: new Date(now.getTime() + input.ttlSeconds * 1_000).toISOString(),
    reasonCode: input.reasonCode.trim().slice(0, 120),
    changedAt: now.toISOString(),
    changedBy: input.changedBy.slice(0, 120),
    forceCritical: input.forceCritical === true,
  };
}

function parseQueueAdmissionRaw(raw: string, queueName: string): QueueAdmission {
  const parsed = JSON.parse(raw) as Partial<QueueAdmission>;
  if (
    parsed.queueName !== queueName ||
    (parsed.mode !== 'OPEN' && parsed.mode !== 'DRAIN_ONLY') ||
    typeof parsed.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.expiresAt)) ||
    typeof parsed.reasonCode !== 'string' ||
    typeof parsed.changedAt !== 'string' ||
    !Number.isFinite(Date.parse(parsed.changedAt)) ||
    typeof parsed.changedBy !== 'string' ||
    typeof parsed.forceCritical !== 'boolean'
  ) {
    throw new Error(`Invalid queue admission state for ${queueName}`);
  }
  return parsed as QueueAdmission;
}

function logQueueAdmissionChanged(admission: QueueAdmission): void {
  logInfo('Queue admission changed', {
    queue: admission.queueName,
    mode: admission.mode,
    reasonCode: admission.reasonCode,
    expiresAt: admission.expiresAt,
  });
}

export async function setQueueAdmission(
  input: QueueAdmissionMutationInput,
): Promise<QueueAdmission> {
  const admission = buildQueueAdmission(input);
  const redis = await queueRedisSingleton.getClient();
  await redis.set(
    queueAdmissionKey(input.queueName),
    JSON.stringify(admission),
    'EX',
    input.ttlSeconds,
  );
  logQueueAdmissionChanged(admission);
  return admission;
}

/**
 * Replace a queue admission only when Redis still contains the exact value
 * observed by the caller. The absent-key case is also guarded in Lua so a
 * deployment cannot overwrite an operator gate that arrived between its
 * read and its write.
 */
export async function compareAndSetQueueAdmission(
  input: QueueAdmissionMutationInput & {
    expected: QueueAdmission | null;
    consumerMetaKey?: string;
  },
): Promise<QueueAdmissionCompareAndSetResult> {
  validateQueueAdmissionInput(input);
  if (input.expected && input.expected.queueName !== input.queueName) {
    throw new Error('Queue admission compare-and-set expected queue does not match target queue');
  }

  const now = new Date();
  const admission = buildQueueAdmission(input, now);
  const redis = await queueRedisSingleton.getClient();
  const keys = [queueAdmissionKey(input.queueName)];
  const args = [
    input.expected ? JSON.stringify(input.expected) : '',
    JSON.stringify(admission),
    String(input.ttlSeconds),
    input.consumerMetaKey ? 'OPEN' : '',
  ];
  if (input.consumerMetaKey) keys.push(input.consumerMetaKey);
  const result = (await redis.eval(
    COMPARE_AND_SET_QUEUE_ADMISSION_LUA,
    keys.length,
    ...keys,
    ...args,
  )) as [number | string, string?];
  const swapped = Number(result[0]) === 1;
  const currentRaw = result[1] ?? '';
  const current = currentRaw ? parseQueueAdmissionRaw(currentRaw, input.queueName) : null;
  if (swapped) logQueueAdmissionChanged(admission);
  return { swapped, admission: current };
}

export async function readQueueAdmission(queueName: string): Promise<QueueAdmission | null> {
  // Keep queue producers hermetic in unit tests. The production and guarded
  // integration paths still read the durable Redis admission gate.
  if (process.env.NODE_ENV === 'test' && process.env.RUN_INTEGRATION !== '1') return null;
  try {
    const redis = await queueRedisSingleton.getClient();
    const raw = await redis.get(queueAdmissionKey(queueName));
    if (!raw) return null;
    const parsed = parseQueueAdmissionRaw(raw, queueName);
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
  const greenRetentionSeconds = Math.max(
    getConfig().QUEUE_ADMISSION_GATE_TTL_SECONDS,
    Math.ceil(getConfig().QUEUE_ADMISSION_GREEN_CLEAR_MS / 1_000),
  );
  if (!currentGreenSince) {
    await redis.set(greenKey, String(Date.now()), 'EX', greenRetentionSeconds);
  } else {
    // Preserve the original green-since timestamp while extending the key's
    // TTL. A fixed 15-minute expiry would make a configured 24-hour clear
    // interval restart forever before the gate can automatically open.
    await redis.expire(greenKey, greenRetentionSeconds);
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
    } else if (
      existing?.changedBy === 'queue-governance' &&
      (criticalState.red || criticalState.greenSince === null || ownGreenSince <= 0)
    ) {
      // A critical incident, or an incomplete critical/own evidence sample,
      // still exists even if this low lane is locally healthy; do not let its
      // short Redis TTL silently reopen admission while the monitor is blind.
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
    /** Return null when a mixed lane has no safe per-job budget. */
    dispatchBudgetForJob?: (job: Pick<Job, 'name' | 'data'>) => number | null | undefined;
    consumerHeartbeatAt?: string | null;
    providerWaitP95Ms?: number | null;
    provider429Rate?: number | null;
    admissionWaitP95Ms?: number | null;
    admissionDeadlineExceeded?: number;
    admissionStoreUnavailable?: number;
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
    'paused',
    'failed',
    'completed',
  );
  const waiting = counts.waiting ?? 0;
  const active = counts.active ?? 0;
  const delayed = counts.delayed ?? 0;
  const prioritized = counts.prioritized ?? 0;
  const waitingChildren = counts['waiting-children'] ?? 0;
  const pausedCount = counts.paused ?? 0;
  const redis = await queueRedisSingleton.getClient();
  const [pauseMarker, pauseOwner] = await Promise.all([
    redis.hget(queueConsumerMetaKey(queue.name), 'paused'),
    readQueueConsumerPauseOwner(queue.name),
  ]);
  const pauseOwnerState = queueConsumerPauseOwnerState(pauseOwner);
  const consumerPaused = pauseMarker === '1' || pausedCount > 0;
  const failed = counts.failed ?? 0;
  const completed = counts.completed ?? 0;
  const oldest =
    waiting + prioritized > 0
      ? (await queue.getJobs(['waiting', 'prioritized'], 0, 0, true))[0]
      : undefined;
  const oldestRunnableAgeMs = oldest ? Math.max(0, Date.now() - oldest.timestamp) : null;
  const selectedDispatchBudget = oldest ? input.dispatchBudgetForJob?.(oldest) : undefined;
  const dispatchBudgetMs =
    selectedDispatchBudget === null
      ? undefined
      : (selectedDispatchBudget ?? input.dispatchBudgetMs);
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
    dispatchBudgetMs,
    providerWaitP95Ms: input.providerWaitP95Ms,
    provider429Rate: input.provider429Rate,
    admissionWaitP95Ms: input.admissionWaitP95Ms,
    admissionDeadlineExceeded: input.admissionDeadlineExceeded,
    admissionStoreUnavailable: input.admissionStoreUnavailable,
    ...heartbeatEvidence,
  });
  return {
    queueName: queue.name,
    observedAt: new Date().toISOString(),
    dispatchBudgetMs,
    waiting,
    active,
    delayed,
    prioritized,
    waitingChildren,
    consumerPaused,
    pausedCount,
    pauseOwnerState,
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
    admissionWaitP95Ms: input.admissionWaitP95Ms ?? null,
    admissionDeadlineExceeded: input.admissionDeadlineExceeded ?? 0,
    admissionStoreUnavailable: input.admissionStoreUnavailable ?? 0,
    netGrowth: arrivals - completions,
    drainEtaMs: calculateDrainEtaMs(waiting + prioritized, arrivals, completions),
    backlogClass,
    admissionMode: admission?.mode ?? 'OPEN',
    consumerHeartbeatAt: input.consumerHeartbeatAt ?? null,
    releaseSha: input.releaseSha ?? process.env.DEPLOY_SHA ?? 'unknown',
  };
}
