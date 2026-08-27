import { randomUUID } from 'node:crypto';

import { queueRedisSingleton } from '../queues/redis';
import { FPLClientError } from './errors';
import { logDebug } from './logger';
import { getConfig, parseStrictBooleanEnvValue } from './config';

export type FplRequestPriority = 'live' | 'bulk';

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
const LEASE_MS = runtimeConfig.FPL_ADMISSION_LEASE_MS;
const STATE_KEY = 'llm:fpl:admission:state';
const LEASES_KEY = 'llm:fpl:admission:leases';
const LEASE_KEY_PREFIX = 'llm:fpl:admission:lease:';
const LEASE_META_KEY = 'llm:fpl:admission:lease-meta';
const ADMISSION_SCRIPT_VERSION = 'v3';
const TELEMETRY_PREFIX = 'ops:fpl-admission:telemetry:';
const TELEMETRY_TTL_SECONDS = 300;
const TELEMETRY_WINDOW_MS = 60_000;
const WAIT_HISTOGRAM_BUCKETS = [0, 100, 500, 1_000, 5_000, 10_000, 60_000] as const;

export type FplAdmissionTelemetry = Readonly<{
  waitP95Ms: number | null;
  response429Rate: number | null;
  waitSamples: number;
  responseSamples: number;
}>;

function telemetryKey(now = Date.now()): string {
  return `${TELEMETRY_PREFIX}${Math.floor(now / TELEMETRY_WINDOW_MS)}`;
}

function waitBucket(waitMs: number): number {
  const bounded = Math.max(0, Math.floor(waitMs));
  return (
    WAIT_HISTOGRAM_BUCKETS.find((bucket) => bounded <= bucket) ??
    WAIT_HISTOGRAM_BUCKETS[WAIT_HISTOGRAM_BUCKETS.length - 1]
  );
}

function incrementTelemetry(fields: readonly (readonly [string, number])[]): void {
  // Test mode intentionally stays in-process and should not open a Redis
  // connection just because a unit test exercised an FPL client helper.
  if (useLocalTestScheduler()) return;
  const key = telemetryKey();
  void queueRedisSingleton
    .getClient()
    .then((redis) => {
      const pipeline = redis.multi();
      for (const [field, value] of fields) pipeline.hincrby(key, field, value);
      pipeline.expire(key, TELEMETRY_TTL_SECONDS);
      return pipeline.exec();
    })
    .catch(() => undefined);
}

/** Record one request's wait in a short-lived histogram for queue governance. */
export function recordFplAdmissionWait(waitMs: number): void {
  const bucket = waitBucket(waitMs);
  incrementTelemetry([
    ['waitSamples', 1],
    [`waitLe${bucket}`, 1],
  ]);
}

/** Record provider status independently of the adaptive bulk limiter. */
export function recordFplResponseTelemetry(status: number | null): void {
  incrementTelemetry([
    ['responseSamples', 1],
    ...(status === 429 ? ([['response429', 1]] as const) : []),
  ]);
}

/** Read the last five minute buckets; failures are treated as unavailable. */
export async function readFplAdmissionTelemetry(now = Date.now()): Promise<FplAdmissionTelemetry> {
  if (useLocalTestScheduler()) {
    return { waitP95Ms: null, response429Rate: null, waitSamples: 0, responseSamples: 0 };
  }
  try {
    const redis = await queueRedisSingleton.getClient();
    const keys = Array.from({ length: 5 }, (_, index) =>
      telemetryKey(now - index * TELEMETRY_WINDOW_MS),
    );
    const buckets = await Promise.all(keys.map((key) => redis.hgetall(key)));
    let waitSamples = 0;
    let responseSamples = 0;
    let response429 = 0;
    const histogram = new Map<number, number>();
    for (const bucket of buckets) {
      waitSamples += Number(bucket.waitSamples ?? 0);
      responseSamples += Number(bucket.responseSamples ?? 0);
      response429 += Number(bucket.response429 ?? 0);
      for (const threshold of WAIT_HISTOGRAM_BUCKETS) {
        histogram.set(
          threshold,
          (histogram.get(threshold) ?? 0) + Number(bucket[`waitLe${threshold}`] ?? 0),
        );
      }
    }
    if (waitSamples <= 0 && responseSamples <= 0) {
      return { waitP95Ms: null, response429Rate: null, waitSamples: 0, responseSamples: 0 };
    }
    const target = Math.max(1, Math.ceil(waitSamples * 0.95));
    let cumulative = 0;
    let waitP95Ms: number | null = null;
    for (const threshold of WAIT_HISTOGRAM_BUCKETS) {
      cumulative += histogram.get(threshold) ?? 0;
      if (cumulative >= target) {
        waitP95Ms = threshold;
        break;
      }
    }
    return {
      waitP95Ms,
      response429Rate: responseSamples > 0 ? response429 / responseSamples : null,
      waitSamples,
      responseSamples,
    };
  } catch {
    return { waitP95Ms: null, response429Rate: null, waitSamples: 0, responseSamples: 0 };
  }
}

