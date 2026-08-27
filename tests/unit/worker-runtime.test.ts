import { describe, expect, test } from 'bun:test';
import type { Worker } from 'bullmq';

import { drainWorkers } from '../../src/workers/worker-runtime';

function fakeWorker(close: () => Promise<void>): Worker {
  return { close } as unknown as Worker;
}

describe('worker runtime draining', () => {
  test('waits for every worker before surfacing a close failure', async () => {
    const events: string[] = [];
    const workers = [
      fakeWorker(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push('slow');
      }),
      fakeWorker(async () => {
        events.push('failed');
        throw new Error('redis socket closed');
      }),
    ];

    await expect(drainWorkers(workers)).rejects.toThrow('BullMQ worker(s) failed to drain');
    expect(events).toEqual(['failed', 'slow']);
  });
});
