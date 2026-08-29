import { randomUUID } from 'node:crypto';

import { queueRedisSingleton } from '../queues/redis';
import { FPLClientError } from './errors';
import { logDebug } from './logger';
import { getConfig, parseStrictBooleanEnvValue } from './config';
import { getJobLogContext } from './job-log-context';

export type FplRequestPriority = 'deadline-critical' | 'live' | 'bulk';
export type FplAdmissionWaitReason =
  | 'rate'
  | 'capacity'
  | 'critical-reservation'
  | 'class-fairness'
  | 'critical-priority';
export type FplAdmissionOutcome =
  | 'granted'
  | 'deadline-exceeded'
  | 'store-unavailable'
  | 'cancelled';

const runtimeConfig = getConfig();
const MAX_INFLIGHT = runtimeConfig.FPL_MAX_INFLIGHT;
const BULK_MAX_INFLIGHT = Math.max(
  1,
  Math.min(
    MAX_INFLIGHT - Math.min(2, MAX_INFLIGHT),
    runtimeConfig.FPL_BULK_MAX_INFLIGHT_DURING_LIVE,
  ),
);
const REQUESTS_PER_SECOND = runtimeConfig.FPL_REQUESTS_PER_SECOND;
const TOKEN_BUCKET_CAPACITY = REQUESTS_PER_SECOND;
const CRITICAL_MAX_INFLIGHT = 1;
const LIVE_BURST_MAX = 3;
const LEASE_MS = runtimeConfig.FPL_ADMISSION_LEASE_MS;
const MAX_UNBOUNDED_ADMISSION_WAIT_MS = 5 * 60_000;

const STATE_KEY = 'llm:fpl:admission:state';
const LEASES_KEY = 'llm:fpl:admission:leases';
const LEASE_KEY_PREFIX = 'llm:fpl:admission:lease:';
const LEASE_META_KEY = 'llm:fpl:admission:lease-meta';
const WAITERS_CRITICAL_KEY = 'llm:fpl:admission:waiters:deadline-critical';
const WAITERS_LIVE_KEY = 'llm:fpl:admission:waiters:live';
const WAITERS_BULK_KEY = 'llm:fpl:admission:waiters:bulk';
const WAITERS_EXPIRY_KEY = 'llm:fpl:admission:waiters:expiry';
const WAITERS_PRIORITY_KEY = 'llm:fpl:admission:waiters:priority';
const ADMISSION_SCRIPT_VERSION = 'v4';

const TELEMETRY_PREFIX = 'ops:fpl-admission:telemetry:';
const ADMISSION_KEY_PREFIX_OVERRIDE =
  process.env.FPL_ADMISSION_KEY_PREFIX?.trim() ||
  (process.env.RUN_INTEGRATION === '1' ? `llm:fpl:admission:integration:${process.pid}` : '');
const TELEMETRY_KEY_PREFIX = ADMISSION_KEY_PREFIX_OVERRIDE
  ? `${ADMISSION_KEY_PREFIX_OVERRIDE}:telemetry:`
  : TELEMETRY_PREFIX;
const TELEMETRY_TTL_SECONDS = 300;
const TELEMETRY_WINDOW_MS = 60_000;
const TELEMETRY_GLOBAL_SCOPE = '__all__';
const TELEMETRY_UNATTRIBUTED_SCOPE = 'unattributed';
const WAIT_HISTOGRAM_BUCKETS = [
  0, 25, 50, 100, 250, 300, 500, 750, 1_000, 2_000, 5_000, 10_000, 60_000,
] as const;
const PROVIDER_DURATION_BUCKETS = [
  0, 25, 50, 100, 250, 500, 750, 1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
] as const;

export type FplAdmissionClassTelemetry = Readonly<{
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  waitP99Ms: number | null;
  waitSamples: number;
  grants: number;
  deadlineExceeded: number;
  storeUnavailable: number;
  cancelled: number;
  providerDurationP50Ms: number | null;
  providerDurationP95Ms: number | null;
  providerDurationP99Ms: number | null;
  providerDurationSamples: number;
  responseSamples: number;
  response429: number;
  response5xx: number;
  networkErrors: number;
}>;

export type FplAdmissionTelemetry = Readonly<{
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  waitP99Ms: number | null;
  waitSamples: number;
  grants: number;
  deadlineExceeded: number;
  storeUnavailable: number;
  cancelled: number;
  providerDurationP50Ms: number | null;
  providerDurationP95Ms: number | null;
  providerDurationP99Ms: number | null;
  providerDurationSamples: number;
  response429Rate: number | null;
  response5xxRate: number | null;
  networkErrorRate: number | null;
  responseSamples: number;
  byPriority: Readonly<Record<FplRequestPriority, FplAdmissionClassTelemetry>>;
}>;

export type FplAdmissionLease = Readonly<{
  token: string;
  priority: FplRequestPriority;
  waitMs: number;
  acquiredAt: number;
  release: () => Promise<void>;
}>;

export type FplAdmissionStats = Readonly<{
  policyVersion: string;
  inflight: number;
  liveInflight: number;
  criticalInflight: number;
  bulkInflight: number;
  queued: number;
  queuedByPriority: Readonly<Record<FplRequestPriority, number>>;
  maxInflight: number;
  criticalMaxInflight: number;
  bulkMaxInflight: number;
  requestsPerSecond: number;
  tokenBucketCapacity: number;
  tokens: number;
  criticalWindow: Readonly<{ active: boolean; untilMs: number | null; owner: string | null }>;
  distributed: boolean;
}>;

function useLocalTestScheduler(): boolean {
  return (
    (runtimeConfig.NODE_ENV === 'test' && process.env.RUN_INTEGRATION !== '1') ||
    parseStrictBooleanEnvValue(
      process.env.FPL_ADMISSION_TEST_MODE,
      false,
      'FPL_ADMISSION_TEST_MODE',
    )
  );
}

function assertPriority(priority: string): asserts priority is FplRequestPriority {
  if (priority !== 'deadline-critical' && priority !== 'live' && priority !== 'bulk') {
    throw new Error(`Unknown FPL admission priority: ${priority}`);
  }
}

function sanitizeTelemetryLabel(value: string): string {
  return (
    value
      .trim()
      .replace(/[^a-zA-Z0-9_.-]+/g, '_')
      .slice(0, 80) || TELEMETRY_UNATTRIBUTED_SCOPE
  );
}

function telemetryScopes(): readonly string[] {
  const context = getJobLogContext();
  const queueName = context?.queueName;
  const jobName = context?.jobName;
  if (!queueName) {
    return [
      TELEMETRY_UNATTRIBUTED_SCOPE,
      ...(jobName ? [sanitizeTelemetryLabel(`${TELEMETRY_UNATTRIBUTED_SCOPE}:${jobName}`)] : []),
    ];
  }
  const queueScope = sanitizeTelemetryLabel(queueName);
  return [queueScope, ...(jobName ? [sanitizeTelemetryLabel(`${queueName}:${jobName}`)] : [])];
}

function telemetryKey(now = Date.now(), scope = TELEMETRY_GLOBAL_SCOPE): string {
  return `${TELEMETRY_KEY_PREFIX}${Math.floor(now / TELEMETRY_WINDOW_MS)}:${scope}`;
}

function namespacedAdmissionKey(base: string): string {
  if (!ADMISSION_KEY_PREFIX_OVERRIDE) return base;
  const root = 'llm:fpl:admission:';
  if (!base.startsWith(root)) throw new Error(`Unexpected FPL admission key: ${base}`);
  return `${ADMISSION_KEY_PREFIX_OVERRIDE}:${base.slice(root.length)}`;
}