export class FplAdmissionUnavailableError extends FPLClientError {
  constructor(cause?: unknown) {
    super(
      'FPL upstream admission is temporarily unavailable; retry later',
      503,
      'FPL_ADMISSION_UNAVAILABLE',
      cause instanceof Error ? cause : undefined,
    );
    this.name = 'FplAdmissionUnavailableError';
  }
}

export const ACQUIRE_SCRIPT = `
local nowParts = redis.call('TIME')
local now = tonumber(nowParts[1]) * 1000 + math.floor(tonumber(nowParts[2]) / 1000)
local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now)
for _, token in ipairs(expired) do
  local priority = redis.call('HGET', KEYS[4], token)
  if priority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
  if priority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
  if priority == 'live' or priority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'inflight', -1) end
  redis.call('DEL', KEYS[3] .. token)
  redis.call('HDEL', KEYS[4], token)
end
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local inflight = tonumber(redis.call('HGET', KEYS[1], 'inflight') or '0')
local live = tonumber(redis.call('HGET', KEYS[1], 'live') or '0')
local bulk = tonumber(redis.call('HGET', KEYS[1], 'bulk') or '0')
local configuredBulkLimit = tonumber(ARGV[3])
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
if ARGV[1] == 'bulk' and bulk >= bulkLimit then return {'wait', 'capacity', '100'} end
if inflight >= tonumber(ARGV[4]) then return {'wait', 'capacity', '100'} end
local lastRefill = tonumber(redis.call('HGET', KEYS[1], 'lastRefillMs') or now)
-- The token bucket capacity is the shared request rate, not the bulk
-- concurrency cap.  Keeping these separate preserves a full 4-request
-- burst while still reserving two of the five in-flight leases for live.
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens') or ARGV[5])
local elapsed = math.max(0, now - lastRefill)
tokens = math.min(tonumber(ARGV[5]), tokens + elapsed * tonumber(ARGV[5]) / 1000)
if tokens < 1 then
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefillMs', now, 'bulkLimit', bulkLimit)
  return {'wait', 'rate', tostring(math.ceil((1 - tokens) * 1000 / tonumber(ARGV[5])))}
end
tokens = tokens - 1
local token = ARGV[2]
redis.call('HSET', KEYS[1], 'tokens', tokens, 'lastRefillMs', now, 'bulkLimit', bulkLimit)
redis.call('HINCRBY', KEYS[1], 'inflight', 1)
if ARGV[1] == 'live' then redis.call('HINCRBY', KEYS[1], 'live', 1) else redis.call('HINCRBY', KEYS[1], 'bulk', 1) end
redis.call('SET', KEYS[3] .. token, ARGV[1], 'PX', ARGV[6])
redis.call('HSET', KEYS[4], token, ARGV[1])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), token)
return {'granted', token}
`;

