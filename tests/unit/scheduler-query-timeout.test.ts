import { describe, expect, test } from 'bun:test';
import type postgres from 'postgres';

import { withSchedulerQueryTimeout } from '../../src/db/scheduler-query-timeout';

function fixture() {
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
  const client = withSchedulerQueryTimeout(raw as unknown as postgres.Sql, 20);
  return { client, resolve, reject, counts: () => ({ cancelCount, executionCount, values }) };
}

describe('scheduler database query cancellation', () => {
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
