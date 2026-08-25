import { describe, expect, test } from 'bun:test';

import type { SchedulerObligation } from '../../src/repositories/scheduler-obligations';
import {
  decideSchedulerEnqueueRecovery,
  reconcileExpiredSchedulerEnqueueClaims,
  type SchedulerQueueJobSnapshot,
} from '../../src/scheduler/scheduler-enqueue-recovery';

function obligation(
  obligationId: string,
  generation: number,
  jobName = 'recoverable-job',
): SchedulerObligation {
  return {
    obligationId,
    jobName,
    scopeKey: '2627',
    periodKey: obligationId,
    cadence: 'test',
    timezone: 'UTC',
    status: 'enqueued',
    source: 'reconcile',
    dueAt: new Date('2026-08-25T00:00:00.000Z'),
    generation,
    attempts: 1,
    bullJobId: null,
    runId: null,
    leaseOwner: `owner-${obligationId}`,
    leaseExpiresAt: new Date('2026-08-25T00:01:00.000Z'),
    evidence: {},
  };
}

function queueJob(
  obligationId: string,
  generation: number,
  state: string,
  failedReason?: string,
): SchedulerQueueJobSnapshot {
  return {
    id: `bull-${obligationId}`,
    name: 'recoverable-job',
    state,
    data: { obligationId, obligationGeneration: generation },
    ...(failedReason ? { failedReason } : {}),
  };
}

describe('scheduler enqueue recovery', () => {
  test('prioritizes active and queued evidence before terminal history', () => {
    expect(decideSchedulerEnqueueRecovery([])).toBe('retry-missing');
    expect(decideSchedulerEnqueueRecovery([queueJob('a', 1, 'completed')])).toBe('mark-succeeded');
    expect(
      decideSchedulerEnqueueRecovery([queueJob('a', 1, 'completed'), queueJob('a', 1, 'failed')]),
    ).toBe('mark-failed');
    expect(
      decideSchedulerEnqueueRecovery([queueJob('a', 1, 'failed'), queueJob('a', 1, 'waiting')]),
    ).toBe('retain-enqueued');
    expect(
      decideSchedulerEnqueueRecovery([queueJob('a', 1, 'waiting'), queueJob('a', 1, 'active')]),
    ).toBe('mark-running');
  });

  test('reconciles only exact generation matches before allowing a retry', async () => {
    const candidates = [
      obligation('waiting', 2),
      obligation('active', 4),
      obligation('completed', 1),
      obligation('failed', 3),
      obligation('missing', 5),
    ];
    const jobs = [
      queueJob('waiting', 2, 'waiting'),
      queueJob('active', 4, 'active'),
      queueJob('completed', 1, 'completed'),
      queueJob('failed', 3, 'failed', 'worker exhausted retries'),
      // A stale generation is deliberately ignored for the missing candidate.
      queueJob('missing', 4, 'waiting'),
    ];
    const confirmed: string[] = [];
    const started: string[] = [];
    const renewed: string[] = [];
    const completed: string[] = [];
    const failed: string[] = [];

    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'recoverable-job', queueName: 'recoverable-queue' }],
      dependencies: {
        listCandidates: async () => candidates,
        loadJobs: async (queueName) => {
          expect(queueName).toBe('recoverable-queue');
          return jobs;
        },
        confirm: async (input) => {
          confirmed.push(input.obligationId);
          return true;
        },
        start: async (input) => {
          started.push(input.obligationId);
          return true;
        },
        renew: async (input) => {
          renewed.push(input.obligationId);
          return true;
        },
        complete: async (input) => {
          completed.push(input.obligationId);
          return true;
        },
        fail: async (input) => {
          failed.push(input.obligationId);
          return true;
        },
      },
    });

    expect(result).toEqual({
      candidates: 5,
      running: 1,
      retained: 1,
      succeeded: 1,
      retried: 2,
      unchanged: 0,
      errors: 0,
    });
    expect(confirmed.sort()).toEqual(['active', 'waiting']);
    expect(started).toEqual(['active']);
    expect(renewed).toEqual(['waiting']);
    expect(completed).toEqual(['completed']);
    expect(failed.sort()).toEqual(['failed', 'missing']);
  });
});