function admissionKeys(): Readonly<{
  state: string;
  leases: string;
  leasePrefix: string;
  leaseMeta: string;
  waitersCritical: string;
  waitersLive: string;
  waitersBulk: string;
  waitersExpiry: string;
  waitersPriority: string;
}> {
  return {
    state: namespacedAdmissionKey(STATE_KEY),
    leases: namespacedAdmissionKey(LEASES_KEY),
    leasePrefix: namespacedAdmissionKey(LEASE_KEY_PREFIX),
    leaseMeta: namespacedAdmissionKey(LEASE_META_KEY),
    waitersCritical: namespacedAdmissionKey(WAITERS_CRITICAL_KEY),
    waitersLive: namespacedAdmissionKey(WAITERS_LIVE_KEY),
    waitersBulk: namespacedAdmissionKey(WAITERS_BULK_KEY),
    waitersExpiry: namespacedAdmissionKey(WAITERS_EXPIRY_KEY),
    waitersPriority: namespacedAdmissionKey(WAITERS_PRIORITY_KEY),
  };
}

function field(priority: FplRequestPriority, suffix: string): string {
  return `${priority}:${suffix}`;
}

function waitBucket(waitMs: number): number {
  const bounded = Math.max(0, Math.floor(waitMs));
  return (
    WAIT_HISTOGRAM_BUCKETS.find((bucket) => bounded <= bucket) ??
    WAIT_HISTOGRAM_BUCKETS[WAIT_HISTOGRAM_BUCKETS.length - 1]
  );
}

function providerDurationBucket(durationMs: number): number {
  const bounded = Math.max(0, Math.floor(durationMs));
  return (
    PROVIDER_DURATION_BUCKETS.find((bucket) => bounded <= bucket) ??
    PROVIDER_DURATION_BUCKETS[PROVIDER_DURATION_BUCKETS.length - 1]
  );
}

function incrementTelemetry(fields: readonly (readonly [string, number])[]): void {
  if (useLocalTestScheduler()) return;
  const now = Date.now();
  const scopes = [TELEMETRY_GLOBAL_SCOPE, ...telemetryScopes()];
  const keys = [...new Set(scopes)].map((scope) => telemetryKey(now, scope));
  void queueRedisSingleton
    .getClient()
    .then((redis) => {
      const pipeline = redis.multi();
      for (const key of keys) {
        for (const [name, value] of fields) pipeline.hincrby(key, name, value);
        pipeline.expire(key, TELEMETRY_TTL_SECONDS);
      }
      return pipeline.exec();
    })
    .catch(() => undefined);
}

export function recordFplAdmissionResult(input: {
  priority: FplRequestPriority;
  outcome: FplAdmissionOutcome;
  waitMs?: number;
  reason?: FplAdmissionWaitReason;
}): void {
  const fields: Array<readonly [string, number]> = [];
  if (input.waitMs !== undefined && Number.isFinite(input.waitMs)) {
    const bucket = waitBucket(input.waitMs);
    fields.push([field(input.priority, 'waitSamples'), 1]);
    fields.push([field(input.priority, `waitLe${bucket}`), 1]);
  }
  if (input.outcome === 'granted') fields.push([field(input.priority, 'grants'), 1]);
  if (input.outcome === 'deadline-exceeded') {
    fields.push([field(input.priority, 'deadlineExceeded'), 1]);
  }
  if (input.outcome === 'store-unavailable') {
    fields.push([field(input.priority, 'storeUnavailable'), 1]);
  }
  if (input.outcome === 'cancelled') {
    fields.push([field(input.priority, 'cancelled'), 1]);
  }
  if (input.reason) fields.push([field(input.priority, `waitReason:${input.reason}`), 1]);
  if (fields.length > 0) incrementTelemetry(fields);
}

/** Record provider status independently of admission capacity. */
export function recordFplResponseTelemetry(
  status: number | null,
  priority: FplRequestPriority = 'bulk',
  providerDurationMs?: number,
): void {
  const fields: Array<readonly [string, number]> = [
    [field(priority, 'responseSamples'), 1],
    ...(status === 429 ? ([[field(priority, 'response429'), 1]] as const) : []),
    ...(status !== null && status >= 500 ? ([[field(priority, 'response5xx'), 1]] as const) : []),
    ...(status === null ? ([[field(priority, 'networkErrors'), 1]] as const) : []),
  ];
  if (providerDurationMs !== undefined && Number.isFinite(providerDurationMs)) {
    fields.push([field(priority, 'providerDurationSamples'), 1]);
    fields.push([
      field(priority, `providerDurationLe${providerDurationBucket(providerDurationMs)}`),
      1,
    ]);
  }
  incrementTelemetry(fields);
}

function emptyClassTelemetry(): FplAdmissionClassTelemetry {
  return {
    waitP50Ms: null,
    waitP95Ms: null,
    waitP99Ms: null,
    waitSamples: 0,
    grants: 0,
    deadlineExceeded: 0,
    storeUnavailable: 0,
    cancelled: 0,
    providerDurationP50Ms: null,
    providerDurationP95Ms: null,
    providerDurationP99Ms: null,
    providerDurationSamples: 0,
    responseSamples: 0,
    response429: 0,
    response5xx: 0,
    networkErrors: 0,
  };
}

function percentileFromCumulativeHistogram(
  bucket: Record<number, number>,
  samples: number,
  rank: number,
  thresholds: readonly number[] = WAIT_HISTOGRAM_BUCKETS,
): number | null {
  if (samples <= 0) return null;
  const target = Math.max(1, Math.ceil(samples * rank));
  let cumulative = 0;
  for (const threshold of thresholds) {
    cumulative += bucket[threshold] ?? 0;
    if (cumulative >= target) return threshold;
  }
  return thresholds[thresholds.length - 1] ?? null;
}

function readClassTelemetry(
  buckets: readonly Record<string, string>[],
  priority: FplRequestPriority,
): FplAdmissionClassTelemetry {
  const histogram: Record<number, number> = {};
  let waitSamples = 0;
  let grants = 0;
  let deadlineExceeded = 0;
  let storeUnavailable = 0;
  let cancelled = 0;
  let providerDurationSamples = 0;
  let responseSamples = 0;
  let response429 = 0;
  let response5xx = 0;
  let networkErrors = 0;
  for (const bucket of buckets) {
    waitSamples += Number(bucket[field(priority, 'waitSamples')] ?? 0);
    grants += Number(bucket[field(priority, 'grants')] ?? 0);
    deadlineExceeded += Number(bucket[field(priority, 'deadlineExceeded')] ?? 0);
    storeUnavailable += Number(bucket[field(priority, 'storeUnavailable')] ?? 0);
    cancelled += Number(bucket[field(priority, 'cancelled')] ?? 0);
    providerDurationSamples += Number(bucket[field(priority, 'providerDurationSamples')] ?? 0);
    responseSamples += Number(bucket[field(priority, 'responseSamples')] ?? 0);
    response429 += Number(bucket[field(priority, 'response429')] ?? 0);
    response5xx += Number(bucket[field(priority, 'response5xx')] ?? 0);
    networkErrors += Number(bucket[field(priority, 'networkErrors')] ?? 0);
    for (const threshold of WAIT_HISTOGRAM_BUCKETS) {
      histogram[threshold] =
        (histogram[threshold] ?? 0) + Number(bucket[field(priority, `waitLe${threshold}`)] ?? 0);
    }
  }
  const providerDurationHistogram: Record<number, number> = {};
  for (const bucket of buckets) {
    for (const threshold of PROVIDER_DURATION_BUCKETS) {
      providerDurationHistogram[threshold] =
        (providerDurationHistogram[threshold] ?? 0) +
        Number(bucket[field(priority, `providerDurationLe${threshold}`)] ?? 0);
    }
  }
  return {
    waitP50Ms: percentileFromCumulativeHistogram(histogram, waitSamples, 0.5),
    waitP95Ms: percentileFromCumulativeHistogram(histogram, waitSamples, 0.95),
    waitP99Ms: percentileFromCumulativeHistogram(histogram, waitSamples, 0.99),
    waitSamples,
    grants,
    deadlineExceeded,
    storeUnavailable,
    cancelled,
    providerDurationP50Ms: percentileFromCumulativeHistogram(
      providerDurationHistogram,
      providerDurationSamples,
      0.5,
      PROVIDER_DURATION_BUCKETS,
    ),
    providerDurationP95Ms: percentileFromCumulativeHistogram(
      providerDurationHistogram,
      providerDurationSamples,
      0.95,
      PROVIDER_DURATION_BUCKETS,
    ),
    providerDurationP99Ms: percentileFromCumulativeHistogram(
      providerDurationHistogram,
      providerDurationSamples,
      0.99,
      PROVIDER_DURATION_BUCKETS,
    ),
    providerDurationSamples,
    responseSamples,
    response429,
    response5xx,
    networkErrors,
  };
}

