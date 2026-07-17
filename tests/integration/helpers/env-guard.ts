/**
 * Integration-test safety fence (FP-02 / review finding C2).
 *
 * Every file under tests/integration must import this module FIRST (before any
 * src/* / queue imports) and also call `assertIntegrationEnv()` in the module
 * body:
 *
 *   import { assertIntegrationEnv } from './helpers/env-guard';
 *
 *   assertIntegrationEnv();
 *
 * Dual fence:
 * 1. Top-level assert at the bottom of THIS module — when this file is the first
 *    import of a test, ESM evaluates it before sibling imports, so BullMQ Queue
 *    construction in later imports never runs against an unsafe env.
 * 2. Per-file `assertIntegrationEnv()` call — `bun test` shares the module
 *    registry across files, so a prior successful load would skip re-evaluation;
 *    the call re-checks every file.
 *
 * Fails unless ALL of the following hold:
 *
 *   1. RUN_INTEGRATION=1 — integration tests only run via `bun run test:integration`.
 *   2. DATABASE_URL points at test infrastructure (matches localhost | 127.0.0.1 | _test).
 *   3. The effective Redis DB indexes for BOTH the cache client (REDIS_DB) and the
 *      BullMQ queues (QUEUE_REDIS_DB ?? REDIS_DB) are non-zero, so cache flushes
 *      and `queue.drain()` can never touch the shared default (production) DB.
 */

const SAFE_DATABASE_URL_PATTERN = /localhost|127\.0\.0\.1|_test/i;

function fail(reason: string): never {
  throw new Error(
    [
      `[env-guard] Integration tests refused to start: ${reason}.`,
      '[env-guard] Integration tests open real PostgreSQL/Redis connections and write data.',
      '[env-guard] Point DATABASE_URL at a local or *_test database, set REDIS_DB (and',
      '[env-guard] QUEUE_REDIS_DB when used) to a non-zero test index, then run:',
      '[env-guard]   bun run test:integration',
    ].join('\n'),
  );
}

function redisDbIndex(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return 0;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

export function assertIntegrationEnv(): void {
  if (process.env.RUN_INTEGRATION !== '1') {
    fail('RUN_INTEGRATION=1 is not set');
  }

  const databaseUrl = process.env.DATABASE_URL ?? '';
  if (!SAFE_DATABASE_URL_PATTERN.test(databaseUrl)) {
    fail('DATABASE_URL does not match test infrastructure (localhost | 127.0.0.1 | _test)');
  }

  const cacheDb = redisDbIndex(process.env.REDIS_DB);
  if (cacheDb === 0) {
    fail('REDIS_DB is unset or 0 (the shared default cache DB)');
  }

  const queueDb =
    process.env.QUEUE_REDIS_DB !== undefined ? redisDbIndex(process.env.QUEUE_REDIS_DB) : cacheDb;
  if (queueDb === 0) {
    fail('QUEUE_REDIS_DB resolves to 0 (BullMQ queues would drain against the shared DB)');
  }
}

// First-import fence: when a test lists this module before infra imports,
// evaluation stops here on an unsafe env so Queue constructors never run.
assertIntegrationEnv();
