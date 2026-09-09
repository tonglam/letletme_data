import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql as query } from 'drizzle-orm';

import { withPostgresQueryTimeout } from '../../src/db/postgres-query-timeout';

const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
const bounded = withPostgresQueryTimeout(raw, 150);
const db = drizzle(bounded);
afterAll(async () => {
  await bounded.end({ timeout: 1 });
});

describe('scheduler SQL deadlines against PostgreSQL', () => {
  test('bounds pool acquisition and never runs an expired transaction callback later', async () => {
    let release!: () => void;
    let acquired!: () => void;
    const ready = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = raw.begin(async () => {
      acquired();
      await hold;
    });
    await ready;
    let calls = 0;
    const started = Date.now();
    await expect(
      bounded.begin(async () => {
        calls += 1;
      }),
    ).rejects.toThrow('transaction acquisition');
    expect(Date.now() - started).toBeLessThan(1000);
    await expect(
      bounded.begin(async () => {
        calls += 1;
      }),
    ).rejects.toThrow('transaction acquisition');
    release();
    await owner;
    await Bun.sleep(100);
    expect(calls).toBe(0);
    expect((await bounded.begin((tx) => tx`SELECT 42 AS answer`))[0]?.answer).toBe(42);
  });

  test('cancels pg_sleep and lets the single connection execute the next query', async () => {
    await bounded`SELECT 1`;
    const started = Date.now();
    await expect(Promise.resolve(bounded`SELECT pg_sleep(3)`)).rejects.toMatchObject({
      code: '57014',
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await bounded`SELECT 42 AS answer`)[0]?.answer).toBe(42);
  });

  test('cancels Drizzle queries and rolls back earlier writes in their transaction', async () => {
    await bounded`CREATE TEMP TABLE scheduler_deadline_test (value integer)`;
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(query`INSERT INTO scheduler_deadline_test VALUES (1)`);
        await tx.execute(query`SELECT pg_sleep(3)`);
      }),
    ).rejects.toThrow();
    expect(
      (await bounded`SELECT count(*)::int AS count FROM scheduler_deadline_test`)[0]?.count,
    ).toBe(0);
  });

  test('preserves lazy fragments and values mode', async () => {
    const fragment = bounded`40 + 2`;
    await Bun.sleep(200);
    const rows = await bounded`SELECT ${fragment} AS answer`.values();
    expect(rows[0]).toEqual([42]);
  });

  test('discards queued writes before sending them and keeps later work usable', async () => {
    await bounded`CREATE TEMP TABLE scheduler_queued_test (value integer)`;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const busy = bounded.begin(async () => {
      started();
      await Bun.sleep(500);
    });
    await ready;
    await expect(
      Promise.resolve(bounded`INSERT INTO scheduler_queued_test VALUES (1)`),
    ).rejects.toThrow('queue wait');
    await busy;
    expect(
      (await bounded`SELECT count(*)::int AS count FROM scheduler_queued_test`)[0]?.count,
    ).toBe(0);
  });

  test('a cancelled savepoint does not poison the outer transaction', async () => {
    const rows = await bounded.begin(async (tx) => {
      await expect(tx.savepoint((nested) => nested`SELECT pg_sleep(3)`)).rejects.toMatchObject({
        code: '57014',
      });
      return tx`SELECT 42 AS answer`;
    });
    expect(rows[0]?.answer).toBe(42);
  });
});
