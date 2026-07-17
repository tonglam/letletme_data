import Redis from 'ioredis';

import { resolveMutationScopes } from '../domain/mutation-scope';
import { logError, logInfo, logWarn } from './logger';
import { getQueueConnection } from './queue';

const DEFAULT_LOCK_TTL_MS = Number(process.env.MUTATION_LOCK_TTL_MS ?? 30_000);
const DEFAULT_WAIT_TIMEOUT_MS = Number(process.env.MUTATION_LOCK_WAIT_TIMEOUT_MS ?? 120_000);
const DEFAULT_RETRY_DELAY_MS = Number(process.env.MUTATION_LOCK_RETRY_DELAY_MS ?? 250);
const DEFAULT_HEARTBEAT_MS = Number(process.env.MUTATION_LOCK_HEARTBEAT_MS ?? 10_000);
const LOCK_ENABLED =
  (process.env.ENABLE_MUTATION_CONFLICT_GUARD ?? 'true').toLowerCase() !== 'false';

type MutationLockInput = {
  queueName: string;
  jobName: string;
  jobId?: string;
  eventId?: number;
  tournamentId?: number;
};

let lockClient: Redis | null = null;

function getLockClient(): Redis {
  if (lockClient) {
    return lockClient;
  }
  const connection = getQueueConnection();
  lockClient = new Redis({
    host: connection.host,
    port: connection.port,
    password: connection.password,
    db: connection.db,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
  });
  return lockClient;
}

/** Close the shared lock client (worker shutdown, integration test teardown). */
export async function closeLockClient(): Promise<void> {
  if (!lockClient) {
    return;
  }
  lockClient.disconnect();
  lockClient = null;
}

function randomToken() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryAcquire(
  client: Redis,
  key: string,
  token: string,
  ttlMs: number,
): Promise<boolean> {
  const result = await client.set(key, token, 'PX', ttlMs, 'NX');
  return result === 'OK';
}

async function releaseLock(client: Redis, key: string, token: string): Promise<void> {
  await client.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("DEL", KEYS[1])
      end
      return 0
    `,
    1,
    key,
    token,
  );
}

async function heartbeatLock(
  client: Redis,
  key: string,
  token: string,
  ttlMs: number,
): Promise<void> {
  await client.eval(
    `
      if redis.call("GET", KEYS[1]) == ARGV[1] then
        return redis.call("PEXPIRE", KEYS[1], ARGV[2])
      end
      return 0
    `,
    1,
    key,
    token,
    String(ttlMs),
  );
}

export async function withMutationConflictGuard<T>(
  input: MutationLockInput,
  operation: () => Promise<T>,
): Promise<T> {
  if (!LOCK_ENABLED) {
    return operation();
  }

  const scopes = resolveMutationScopes(input);
  if (scopes.length === 0) {
    return operation();
  }

  const lockKeys = [...new Set(scopes.map((scope) => `mutation-lock:${scope}`))].sort();
  const client = getLockClient();
  const token = randomToken();
  const acquiredKeys: string[] = [];
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  try {
    while (acquiredKeys.length < lockKeys.length) {
      const nextKey = lockKeys[acquiredKeys.length];
      const acquired = await tryAcquire(client, nextKey, token, DEFAULT_LOCK_TTL_MS);
      if (acquired) {
        acquiredKeys.push(nextKey);
        continue;
      }

      if (Date.now() - startedAt > DEFAULT_WAIT_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for mutation locks: ${lockKeys.join(', ')} (job=${input.jobName}, queue=${input.queueName})`,
        );
      }

      if (acquiredKeys.length > 0) {
        await Promise.all(acquiredKeys.map((key) => releaseLock(client, key, token)));
        acquiredKeys.length = 0;
      }

      await sleep(DEFAULT_RETRY_DELAY_MS + Math.floor(Math.random() * DEFAULT_RETRY_DELAY_MS));
    }

    logInfo('Mutation conflict guard acquired locks', {
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      lockKeys,
    });

    heartbeat = setInterval(() => {
      void Promise.all(
        acquiredKeys.map((key) => heartbeatLock(client, key, token, DEFAULT_LOCK_TTL_MS)),
      ).catch((error) => {
        logWarn('Mutation lock heartbeat failed', {
          queueName: input.queueName,
          jobName: input.jobName,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, DEFAULT_HEARTBEAT_MS);
    heartbeat.unref?.();

    return await operation();
  } catch (error) {
    logError('Mutation conflict guard failed', error, {
      queueName: input.queueName,
      jobName: input.jobName,
      jobId: input.jobId,
      lockKeys,
    });
    throw error;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    if (acquiredKeys.length > 0) {
      await Promise.all(acquiredKeys.map((key) => releaseLock(client, key, token)));
      logInfo('Mutation conflict guard released locks', {
        queueName: input.queueName,
        jobName: input.jobName,
        jobId: input.jobId,
        lockKeys: acquiredKeys,
      });
    }
  }
}