/** Read the last five minute buckets. Passing a queueName scopes the result. */
export async function readFplAdmissionTelemetry(
  now = Date.now(),
  queueName?: string,
): Promise<FplAdmissionTelemetry> {
  const priorities: readonly FplRequestPriority[] = ['deadline-critical', 'live', 'bulk'];
  const emptyByPriority = (): Record<FplRequestPriority, FplAdmissionClassTelemetry> =>
    Object.fromEntries(priorities.map((priority) => [priority, emptyClassTelemetry()])) as Record<
      FplRequestPriority,
      FplAdmissionClassTelemetry
    >;
  if (useLocalTestScheduler()) {
    return {
      waitP50Ms: null,
      waitP95Ms: null,
      waitP99Ms: null,
      waitSamples: 0,
      grants: 0,
      deadlineExceeded: 0,
      storeUnavailable: 0,
      cancelled: 0,
      providerDurationP50Ms: null,
      providerDurationP95Ms: null,
      providerDurationP99Ms: null,
      providerDurationSamples: 0,
      response429Rate: null,
      response5xxRate: null,
      networkErrorRate: null,
      responseSamples: 0,
      byPriority: emptyByPriority(),
    };
  }
  try {
    const redis = await queueRedisSingleton.getClient();
    const scope = queueName ? sanitizeTelemetryLabel(queueName) : TELEMETRY_GLOBAL_SCOPE;
    const keys = Array.from({ length: 5 }, (_, index) =>
      telemetryKey(now - index * TELEMETRY_WINDOW_MS, scope),
    );
    const buckets = await Promise.all(keys.map((key) => redis.hgetall(key)));
    const byPriority = Object.fromEntries(
      priorities.map((priority) => [priority, readClassTelemetry(buckets, priority)]),
    ) as Record<FplRequestPriority, FplAdmissionClassTelemetry>;
    const values = Object.values(byPriority);
    const waitSamples = values.reduce((sum, item) => sum + item.waitSamples, 0);
    const grants = values.reduce((sum, item) => sum + item.grants, 0);
    const deadlineExceeded = values.reduce((sum, item) => sum + item.deadlineExceeded, 0);
    const storeUnavailable = values.reduce((sum, item) => sum + item.storeUnavailable, 0);
    const cancelled = values.reduce((sum, item) => sum + item.cancelled, 0);
    const providerDurationSamples = values.reduce(
      (sum, item) => sum + item.providerDurationSamples,
      0,
    );
    const responseSamples = values.reduce((sum, item) => sum + item.responseSamples, 0);
    const response429 = values.reduce((sum, item) => sum + item.response429, 0);
    const response5xx = values.reduce((sum, item) => sum + item.response5xx, 0);
    const networkErrors = values.reduce((sum, item) => sum + item.networkErrors, 0);
    const aggregateHistogram: Record<number, number> = {};
    for (const priority of priorities) {
      for (const threshold of WAIT_HISTOGRAM_BUCKETS) {
        aggregateHistogram[threshold] =
          (aggregateHistogram[threshold] ?? 0) +
          buckets.reduce(
            (sum, bucket) => sum + Number(bucket[field(priority, `waitLe${threshold}`)] ?? 0),
            0,
          );
      }
    }
    const aggregateProviderDurationHistogram: Record<number, number> = {};
    for (const priority of priorities) {
      for (const threshold of PROVIDER_DURATION_BUCKETS) {
        aggregateProviderDurationHistogram[threshold] =
          (aggregateProviderDurationHistogram[threshold] ?? 0) +
          buckets.reduce(
            (sum, bucket) =>
              sum + Number(bucket[field(priority, `providerDurationLe${threshold}`)] ?? 0),
            0,
          );
      }
    }
    return {
      waitP50Ms: percentileFromCumulativeHistogram(aggregateHistogram, waitSamples, 0.5),
      waitP95Ms: percentileFromCumulativeHistogram(aggregateHistogram, waitSamples, 0.95),
      waitP99Ms: percentileFromCumulativeHistogram(aggregateHistogram, waitSamples, 0.99),
      waitSamples,
      grants,
      deadlineExceeded,
      storeUnavailable,
      cancelled,
      providerDurationP50Ms: percentileFromCumulativeHistogram(
        aggregateProviderDurationHistogram,
        providerDurationSamples,
        0.5,
        PROVIDER_DURATION_BUCKETS,
      ),
      providerDurationP95Ms: percentileFromCumulativeHistogram(
        aggregateProviderDurationHistogram,
        providerDurationSamples,
        0.95,
        PROVIDER_DURATION_BUCKETS,
      ),
      providerDurationP99Ms: percentileFromCumulativeHistogram(
        aggregateProviderDurationHistogram,
        providerDurationSamples,
        0.99,
        PROVIDER_DURATION_BUCKETS,
      ),
      providerDurationSamples,
      response429Rate: responseSamples > 0 ? response429 / responseSamples : null,
      response5xxRate: responseSamples > 0 ? response5xx / responseSamples : null,
      networkErrorRate: responseSamples > 0 ? networkErrors / responseSamples : null,
      responseSamples,
      byPriority,
    };
  } catch {
    return {
      waitP50Ms: null,
      waitP95Ms: null,
      waitP99Ms: null,
      waitSamples: 0,
      grants: 0,
      deadlineExceeded: 0,
      storeUnavailable: 0,
      cancelled: 0,
      providerDurationP50Ms: null,
      providerDurationP95Ms: null,
      providerDurationP99Ms: null,
      providerDurationSamples: 0,
      response429Rate: null,
      response5xxRate: null,
      networkErrorRate: null,
      responseSamples: 0,
      byPriority: emptyByPriority(),
    };
  }
}

export class FplAdmissionDeadlineExceededError extends FPLClientError {
  constructor(cause?: unknown) {
    super(
      'FPL request admission deadline exceeded; retry later',
      503,
      'FPL_ADMISSION_DEADLINE_EXCEEDED',
      cause instanceof Error ? cause : undefined,
    );
    this.name = 'FplAdmissionDeadlineExceededError';
  }
}

export class FplAdmissionStoreUnavailableError extends FPLClientError {
  constructor(cause?: unknown) {
    super(
      'FPL upstream admission store is temporarily unavailable; retry later',
      503,
      'FPL_ADMISSION_STORE_UNAVAILABLE',
      cause instanceof Error ? cause : undefined,
    );
    this.name = 'FplAdmissionStoreUnavailableError';
  }
}

export class FplAdmissionCriticalWindowBusyError extends FPLClientError {
  readonly untilMs: number;

  constructor(untilMs: number) {
    super(
      'FPL critical admission window is already owned by another watcher',
      409,
      'FPL_ADMISSION_CRITICAL_WINDOW_BUSY',
    );
    this.name = 'FplAdmissionCriticalWindowBusyError';
    this.untilMs = Number.isFinite(untilMs) ? Math.max(0, untilMs) : 0;
  }
}

/** Backward-compatible alias for consumers that only knew the old error type. */
export class FplAdmissionUnavailableError extends FplAdmissionDeadlineExceededError {
  constructor(cause?: unknown) {
    super(cause);
    this.code = 'FPL_ADMISSION_UNAVAILABLE';
    this.name = 'FplAdmissionUnavailableError';
  }
}

