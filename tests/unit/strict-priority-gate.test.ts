import { describe, expect, it } from 'bun:test';
import type { Queue, Worker } from 'bullmq';

import { startStrictPriorityGate } from '../../src/workers/strict-priority-gate';

type MutableCounts = { waiting: number; active: number; delayed: number };

class FakeQueue {
  constructor(private readonly counts: MutableCounts) {}

  async getJobCounts() {
    return this.counts;
  }
}

class FakeWorker {
  paused = false;
  pauseCount = 0;
  resumeCount = 0;

  async pause() {
    this.paused = true;
    this.pauseCount += 1;
  }

  async resume() {
    this.paused = false;
    this.resumeCount += 1;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('strict priority gate', () => {
  it('pauses lower tiers when higher tiers have backlog, then resumes', async () => {
    const p0Counts: MutableCounts = { waiting: 2, active: 0, delayed: 0 };
    const p1Counts: MutableCounts = { waiting: 1, active: 0, delayed: 0 };
    const p2Counts: MutableCounts = { waiting: 1, active: 0, delayed: 0 };
    const p3Counts: MutableCounts = { waiting: 1, active: 0, delayed: 0 };

    const p0Worker = new FakeWorker();
    const p1Worker = new FakeWorker();
    const p2Worker = new FakeWorker();
    const p3Worker = new FakeWorker();

    const gate = startStrictPriorityGate(
      'test-domain',
      {
        p0: {
          queue: new FakeQueue(p0Counts) as unknown as Queue<unknown>,
          worker: p0Worker as unknown as Worker<unknown>,
        },
        p1: {
          queue: new FakeQueue(p1Counts) as unknown as Queue<unknown>,
          worker: p1Worker as unknown as Worker<unknown>,
        },
        p2: {
          queue: new FakeQueue(p2Counts) as unknown as Queue<unknown>,
          worker: p2Worker as unknown as Worker<unknown>,
        },
        p3: {
          queue: new FakeQueue(p3Counts) as unknown as Queue<unknown>,
          worker: p3Worker as unknown as Worker<unknown>,
        },
      },
      { enabled: true, pollMs: 10 },
    );

    await sleep(40);

    expect(p1Worker.paused).toBe(true);
    expect(p2Worker.paused).toBe(true);
    expect(p3Worker.paused).toBe(true);

    p0Counts.waiting = 0;
    p1Counts.waiting = 0;
    p2Counts.waiting = 0;
    p3Counts.waiting = 0;

    await sleep(40);

    expect(p1Worker.paused).toBe(false);
    expect(p2Worker.paused).toBe(false);
    expect(p3Worker.paused).toBe(false);
    expect(p1Worker.resumeCount).toBeGreaterThan(0);
    expect(p2Worker.resumeCount).toBeGreaterThan(0);
    expect(p3Worker.resumeCount).toBeGreaterThan(0);

    gate.stop();
  });
});
