import { describe, expect, test } from 'bun:test';
import type postgres from 'postgres';

import { withPostgresQueryTimeout } from '../../src/db/postgres-query-timeout';

function fixture(timeoutMs = 20) {
  let cancelCount = 0;
  let executionCount = 0;
  let reject!: (error: Error) => void;
  let resolve!: (rows: unknown[]) => void;
  let values = false;
  const pending = new Promise<unknown[]>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const query = {
    then(
      onfulfilled: Parameters<typeof pending.then>[0],
      onrejected: Parameters<typeof pending.then>[1],
    ) {
      executionCount += 1;
      return pending.then(onfulfilled, onrejected);
    },
    cancel() {
      cancelCount += 1;
    },
    values() {
      values = true;
      return this;
    },
  };
  const raw = Object.assign(() => query, {
    unsafe: () => query,
    begin: async (...args: unknown[]) => {
      const callback = args.at(-1) as (tx: unknown) => Promise<unknown>;
      return callback(raw);
    },
    savepoint: async (...args: unknown[]) => {
      const callback = args.at(-1) as (tx: unknown) => Promise<unknown>;
      return callback(raw);
    },
  });
  const client = withPostgresQueryTimeout(raw as unknown as postgres.Sql, timeoutMs);
  return { client, resolve, reject, counts: () => ({ cancelCount, executionCount, values }) };
}

describe('scheduler database query cancellation', () => {
  test('removes expired queued operations without executing them after recovery', async () => {
    const f = fixture();
    const active = Promise.resolve(f.client`active`);
    const queued = Array.from({ length: 8 }, () =>
      Promise.resolve(f.client`queued`).catch((error: Error) => error),
    );
    await Bun.sleep(35);
    expect(f.counts().executionCount).toBe(1);
    expect((await Promise.all(queued)).every((result) => result instanceof Error)).toBe(true);
    f.resolve([]);
    await active;
    await f.client`after recovery`;
    expect(f.counts().executionCount).toBe(2);
  });

  test('nested deadlines discard inner queued work without cancelling its unconsumed driver query', async () => {
    const f = fixture(1000);
    const active = Promise.resolve(f.client`active`);
    await Bun.sleep(1);
    const outer = withPostgresQueryTimeout(f.client, 5);
    const queued = Promise.resolve(outer`queued`).catch((error: Error) => error);
    await Bun.sleep(12);
    expect(f.counts().cancelCount).toBe(0);
    expect(await queued).toBeInstanceOf(Error);
    f.resolve([]);
    await active;
    expect(f.counts().executionCount).toBe(1);
  });

  test('explicit cancellation before consumption never sends the query to the driver', async () => {
    const f = fixture();
    const query = f.client`cancel before await`;
    query.cancel();
    await expect(Promise.resolve(query)).rejects.toThrow('cancelled');
    expect(f.counts().executionCount).toBe(0);
    expect(f.counts().cancelCount).toBe(0);
  });

  test('cancellation immediately after execute fences the admission microtask', async () => {
    const f = fixture();
    const query = f.client`cancel after execute`.execute();
    query.cancel();
    await expect(Promise.resolve(query)).rejects.toThrow('cancelled');
    expect(f.counts().executionCount).toBe(0);
    expect(f.counts().cancelCount).toBe(0);
  });

  test('keeps unconsumed SQL fragments lazy', async () => {
    const f = fixture();
    void f.client`fragment`;
    await Bun.sleep(35);
    expect(f.counts().executionCount).toBe(0);
    expect(f.counts().cancelCount).toBe(0);
  });

  test('cancels once and waits for driver settlement rather than releasing the caller early', async () => {
    const f = fixture();
    const query = f.client.unsafe('select slow').values();
    let settled = false;
    const result = Promise.resolve(query).finally(() => {
      settled = true;
    });
    const rejection = result.catch((error: Error) => error);
    await Bun.sleep(35);
    expect(f.counts()).toEqual({ cancelCount: 1, executionCount: 1, values: true });
    expect(settled).toBe(false);
    f.reject(new Error('cancel acknowledged'));
    expect(await rejection).toBeInstanceOf(Error);
  });

  test('does not cancel a completed query or start it twice when awaited twice', async () => {
    const f = fixture();
    const query = f.client`select fast`;
    const left = Promise.resolve(query);
    const right = Promise.resolve(query);
    f.resolve([{ ok: true }]);
    expect(Array.from(await left)).toEqual([{ ok: true }]);
    expect(Array.from(await right)).toEqual([{ ok: true }]);
    await Bun.sleep(35);
    expect(f.counts().cancelCount).toBe(0);
    expect(f.counts().executionCount).toBe(1);
  });

  test('wraps transaction and savepoint clients, preserving options and failure propagation', async () => {
    const f = fixture();
    const result = f.client.begin('read only', (tx) =>
      tx.savepoint('bounded', (nested) => nested`select slow`),
    );
    const rejection = result.catch((error: Error) => error);
    await Bun.sleep(35);
    expect(f.counts().cancelCount).toBe(1);
    f.reject(new Error('transaction aborted'));
    expect(await rejection).toBeInstanceOf(Error);
  });
});