/**
 * Distributed admission policy. The script registers each waiter once,
 * cleans expired waiters/leases, and grants only the eligible FIFO head.
 * Redis TIME is the sole clock used for the atomic decision.
 */
export const ACQUIRE_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local priority = ARGV[1]
local token = ARGV[2]
local requestedDeadline = tonumber(ARGV[7])
local configuredBulkLimit = tonumber(ARGV[3])
local configuredMaxInflight = tonumber(ARGV[4])
local configuredRate = tonumber(ARGV[5])
local configuredCapacity = tonumber(ARGV[11])
local criticalUntil = tonumber(redis.call('HGET', KEYS[1], 'criticalUntilMs') or '0')
local criticalActive = criticalUntil > now

local function waiterQueue(waiterPriority)
  if waiterPriority == 'deadline-critical' then return KEYS[5] end
  if waiterPriority == 'live' then return KEYS[6] end
  return KEYS[7]
end

local function removeWaiter(waiterToken)
  local waiterPriority = redis.call('HGET', KEYS[9], waiterToken)
  if waiterPriority then
    redis.call('ZREM', waiterQueue(waiterPriority), waiterToken)
    redis.call('HDEL', KEYS[9], waiterToken)
  end
  redis.call('ZREM', KEYS[8], waiterToken)
end

local expiredWaiters = redis.call('ZRANGEBYSCORE', KEYS[8], '-inf', now)
for _, waiterToken in ipairs(expiredWaiters) do
  removeWaiter(waiterToken)
end

local expiredLeases = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, leaseToken in ipairs(expiredLeases) do
  local leasePriority = redis.call('HGET', KEYS[4], leaseToken)
  if leasePriority == 'deadline-critical' then redis.call('HINCRBY', KEYS[1], 'critical', -1) end
  if leasePriority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
  if leasePriority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
  if leasePriority == 'deadline-critical' or leasePriority == 'live' or leasePriority == 'bulk' then
    redis.call('HINCRBY', KEYS[1], 'inflight', -1)
  end
  redis.call('DEL', KEYS[3] .. leaseToken)
  redis.call('HDEL', KEYS[4], leaseToken)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

local existingPriority = redis.call('HGET', KEYS[9], token)
if not existingPriority then
  local ticket = redis.call('HINCRBY', KEYS[1], 'nextTicket', 1)
  redis.call('ZADD', waiterQueue(priority), ticket, token)
  redis.call('HSET', KEYS[9], token, priority)
  redis.call('ZADD', KEYS[8], requestedDeadline, token)
elseif existingPriority ~= priority then
  removeWaiter(token)
  return {'store-error', 'priority-mismatch', '0'}
end
if requestedDeadline > 0 and requestedDeadline <= now then
  removeWaiter(token)
  return {'expired', 'deadline', '0'}
end

local inflight = tonumber(redis.call('HGET', KEYS[1], 'inflight') or '0')
local critical = tonumber(redis.call('HGET', KEYS[1], 'critical') or '0')
local live = tonumber(redis.call('HGET', KEYS[1], 'live') or '0')
local bulk = tonumber(redis.call('HGET', KEYS[1], 'bulk') or '0')
local bulkLimit = tonumber(redis.call('HGET', KEYS[1], 'bulkLimit') or configuredBulkLimit)
if bulkLimit > configuredBulkLimit then
  bulkLimit = configuredBulkLimit
  redis.call('HSET', KEYS[1], 'bulkLimit', bulkLimit)
end
local lastError = tonumber(redis.call('HGET', KEYS[1], 'lastBulkErrorMs') or '0')
if bulkLimit < configuredBulkLimit and lastError > 0 and now - lastError >= 300000 then
  bulkLimit = math.min(configuredBulkLimit, bulkLimit + 1)
  redis.call('HSET', KEYS[1], 'bulkLimit', bulkLimit, 'lastBulkErrorMs', bulkLimit < configuredBulkLimit and now or 0)
end

local lastRefill = tonumber(redis.call('HGET', KEYS[1], 'lastRefillMs') or now)
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or configuredCapacity)
local elapsed = math.max(0, now - lastRefill)
tokens = math.min(configuredCapacity, tokens + elapsed * configuredRate / 1000)
local liveBurst = tonumber(redis.call('HGET', KEYS[1], 'liveBurst') or '0')
local function requiredTokens(waiterPriority)
  if waiterPriority ~= 'deadline-critical' and criticalActive and critical == 0 then return 2 end
  return 1
end

local function classCanStart(waiterPriority)
  if inflight >= configuredMaxInflight then return false end
  if waiterPriority == 'deadline-critical' and critical >= tonumber(ARGV[10]) then return false end
  if waiterPriority == 'bulk' and bulk >= bulkLimit then return false end
  if waiterPriority ~= 'deadline-critical' and criticalActive and critical == 0 and inflight >= configuredMaxInflight - 1 then return false end
  return tokens >= requiredTokens(waiterPriority)
end

local criticalHead = redis.call('ZRANGE', KEYS[5], 0, 0)[1]
local liveHead = redis.call('ZRANGE', KEYS[6], 0, 0)[1]
local bulkHead = redis.call('ZRANGE', KEYS[7], 0, 0)[1]
local regularPriority = nil
local regularHead = nil
if liveHead and bulkHead then
  if liveBurst >= tonumber(ARGV[9]) then
    regularPriority = 'bulk'
    regularHead = bulkHead
  else
    regularPriority = 'live'
    regularHead = liveHead
  end
elseif liveHead then
  regularPriority = 'live'
  regularHead = liveHead
elseif bulkHead then
  regularPriority = 'bulk'
  regularHead = bulkHead
end

local selectedHead = regularHead
local selectedPriority = regularPriority
local waitReason = 'class-fairness'
-- Critical is strict priority while its single-flight slot is available. If
-- that slot is already held, keep the remaining global capacity work-conserving
-- for regular traffic instead of idling behind a duplicate critical waiter.
if criticalHead and critical < tonumber(ARGV[10]) then
  selectedHead = criticalHead
  selectedPriority = 'deadline-critical'
  waitReason = 'critical-priority'
elseif criticalHead and regularPriority then
  selectedHead = regularHead
  selectedPriority = regularPriority
end

-- When the fairness-selected regular class is at its class cap, use the other
-- class if it can make progress. This avoids empty capacity while bulk is full.
if selectedPriority == 'live' and liveHead and bulkHead and not classCanStart('live') and classCanStart('bulk') then
  selectedHead = bulkHead
  selectedPriority = 'bulk'
elseif selectedPriority == 'bulk' and liveHead and bulkHead and not classCanStart('bulk') and classCanStart('live') then
  selectedHead = liveHead
  selectedPriority = 'live'
end

local canStart = selectedHead ~= nil and selectedHead == token and selectedPriority ~= nil
local requiredTokensForSelection = selectedPriority and requiredTokens(selectedPriority) or 1
if canStart and not classCanStart(selectedPriority) then canStart = false end
if inflight >= configuredMaxInflight then
  waitReason = 'capacity'
elseif selectedPriority == 'bulk' and bulk >= bulkLimit then
  waitReason = 'capacity'
elseif selectedPriority == 'deadline-critical' and critical >= tonumber(ARGV[10]) then
  waitReason = 'capacity'
elseif selectedPriority ~= 'deadline-critical' and criticalActive and critical == 0 and inflight >= configuredMaxInflight - 1 then
  waitReason = 'critical-reservation'
elseif tokens < requiredTokensForSelection then
  waitReason = criticalActive and 'critical-reservation' or 'rate'
end

if not canStart then
  local waitMs = 25
  if tokens < requiredTokensForSelection then
    waitMs = math.max(25, math.ceil((requiredTokensForSelection - tokens) * 1000 / configuredRate))
  elseif inflight >= configuredMaxInflight or (selectedPriority == 'bulk' and bulk >= bulkLimit) or (selectedPriority ~= 'deadline-critical' and criticalActive and critical == 0 and inflight >= configuredMaxInflight - 1) then
    waitMs = 100
  end
  return {'wait', waitReason, tostring(math.min(1000, waitMs))}