const RELEASE_SCRIPT = `
local priority = redis.call('HGET', KEYS[4], ARGV[1])
if not priority then return 0 end
redis.call('DEL', KEYS[3] .. ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('HINCRBY', KEYS[1], 'inflight', -1)
if priority == 'live' then redis.call('HINCRBY', KEYS[1], 'live', -1) end
if priority == 'bulk' then redis.call('HINCRBY', KEYS[1], 'bulk', -1) end
return 1
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

export type FplAdmissionOptions = {
  deadlineAt?: number;
};

type LocalWaiter = {
  priority: FplRequestPriority;
  waitStartedAt: number;
  deadlineAt?: number;
  timeout: ReturnType<typeof setTimeout> | null;
  resolve: (release: () => void) => void;
  reject: (error: FplAdmissionUnavailableError) => void;
};
let localInflight = 0;
let localLive = 0;
let localBulk = 0;
let localBulkLimit = BULK_MAX_INFLIGHT;
let localLastError = 0;
const localWaiters: LocalWaiter[] = [];

function useLocalTestScheduler(): boolean {
  return (
    runtimeConfig.NODE_ENV === 'test' ||
    parseStrictBooleanEnvValue(
      process.env.FPL_ADMISSION_TEST_MODE,
      false,
      'FPL_ADMISSION_TEST_MODE',
    )
  );
}

function localCanStart(priority: FplRequestPriority): boolean {
  if (localInflight >= MAX_INFLIGHT) return false;
  if (priority === 'bulk' && localBulk >= localBulkLimit) return false;
  return true;
}

function createLocalRelease(priority: FplRequestPriority): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    localInflight -= 1;
    if (priority === 'live') localLive -= 1;
    else localBulk -= 1;
    localDrain();
  };
}

function localDrain(): void {
  const now = Date.now();
  for (let index = localWaiters.length - 1; index >= 0; index -= 1) {
    const waiter = localWaiters[index];
    if (waiter?.deadlineAt === undefined || waiter.deadlineAt > now) continue;
    localWaiters.splice(index, 1);
    if (waiter.timeout) clearTimeout(waiter.timeout);
    waiter.reject(new FplAdmissionUnavailableError(new Error('Admission deadline exceeded')));
  }
  while (localWaiters.length) {
    const liveIndex = localWaiters.findIndex((item) => item.priority === 'live');
    const index = liveIndex >= 0 ? liveIndex : 0;
    const selected = localWaiters[index];
    if (!selected || !localCanStart(selected.priority)) return;
    localWaiters.splice(index, 1);
    if (selected.timeout) clearTimeout(selected.timeout);
    localInflight += 1;
    if (selected.priority === 'live') localLive += 1;
    else localBulk += 1;
    recordFplAdmissionWait(Date.now() - selected.waitStartedAt);
    selected.resolve(createLocalRelease(selected.priority));
  }
}

function localAcquire(
  priority: FplRequestPriority,
  options: FplAdmissionOptions,
): Promise<() => void> {
  const waitStartedAt = Date.now();
  if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
    return Promise.reject(
      new FplAdmissionUnavailableError(new Error('Admission deadline exceeded')),
    );
  }
  if (!localCanStart(priority)) {
    return new Promise<() => void>((resolve, reject) => {
      const waiter: LocalWaiter = {
        priority,
        waitStartedAt,
        deadlineAt: options.deadlineAt,
        timeout: null,
        resolve,
        reject,
      };
      if (options.deadlineAt !== undefined) {
        waiter.timeout = setTimeout(
          () => {
            const index = localWaiters.indexOf(waiter);
            if (index < 0) return;
            localWaiters.splice(index, 1);
            reject(new FplAdmissionUnavailableError(new Error('Admission deadline exceeded')));
            localDrain();
          },
          Math.max(options.deadlineAt - Date.now(), 0),
        );
      }
      localWaiters.push(waiter);
    });
  }
  localInflight += 1;
  if (priority === 'live') localLive += 1;
  else localBulk += 1;
  recordFplAdmissionWait(Date.now() - waitStartedAt);
  return Promise.resolve(createLocalRelease(priority));
}

function remainingAdmissionMs(deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - Date.now();
}

function assertAdmissionDeadline(deadlineAt: number | undefined): void {
  if (remainingAdmissionMs(deadlineAt) <= 0) {
    throw new FplAdmissionUnavailableError(new Error('Admission deadline exceeded'));
  }
}

async function distributedAcquire(
  priority: FplRequestPriority,
  options: FplAdmissionOptions,
): Promise<() => void> {
  const token = randomUUID();
  const waitStartedAt = Date.now();
  let redis: Awaited<ReturnType<typeof queueRedisSingleton.getClient>>;
  try {
    assertAdmissionDeadline(options.deadlineAt);
    redis = await queueRedisSingleton.getClient();
    assertAdmissionDeadline(options.deadlineAt);
  } catch (error) {
    throw new FplAdmissionUnavailableError(error);
  }
  for (;;) {
    assertAdmissionDeadline(options.deadlineAt);
    let result: string[];
    try {
      result = (await redis.eval(
        ACQUIRE_SCRIPT,
        4,
        STATE_KEY,
        LEASES_KEY,
        LEASE_KEY_PREFIX,
        LEASE_META_KEY,
        priority,
        token,
        BULK_MAX_INFLIGHT,
        MAX_INFLIGHT,
        REQUESTS_PER_SECOND,
        LEASE_MS,
      )) as string[];
    } catch (error) {
      throw new FplAdmissionUnavailableError(error);
    }
    if (result[0] === 'granted') {
      if (remainingAdmissionMs(options.deadlineAt) <= 0) {
        try {
          await redis.eval(
            RELEASE_SCRIPT,
            4,
            STATE_KEY,
            LEASES_KEY,
            LEASE_KEY_PREFIX,
            LEASE_META_KEY,
            token,
          );
        } catch {
          // The expired lease is cleaned up by the next acquisition.
        }
        throw new FplAdmissionUnavailableError(new Error('Admission deadline exceeded'));
      }
      logDebug('FPL request admitted by Redis lease', {
        priority,
        admissionVersion: ADMISSION_SCRIPT_VERSION,
      });
      recordFplAdmissionWait(Date.now() - waitStartedAt);
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        try {
          await redis.eval(
            RELEASE_SCRIPT,
            4,
            STATE_KEY,
            LEASES_KEY,
            LEASE_KEY_PREFIX,
            LEASE_META_KEY,
            token,
          );
        } catch {
          // The lease TTL is the safety net when Redis disappears during release.
        }
      };
    }
    const waitMs = Math.max(10, Math.min(1_000, Number(result[2] ?? 100)));
    const remaining = remainingAdmissionMs(options.deadlineAt);
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(waitMs, remaining)));
  }
}

export async function acquireFplRequest(
  priority: FplRequestPriority,
  options: FplAdmissionOptions = {},
): Promise<() => void> {
  if (useLocalTestScheduler()) return localAcquire(priority, options);
  return distributedAcquire(priority, options);
}

export function reportFplResponse(
  priority: FplRequestPriority,
  status: number | null,
  now = Date.now(),
): void {
  recordFplResponseTelemetry(status);
  if (priority !== 'bulk') return;
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
  void queueRedisSingleton
    .getClient()
    .then((redis) =>
      redis.eval(REPORT_SCRIPT, 1, STATE_KEY, status === null ? 0 : status, BULK_MAX_INFLIGHT),
    )
    .catch(() => undefined);
}

export function getFplAdmissionStats() {
  return {
    inflight: localInflight,
    liveInflight: localLive,
    bulkInflight: localBulk,
    queued: localWaiters.length,
    maxInflight: MAX_INFLIGHT,
    bulkMaxInflight: localBulkLimit,
    requestsPerSecond: REQUESTS_PER_SECOND,
    distributed: !useLocalTestScheduler(),
  };
}

export function resetFplAdmissionForTests(): void {
  localInflight = 0;
  localLive = 0;
  localBulk = 0;
  localBulkLimit = BULK_MAX_INFLIGHT;
  localLastError = 0;
  localWaiters.splice(0).forEach((waiter) => {
    if (waiter.timeout) clearTimeout(waiter.timeout);
  });
}
