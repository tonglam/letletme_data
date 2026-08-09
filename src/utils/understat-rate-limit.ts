import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';

import {
  getConfig,
  resolveQueueRedisConfig,
  type AppConfig,
  type RedisEndpointConfig,
} from './config';

const PERMIT_KEY = 'llm:v3:queue:coordination:understat-request-permits';
const PERMIT_LEASE_PADDING_MS = 5_000;
const PERMIT_WAIT_TIMEOUT_MS = 120_000;
const PERMIT_POLL_MS = 100;

const ACQUIRE_SCRIPT = `
local now = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local expiresAt = tonumber(ARGV[3])
local token = ARGV[4]

redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= limit then
  return 0
end

redis.call('ZADD', KEYS[1], expiresAt, token)
redis.call('PEXPIRE', KEYS[1], math.max(expiresAt - now, 1) * 2)
return 1
`;

const RELEASE_SCRIPT = `
return redis.call('ZREM', KEYS[1], ARGV[1])
`;

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

let permitClient: Redis | null = null;

export function resolveUnderstatPermitRedisConfig(config: AppConfig): RedisEndpointConfig {
  return resolveQueueRedisConfig(config);
}

function getPermitClient(): Redis {
  if (permitClient) return permitClient;
  const connection = resolveUnderstatPermitRedisConfig(getConfig());
  permitClient = new Redis({
    host: connection.host,
    port: connection.port,
    password: connection.password,
    db: connection.db,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
  return permitClient;
}

export async function closeUnderstatPermitClient(): Promise<void> {
  if (!permitClient) return;
  permitClient.disconnect();
  permitClient = null;
}

/**
 * Acquire one provider-wide request permit. The sorted-set lease makes the
 * concurrency limit apply across both lanes and across horizontally scaled
 * worker processes; an interrupted worker cannot leak a permit permanently.
 */
export async function acquireUnderstatRequestPermit(): Promise<() => Promise<void>> {
  const config = getConfig();
  const redis = getPermitClient();
  const token = randomUUID();
  const leaseMs = config.UNDERSTAT_TIMEOUT_MS + PERMIT_LEASE_PADDING_MS;
  const deadline = Date.now() + PERMIT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const now = Date.now();
    const acquired = await redis.eval(
      ACQUIRE_SCRIPT,
      1,
      PERMIT_KEY,
      now,
      config.UNDERSTAT_MAX_CONCURRENCY,
      now + leaseMs,
      token,
    );
    if (Number(acquired) === 1) {
      return async () => {
        await redis.eval(RELEASE_SCRIPT, 1, PERMIT_KEY, token);
      };
    }
    await sleep(PERMIT_POLL_MS);
  }

  throw new Error('Timed out waiting for an Understat request permit');
}