end

tokens = tokens - 1
redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefillMs', now, 'bulkLimit', bulkLimit)
redis.call('HINCRBY', KEYS[1], 'inflight', 1)
if selectedPriority == 'deadline-critical' then redis.call('HINCRBY', KEYS[1], 'critical', 1) end
if selectedPriority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', 1) end
if selectedPriority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', 1) end
if selectedPriority == 'live' and bulkHead then
  redis.call('HINCRBY', KEYS[1], 'liveBurst', 1)
elseif selectedPriority == 'bulk' then
  redis.call('HSET', KEYS[1], 'liveBurst', 0)
elseif not bulkHead then
  redis.call('HSET', KEYS[1], 'liveBurst', 0)
end
removeWaiter(token)
redis.call('SET', KEYS[3] .. token, selectedPriority, 'PX', ARGV[6])
redis.call('HSET', KEYS[4], token, selectedPriority)
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), token)
return {'granted', token, tostring(now)}
`;

const RELEASE_SCRIPT = `
local priority = redis.call('HGET', KEYS[4], ARGV[1])
if not priority then return 0 end
redis.call('DEL', KEYS[3] .. ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[1], 'inflight', -1)
if priority == 'deadline-critical' then redis.call('HINCRBY', KEYS[1], 'critical', -1) end
if priority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
if priority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
return 1
`;

const CANCEL_SCRIPT = `
local token = ARGV[1]
local waiterPriority = redis.call('HGET', KEYS[9], token)
local function waiterQueue(priority)
  if priority == 'deadline-critical' then return KEYS[5] end
  if priority == 'live' then return KEYS[6] end
  return KEYS[7]
end
if waiterPriority then
  redis.call('ZREM', waiterQueue(waiterPriority), token)
  redis.call('ZREM', KEYS[8], token)
  redis.call('HDEL', KEYS[9], token)
  return 'cancelled'
end

-- A cancellation can race the atomic grant. If the waiter has already become
-- a lease, release that lease in the same script so an aborted caller cannot
-- strand a slot until the safety TTL.
local leasePriority = redis.call('HGET', KEYS[4], token)
if leasePriority then
  redis.call('DEL', KEYS[3] .. token)
  redis.call('HDEL', KEYS[4], token)
  redis.call('ZREM', KEYS[2], token)
  redis.call('HINCRBY', KEYS[1], 'inflight', -1)
  if leasePriority == 'deadline-critical' then redis.call('HINCRBY', KEYS[1], 'critical', -1) end
  if leasePriority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
  if leasePriority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
  return 'released'
end
return 'missing'
`;

const OPEN_CRITICAL_WINDOW_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local untilMs = tonumber(ARGV[2])
local owner = ARGV[1]
if untilMs <= now then return {'invalid', '0'} end
local currentUntil = tonumber(redis.call('HGET', KEYS[1], 'criticalUntilMs') or '0')
local currentOwner = redis.call('HGET', KEYS[1], 'criticalOwner') or ''
if currentUntil > now and currentOwner ~= '' and currentOwner ~= owner then
  return {'busy', tostring(currentUntil)}
end
redis.call('HSET', KEYS[1], 'criticalUntilMs', untilMs, 'criticalOwner', owner)
return {'opened', tostring(untilMs)}
`;

const CLOSE_CRITICAL_WINDOW_SCRIPT = `
local owner = ARGV[1]
local currentOwner = redis.call('HGET', KEYS[1], 'criticalOwner') or ''
if currentOwner ~= owner then return 0 end
redis.call('HDEL', KEYS[1], 'criticalUntilMs', 'criticalOwner')
return 1
`;

const CLEANUP_STATS_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local configuredRate = tonumber(ARGV[1])
local configuredCapacity = tonumber(ARGV[2])
local configuredBulkLimit = tonumber(ARGV[3])

local function waiterQueue(waiterPriority)
  if waiterPriority == 'deadline-critical' then return KEYS[5] end
  if waiterPriority == 'live' then return KEYS[6] end
  return KEYS[7]
end

local expiredWaiters = redis.call('ZRANGEBYSCORE', KEYS[8], '-inf', now)
for _, waiterToken in ipairs(expiredWaiters) do
  local waiterPriority = redis.call('HGET', KEYS[9], waiterToken)
  if waiterPriority then
    redis.call('ZREM', waiterQueue(waiterPriority), waiterToken)
    redis.call('HDEL', KEYS[9], waiterToken)
  end
  redis.call('ZREM', KEYS[8], waiterToken)
end

local expiredLeases = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, leaseToken in ipairs(expiredLeases) do
  local leasePriority = redis.call('HGET', KEYS[4], leaseToken)
  if leasePriority == 'deadline-critical' then redis.call('HINCRBY', KEYS[1], 'critical', -1) end
  if leasePriority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
  if leasePriority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
  if leasePriority == 'deadline-critical' or leasePriority == 'live' or leasePriority == 'bulk' then
    redis.call('HINCRBY', KEYS[1], 'inflight', -1)
  end
  redis.call('DEL', KEYS[3] .. leaseToken)
  redis.call('HDEL', KEYS[4], leaseToken)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)

local lastRefill = tonumber(redis.call('HGET', KEYS[1], 'lastRefillMs') or now) or now
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or configuredCapacity) or configuredCapacity
local elapsed = math.max(0, now - lastRefill)
tokens = math.min(configuredCapacity, math.max(0, tokens + elapsed * configuredRate / 1000))
local bulkLimit = tonumber(redis.call('HGET', KEYS[1], 'bulkLimit') or configuredBulkLimit) or configuredBulkLimit
bulkLimit = math.max(1, math.min(configuredBulkLimit, bulkLimit))
redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefillMs', now, 'bulkLimit', bulkLimit)

local inflight = tonumber(redis.call('HGET', KEYS[1], 'inflight') or '0') or 0
local critical = tonumber(redis.call('HGET', KEYS[1], 'critical') or '0') or 0
local live = tonumber(redis.call('HGET', KEYS[1], 'live') or '0') or 0
local bulk = tonumber(redis.call('HGET', KEYS[1], 'bulk') or '0') or 0
local criticalUntil = tonumber(redis.call('HGET', KEYS[1], 'criticalUntilMs') or '0') or 0
local criticalOwner = redis.call('HGET', KEYS[1], 'criticalOwner') or ''
return {
  tostring(now),
  tostring(tokens),
  tostring(inflight),
  tostring(critical),
  tostring(live),
  tostring(bulk),
  tostring(bulkLimit),
  tostring(criticalUntil),
  criticalOwner,
  tostring(redis.call('ZCARD', KEYS[5])),
  tostring(redis.call('ZCARD', KEYS[6])),
  tostring(redis.call('ZCARD', KEYS[7]))
}
`;

const REPORT_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local limit = tonumber(redis.call('HGET', KEYS[1], 'bulkLimit') or ARGV[2])
if ARGV[1] == '429' or tonumber(ARGV[1]) >= 500 then
  limit = math.max(1, limit - 1)
  redis.call('HSET', KEYS[1], 'bulkLimit', limit, 'lastBulkErrorMs', now)
elseif limit < tonumber(ARGV[2]) then
  local last = tonumber(redis.call('HGET', KEYS[1], 'lastBulkErrorMs') or '0')
  if last > 0 and now - last >= 300000 then
    limit = math.min(tonumber(ARGV[2]), limit + 1)
    redis.call('HSET', KEYS[1], 'bulkLimit', limit, 'lastBulkErrorMs', limit < tonumber(ARGV[2]) and now or 0)
  end
end
return limit
`;

export type FplAdmissionOptions = Readonly<{
  deadlineAt?: number;
  /** Abort a queued admission without waiting for its deadline or lease TTL. */
  signal?: AbortSignal;
}>;

type LocalWaiter = {
  priority: FplRequestPriority;
  sequence: number;
  waitStartedAt: number;
  deadlineAt: number;
  signal?: AbortSignal;
  abortHandler: (() => void) | null;
  timeout: ReturnType<typeof setTimeout> | null;
  resolve: (lease: FplAdmissionLease) => void;
  reject: (error: Error) => void;
};

function admissionAbortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('FPL admission request was cancelled', 'AbortError');
}

function sleepWithAdmissionAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(admissionAbortError(signal));
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(admissionAbortError(signal));
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function cleanupLocalWaiter(waiter: LocalWaiter): void {
  if (waiter.timeout) clearTimeout(waiter.timeout);
  if (waiter.signal && waiter.abortHandler) {
    waiter.signal.removeEventListener('abort', waiter.abortHandler);
  }
  waiter.timeout = null;
  waiter.abortHandler = null;
}

let localInflight = 0;
let localLive = 0;
let localCritical = 0;
let localBulk = 0;
let localBulkLimit = BULK_MAX_INFLIGHT;
let localLastError = 0;
let localSequence = 0;
let localLiveBurst = 0;
let localCriticalUntil = 0;
let localCriticalOwner: string | null = null;
let localTokens = TOKEN_BUCKET_CAPACITY;
let localLastRefill = Date.now();
let localDrainTimer: ReturnType<typeof setTimeout> | null = null;
const localWaiters: LocalWaiter[] = [];

function localCriticalActive(): boolean {
  return localCriticalUntil > Date.now();
}

function localRefillTokens(now = Date.now()): void {
  const elapsed = Math.max(0, now - localLastRefill);
  localTokens = Math.min(
    TOKEN_BUCKET_CAPACITY,
    localTokens + (elapsed * REQUESTS_PER_SECOND) / 1000,
  );
  localLastRefill = now;
}

function localRequiredTokens(priority: FplRequestPriority): number {
  return priority !== 'deadline-critical' && localCriticalActive() && localCritical === 0 ? 2 : 1;
}

function localCanStart(priority: FplRequestPriority): boolean {
  if (localInflight >= MAX_INFLIGHT) return false;
  if (priority === 'deadline-critical' && localCritical >= CRITICAL_MAX_INFLIGHT) return false;
  if (priority === 'bulk' && localBulk >= localBulkLimit) return false;
  if (
    priority !== 'deadline-critical' &&
    localCriticalActive() &&
    localCritical === 0 &&
    localInflight >= MAX_INFLIGHT - 1
  ) {
    return false;
  }
  localRefillTokens();
  return localTokens >= localRequiredTokens(priority);
}

function localNextWaiter(): LocalWaiter | undefined {
  const critical = localWaiters
    .filter((item) => item.priority === 'deadline-critical')
    .sort((left, right) => left.sequence - right.sequence)[0];
  if (critical && localCritical < CRITICAL_MAX_INFLIGHT) return critical;
  const live = localWaiters
    .filter((item) => item.priority === 'live')
    .sort((left, right) => left.sequence - right.sequence)[0];
  const bulk = localWaiters
    .filter((item) => item.priority === 'bulk')
    .sort((left, right) => left.sequence - right.sequence)[0];
  if (live && bulk) {
    if (localLiveBurst >= LIVE_BURST_MAX && localCanStart('bulk')) return bulk;
    if (localCanStart('live')) return live;
    if (localCanStart('bulk')) return bulk;
    return live;
  }
  return live ?? bulk;
}

function createLocalLease(priority: FplRequestPriority, waitMs: number): FplAdmissionLease {
  localRefillTokens();
  localTokens -= 1;
  localInflight += 1;
  if (priority === 'deadline-critical') localCritical += 1;
  if (priority === 'live') localLive += 1;
  if (priority === 'bulk') localBulk += 1;
  const acquiredAt = Date.now();
  recordFplAdmissionResult({ priority, outcome: 'granted', waitMs });
  let released = false;
  return {
    token: randomUUID(),
    priority,
    waitMs,
    acquiredAt,
    release: async () => {
      if (released) return;
      released = true;
      localInflight -= 1;
      if (priority === 'deadline-critical') localCritical -= 1;
      if (priority === 'live') localLive -= 1;
      if (priority === 'bulk') localBulk -= 1;
      localDrain();
    },
  };
}

function localDrain(): void {
  if (localDrainTimer) {
    clearTimeout(localDrainTimer);
    localDrainTimer = null;
  }
  const now = Date.now();
  for (let index = localWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = localWaiters[index];
    if (!waiter || waiter.deadlineAt > now) continue;
    localWaiters.splice(index, 1);
    cleanupLocalWaiter(waiter);
    const waitMs = Math.max(0, now - waiter.waitStartedAt);
    recordFplAdmissionResult({
      priority: waiter.priority,
      outcome: 'deadline-exceeded',
      waitMs,
      reason: 'capacity',
    });
    waiter.reject(new FplAdmissionDeadlineExceededError(new Error('Admission deadline exceeded')));
  }
  while (localWaiters.length) {
    const selected = localNextWaiter();
    if (!selected) return;
    if (!localCanStart(selected.priority)) {
      localRefillTokens();
      const requiredTokens = localRequiredTokens(selected.priority);
      const waitingForCriticalReservation =
        selected.priority !== 'deadline-critical' &&
        localCriticalActive() &&
        localCritical === 0 &&
        localInflight >= MAX_INFLIGHT - 1;
      if (localTokens < requiredTokens || waitingForCriticalReservation) {
        const delayMs = Math.max(
          25,
          waitingForCriticalReservation
            ? localCriticalUntil - Date.now()
            : Math.ceil(((requiredTokens - localTokens) * 1000) / REQUESTS_PER_SECOND),
        );
        localDrainTimer = setTimeout(
          () => {
            localDrainTimer = null;
            localDrain();
          },
          Math.min(1_000, delayMs),
        );
      }
      return;
    }
    const index = localWaiters.indexOf(selected);
    if (index < 0) return;
    localWaiters.splice(index, 1);
    cleanupLocalWaiter(selected);
    if (selected.priority === 'live' && localWaiters.some((item) => item.priority === 'bulk')) {
      localLiveBurst += 1;
    } else if (selected.priority === 'bulk') {
      localLiveBurst = 0;
    } else if (!localWaiters.some((item) => item.priority === 'bulk')) {
      localLiveBurst = 0;
    }
    selected.resolve(createLocalLease(selected.priority, Date.now() - selected.waitStartedAt));
  }
}

function localAcquire(
  priority: FplRequestPriority,
  options: FplAdmissionOptions,
): Promise<FplAdmissionLease> {
  const waitStartedAt = Date.now();
  const deadlineAt = options.deadlineAt ?? waitStartedAt + MAX_UNBOUNDED_ADMISSION_WAIT_MS;
  if (options.signal?.aborted) {
    recordFplAdmissionResult({ priority, outcome: 'cancelled', waitMs: 0 });
    return Promise.reject(admissionAbortError(options.signal));
  }
  if (deadlineAt <= waitStartedAt) {
    recordFplAdmissionResult({
      priority,
      outcome: 'deadline-exceeded',
      waitMs: 0,
      reason: 'capacity',
    });
    return Promise.reject(
      new FplAdmissionDeadlineExceededError(new Error('Admission deadline exceeded')),
    );
  }
  if (localCanStart(priority) && localWaiters.length === 0) {
    return Promise.resolve(createLocalLease(priority, 0));
  }
  return new Promise<FplAdmissionLease>((resolve, reject) => {
    const waiter: LocalWaiter = {
      priority,
      sequence: localSequence++,
      waitStartedAt,
      deadlineAt,
      signal: options.signal,
      abortHandler: null,
      timeout: null,
      resolve,
      reject,
    };
    localWaiters.push(waiter);
    waiter.abortHandler = () => {
      const index = localWaiters.indexOf(waiter);
      if (index < 0) return;
      localWaiters.splice(index, 1);
      cleanupLocalWaiter(waiter);
      recordFplAdmissionResult({
        priority,
        outcome: 'cancelled',
        waitMs: Math.max(0, Date.now() - waitStartedAt),
        reason: 'capacity',
      });
      reject(admissionAbortError(options.signal));
      localDrain();
    };
    options.signal?.addEventListener('abort', waiter.abortHandler, { once: true });
    waiter.timeout = setTimeout(
      () => {
        const index = localWaiters.indexOf(waiter);
        if (index < 0) return;
        localWaiters.splice(index, 1);
        cleanupLocalWaiter(waiter);
        const waitMs = Math.max(0, Date.now() - waitStartedAt);
        recordFplAdmissionResult({
          priority,
          outcome: 'deadline-exceeded',
          waitMs,
          reason: 'capacity',
        });
        reject(new FplAdmissionDeadlineExceededError(new Error('Admission deadline exceeded')));
        localDrain();
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    localDrain();
  });
}

function createDistributedLease(
  redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>,
  priority: FplRequestPriority,
  token: string,
  waitMs: number,
  acquiredAt: number,
): FplAdmissionLease {
  let released = false;
  const keys = admissionKeys();
  return {
    token,
    priority,
    waitMs,
    acquiredAt,
    release: async () => {
      if (released) return;
      released = true;
      try {
        await redis.eval(
          RELEASE_SCRIPT,
          4,
          keys.state,
          keys.leases,
          keys.leasePrefix,
          keys.leaseMeta,
          token,
        );
      } catch {
        // Lease TTL is the safety net when Redis disappears during release.
      }
    },
  };
}

async function cancelDistributedToken(
  redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>,
  token: string,
): Promise<void> {
  const keys = admissionKeys();
  await redis.eval(
    CANCEL_SCRIPT,
    9,
    keys.state,
    keys.leases,
    keys.leasePrefix,
    keys.leaseMeta,
    keys.waitersCritical,
    keys.waitersLive,
    keys.waitersBulk,
    keys.waitersExpiry,
    keys.waitersPriority,
    token,
  );
}

function admissionWaitDeadline(options: FplAdmissionOptions): number {
  return options.deadlineAt ?? Date.now() + MAX_UNBOUNDED_ADMISSION_WAIT_MS;
}

async function distributedAcquire(
  priority: FplRequestPriority,
  options: FplAdmissionOptions,
): Promise<FplAdmissionLease> {
  const token = randomUUID();
  const waitStartedAt = Date.now();
  const deadlineAt = admissionWaitDeadline(options);
  const keys = admissionKeys();
  let redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>;
  try {
    redis = await queueRedisSingleton.getClient();
  } catch (error) {
    recordFplAdmissionResult({ priority, outcome: 'store-unavailable' });
    throw new FplAdmissionStoreUnavailableError(error);
  }
  if (options.signal?.aborted) {
    recordFplAdmissionResult({ priority, outcome: 'cancelled', waitMs: 0 });
    throw admissionAbortError(options.signal);
  }
  let lastWaitReason: FplAdmissionWaitReason | undefined;
  let registered = false;
  for (;;) {
    if (options.signal?.aborted) {
      if (registered) await cancelDistributedToken(redis, token).catch(() => undefined);
      recordFplAdmissionResult({
        priority,
        outcome: 'cancelled',
        waitMs: Math.max(0, Date.now() - waitStartedAt),
        reason: lastWaitReason,
      });
      throw admissionAbortError(options.signal);
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      if (registered) await cancelDistributedToken(redis, token).catch(() => undefined);
      const waitMs = Math.max(0, Date.now() - waitStartedAt);
      recordFplAdmissionResult({
        priority,
        outcome: 'deadline-exceeded',
        waitMs,
        reason: lastWaitReason ?? 'capacity',
      });
      throw new FplAdmissionDeadlineExceededError(new Error('Admission deadline exceeded'));
    }
    let result: string[];
    try {
      result = (await redis.eval(
        ACQUIRE_SCRIPT,
        9,
        keys.state,
        keys.leases,
        keys.leasePrefix,
        keys.leaseMeta,
        keys.waitersCritical,
        keys.waitersLive,
        keys.waitersBulk,
        keys.waitersExpiry,
        keys.waitersPriority,
        priority,
        token,
        BULK_MAX_INFLIGHT,
        MAX_INFLIGHT,
        REQUESTS_PER_SECOND,
        LEASE_MS,
        deadlineAt,
        0,
        LIVE_BURST_MAX,
        CRITICAL_MAX_INFLIGHT,
        TOKEN_BUCKET_CAPACITY,
      )) as string[];
    } catch (error) {
      recordFplAdmissionResult({
        priority,
        outcome: 'store-unavailable',
        waitMs: Math.max(0, Date.now() - waitStartedAt),
      });
      throw new FplAdmissionStoreUnavailableError(error);
    }
    if (result[0] === 'granted') {
      const redisAcquiredAt = Number(result[2]);
      const acquiredAt = Number.isFinite(redisAcquiredAt) ? redisAcquiredAt : Date.now();
      if (acquiredAt > deadlineAt || Date.now() > deadlineAt) {
        await cancelDistributedToken(redis, token).catch(() => undefined);
        const waitMs = Math.max(0, Date.now() - waitStartedAt);
        recordFplAdmissionResult({
          priority,
          outcome: 'deadline-exceeded',
          waitMs,
          reason: lastWaitReason ?? 'capacity',
        });
        throw new FplAdmissionDeadlineExceededError(
          new Error('Admission lease was granted after its deadline'),
        );
      }
      const waitMs = Math.max(0, acquiredAt - waitStartedAt);
      logDebug('FPL request admitted by Redis lease', {
        priority,
        admissionVersion: ADMISSION_SCRIPT_VERSION,
        waitMs,
      });
      recordFplAdmissionResult({
        priority,
        outcome: 'granted',
        waitMs,
        reason: lastWaitReason,
      });
      const lease = createDistributedLease(redis, priority, token, waitMs, acquiredAt);
      if (options.signal?.aborted) {
        await cancelDistributedToken(redis, token).catch(() => undefined);
        recordFplAdmissionResult({
          priority,
          outcome: 'cancelled',
          waitMs,
          reason: lastWaitReason,
        });
        throw admissionAbortError(options.signal);
      }
      return lease;
    }
    if (result[0] === 'expired') {
      const waitMs = Math.max(0, Date.now() - waitStartedAt);
      recordFplAdmissionResult({
        priority,
        outcome: 'deadline-exceeded',
        waitMs,
        reason: lastWaitReason ?? 'capacity',
      });
      throw new FplAdmissionDeadlineExceededError(new Error('Admission deadline exceeded'));
    }
    if (result[0] === 'store-error') {
      recordFplAdmissionResult({
        priority,
        outcome: 'store-unavailable',
        waitMs: Math.max(0, Date.now() - waitStartedAt),
      });
      throw new FplAdmissionStoreUnavailableError(
        new Error(result[1] ?? 'Admission script rejected request'),
      );
    }
    registered = true;
    lastWaitReason = result[1] as FplAdmissionWaitReason | undefined;
    const waitMs = Math.max(10, Math.min(1_000, Number(result[2] ?? 100)));
    try {
      await sleepWithAdmissionAbort(Math.min(waitMs, remaining), options.signal);
    } catch (error) {
      if (!options.signal?.aborted) throw error;
      await cancelDistributedToken(redis, token).catch(() => undefined);
      recordFplAdmissionResult({
        priority,
        outcome: 'cancelled',
        waitMs: Math.max(0, Date.now() - waitStartedAt),
        reason: lastWaitReason,
      });
      throw admissionAbortError(options.signal);
    }
  }
}

export async function acquireFplRequest(
  priority: FplRequestPriority,
  options: FplAdmissionOptions = {},
): Promise<FplAdmissionLease> {
  assertPriority(priority);
  if (useLocalTestScheduler()) return localAcquire(priority, options);
  return distributedAcquire(priority, options);
}

export function reportFplResponse(
  priority: FplRequestPriority,
  status: number | null,
  providerDurationMs?: number,
  now = Date.now(),
): void {
  assertPriority(priority);
  recordFplResponseTelemetry(status, priority, providerDurationMs);
  if (useLocalTestScheduler()) {
    if (status === 429 || (status !== null && status >= 500)) {
      localBulkLimit = Math.max(1, localBulkLimit - 1);
      localLastError = now;
    } else if (
      localBulkLimit < BULK_MAX_INFLIGHT &&
      localLastError &&
      now - localLastError >= 300_000
    ) {
      localBulkLimit += 1;
      localLastError = localBulkLimit < BULK_MAX_INFLIGHT ? now : 0;
    }
    return;
  }
  if (status === 429 || (status !== null && status >= 500)) {
    void queueRedisSingleton
      .getClient()
      .then((redis) =>
        redis.eval(REPORT_SCRIPT, 1, admissionKeys().state, status, BULK_MAX_INFLIGHT),
      )
      .catch(() => undefined);
  }
}

export async function openFplCriticalWindow(input: {
  owner: string;
  untilMs: number;
}): Promise<void> {
  if (!input.owner.trim()) throw new Error('FPL critical window owner is required');
  if (!Number.isFinite(input.untilMs) || input.untilMs <= Date.now()) {
    throw new Error('FPL critical window must end in the future');
  }
  if (useLocalTestScheduler()) {
    if (
      localCriticalUntil > Date.now() &&
      localCriticalOwner &&
      localCriticalOwner !== input.owner
    ) {
      throw new FplAdmissionCriticalWindowBusyError(localCriticalUntil);
    }
    localCriticalOwner = input.owner;
    localCriticalUntil = input.untilMs;
    localDrain();
    return;
  }
  try {
    const redis = await queueRedisSingleton.getClient();
    const keys = admissionKeys();
    const result = (await redis.eval(
      OPEN_CRITICAL_WINDOW_SCRIPT,
      1,
      keys.state,
      input.owner,
      input.untilMs,
    )) as string[];
    if (result[0] === 'busy') {
      throw new FplAdmissionCriticalWindowBusyError(Number(result[1] ?? 0));
    }
    if (result[0] !== 'opened') {
      throw new Error(`Critical window could not open: ${result[0] ?? 'unknown'}`);
    }
  } catch (error) {
    throw error instanceof FplAdmissionStoreUnavailableError ||
      error instanceof FplAdmissionCriticalWindowBusyError
      ? error
      : new FplAdmissionStoreUnavailableError(error);
  }
}

export async function closeFplCriticalWindow(owner: string): Promise<void> {
  if (useLocalTestScheduler()) {
    if (localCriticalOwner === owner) {
      localCriticalOwner = null;
      localCriticalUntil = 0;
      localDrain();
    }
    return;
  }
  try {
    const redis = await queueRedisSingleton.getClient();
    await redis.eval(CLOSE_CRITICAL_WINDOW_SCRIPT, 1, admissionKeys().state, owner);
  } catch {
    // The window has an absolute end time and therefore self-expires logically.
  }
}

export function getFplAdmissionStats(): FplAdmissionStats {
  localRefillTokens();
  const criticalActive = localCriticalActive();
  return {
    policyVersion: ADMISSION_SCRIPT_VERSION,
    inflight: localInflight,
    liveInflight: localLive,
    criticalInflight: localCritical,
    bulkInflight: localBulk,
    queued: localWaiters.length,
    queuedByPriority: {
      'deadline-critical': localWaiters.filter((item) => item.priority === 'deadline-critical')
        .length,
      live: localWaiters.filter((item) => item.priority === 'live').length,
      bulk: localWaiters.filter((item) => item.priority === 'bulk').length,
    },
    maxInflight: MAX_INFLIGHT,
    criticalMaxInflight: CRITICAL_MAX_INFLIGHT,
    bulkMaxInflight: localBulkLimit,
    requestsPerSecond: REQUESTS_PER_SECOND,
    tokenBucketCapacity: TOKEN_BUCKET_CAPACITY,
    tokens: localTokens,
    criticalWindow: {
      active: criticalActive,
      untilMs: criticalActive ? localCriticalUntil : null,
      owner: criticalActive ? localCriticalOwner : null,
    },
    distributed: !useLocalTestScheduler(),
  };
}

export async function readFplAdmissionStats(): Promise<FplAdmissionStats> {
  if (useLocalTestScheduler()) return getFplAdmissionStats();
  try {
    const redis = await queueRedisSingleton.getClient();
    const keys = admissionKeys();
    const result = (await redis.eval(
      CLEANUP_STATS_SCRIPT,
      9,
      keys.state,
      keys.leases,
      keys.leasePrefix,
      keys.leaseMeta,
      keys.waitersCritical,
      keys.waitersLive,
      keys.waitersBulk,
      keys.waitersExpiry,
      keys.waitersPriority,
      REQUESTS_PER_SECOND,
      TOKEN_BUCKET_CAPACITY,
      BULK_MAX_INFLIGHT,
    )) as string[];
    const reportedNowMs = Number(result[0]);
    const tokens = Number(result[1]);
    const inflight = Number(result[2]);
    const critical = Number(result[3]);
    const live = Number(result[4]);
    const bulk = Number(result[5]);
    const bulkLimit = Number(result[6]);
    const untilMs = Number(result[7]);
    const criticalActive = Number.isFinite(untilMs) && untilMs > reportedNowMs;
    const criticalQueued = Number(result[9]);
    const liveQueued = Number(result[10]);
    const bulkQueued = Number(result[11]);
    return {
      policyVersion: ADMISSION_SCRIPT_VERSION,
      inflight: Math.max(0, Number.isFinite(inflight) ? inflight : 0),
      liveInflight: Math.max(0, Number.isFinite(live) ? live : 0),
      criticalInflight: Math.max(0, Number.isFinite(critical) ? critical : 0),
      bulkInflight: Math.max(0, Number.isFinite(bulk) ? bulk : 0),
      queued: criticalQueued + liveQueued + bulkQueued,
      queuedByPriority: {
        'deadline-critical': criticalQueued,
        live: liveQueued,
        bulk: bulkQueued,
      },
      maxInflight: MAX_INFLIGHT,
      criticalMaxInflight: CRITICAL_MAX_INFLIGHT,
      bulkMaxInflight: Math.max(
        1,
        Math.min(BULK_MAX_INFLIGHT, Number.isFinite(bulkLimit) ? bulkLimit : BULK_MAX_INFLIGHT),
      ),
      requestsPerSecond: REQUESTS_PER_SECOND,
      tokenBucketCapacity: TOKEN_BUCKET_CAPACITY,
      tokens: Number.isFinite(tokens) ? Math.min(TOKEN_BUCKET_CAPACITY, Math.max(0, tokens)) : 0,
      criticalWindow: {
        active: criticalActive,
        untilMs: criticalActive ? untilMs : null,
        owner: criticalActive ? result[8] || null : null,
      },
      distributed: true,
    };
  } catch (error) {
    throw new FplAdmissionStoreUnavailableError(error);
  }
}

export function resetFplAdmissionForTests(): void {
  localInflight = 0;
  localLive = 0;
  localCritical = 0;
  localBulk = 0;
  localBulkLimit = BULK_MAX_INFLIGHT;
  localLastError = 0;
  localSequence = 0;
  localLiveBurst = 0;
  localCriticalUntil = 0;
  localCriticalOwner = null;
  localTokens = TOKEN_BUCKET_CAPACITY;
  localLastRefill = Date.now();
  if (localDrainTimer) clearTimeout(localDrainTimer);
  localDrainTimer = null;
  localWaiters.splice(0).forEach((waiter) => {
    cleanupLocalWaiter(waiter);
  });
}
