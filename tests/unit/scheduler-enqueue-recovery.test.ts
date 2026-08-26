import { describe, expect, test } from 'bun:test';

import type { SchedulerObligation } from '../../src/repositories/scheduler-obligations';
import {
  decideSchedulerEnqueueRecovery,
  reconcileExpiredSchedulerEnqueueClaims,
  schedulerRecoveryFallbackViewComplete,
  schedulerRecoveryBullJobIds,
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
  test('passes latest-wins exclusions to the expired-claim query', async () => {
    let query: { excludedJobNames?: readonly string[] } | undefined;
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'recoverable-job', queueName: 'recoverable-queue' }],
      excludedJobNames: ['price-change-predictions'],
      dependencies: {
        listCandidates: async (input) => {
          query = input;
          return [];
        },
      },
    });

    expect(query).toEqual({ excludedJobNames: ['price-change-predictions'] });
    expect(result.candidates).toBe(0);
  });

  test('accepts an exactly full bounded recovery page', () => {
    expect(schedulerRecoveryFallbackViewComplete(199)).toBe(true);
    expect(schedulerRecoveryFallbackViewComplete(200)).toBe(true);
    expect(schedulerRecoveryFallbackViewComplete(201)).toBe(false);
  });

  test('uses confirmed Bull ids and deterministic ids for unconfirmed generations', () => {
    expect(
      schedulerRecoveryBullJobIds({ ...obligation('unconfirmed', 2), scopeKey: 'global' }),
    ).toEqual(['scheduler-unconfirmed-g2']);
    expect(
      schedulerRecoveryBullJobIds({ ...obligation('prefixed', 2), scopeKey: '2627:event:1' }),
    ).toEqual(['scheduler-prefixed-g2', '2627-scheduler-prefixed-g2']);
    expect(
      schedulerRecoveryBullJobIds({
        ...obligation('confirmed', 3),
        bullJobId: 'actual-confirmed-job',
      }),
    ).toEqual(['actual-confirmed-job']);
  });

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
        inspectJobs: async (queueName) => {
          expect(queueName).toBe('recoverable-queue');
          return { jobs, missingEvidenceVerified: true };
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
      skipped: 0,
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

  test('settles an expired confirmed running obligation from terminal Bull evidence', async () => {
    const candidate: SchedulerObligation = {
      ...obligation('confirmed-complete', 6),
      status: 'running',
      bullJobId: 'actual-confirmed-job',
    };
    const completed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'recoverable-job', queueName: 'recoverable-queue' }],
      dependencies: {
        listCandidates: async () => [candidate],
        inspectJobs: async (_queueName, candidates) => {
          expect(candidates).toEqual([candidate]);
          return {
            jobs: [
              {
                ...queueJob('confirmed-complete', 6, 'completed'),
                id: 'actual-confirmed-job',
              },
            ],
            missingEvidenceVerified: true,
          };
        },
        confirm: async () => {
          throw new Error('confirmed obligations must not be confirmed again');
        },
        start: async () => false,
        renew: async () => false,
        complete: async (input) => {
          completed.push(input.obligationId);
          return true;
        },
        fail: async () => false,
      },
    });

    expect(result).toEqual({
      candidates: 1,
      running: 0,
      retained: 0,
      succeeded: 1,
      skipped: 0,
      retried: 0,
      unchanged: 0,
      errors: 0,
    });
    expect(completed).toEqual(['confirmed-complete']);
  });

  test('trusts two missing exact-id observations for a root job in a busy queue', async () => {
    let inspections = 0;
    const failed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'recoverable-job', queueName: 'recoverable-queue' }],
      dependencies: {
        listCandidates: async () => [obligation('busy-root', 8)],
        inspectJobs: async () => {
          inspections += 1;
          return {
            jobs: [],
            missingEvidenceVerified: false,
            directLookupMissingObligationIds: ['busy-root'],
          };
        },
        confirm: async () => false,
        start: async () => false,
        renew: async () => false,
        complete: async () => false,
        fail: async (input) => {
          failed.push(input.obligationId);
          return true;
        },
      },
    });

    expect(inspections).toBe(2);
    expect(result.retried).toBe(1);
    expect(result.errors).toBe(0);
    expect(failed).toEqual(['busy-root']);
  });

  test('trusts two missing root-id observations for a never-started durable chain', async () => {
    let inspections = 0;
    const failed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'entry-results',
          queueName: 'entry-sync',
          recoveryCompletionMode: 'entry-scan-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => [obligation('never-started-chain', 9, 'entry-results')],
        inspectJobs: async () => {
          inspections += 1;
          return {
            jobs: [],
            missingEvidenceVerified: false,
            directLookupMissingObligationIds: ['never-started-chain'],
          };
        },
        confirm: async () => false,
        start: async () => false,
        renew: async () => false,
        complete: async () => false,
        fail: async (input) => {
          failed.push(input.obligationId);
          return true;
        },
      },
    });

    expect(inspections).toBe(2);
    expect(result.retried).toBe(1);
    expect(result.errors).toBe(0);
    expect(failed).toEqual(['never-started-chain']);
  });

  test('does not use root-id absence to prove a running durable chain is drained', async () => {
    let failCalls = 0;
    const renewed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'entry-results',
          queueName: 'entry-sync',
          recoveryCompletionMode: 'entry-scan-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => [
          { ...obligation('busy-chain', 9, 'entry-results'), status: 'running' },
        ],
        inspectJobs: async () => ({
          jobs: [],
          missingEvidenceVerified: false,
          directLookupMissingObligationIds: ['busy-chain'],
        }),
        confirm: async () => false,
        start: async () => false,
        renew: async (input) => {
          renewed.push(input.obligationId);
          return true;
        },
        complete: async () => false,
        fail: async () => {
          failCalls += 1;
          return true;
        },
      },
    });

    expect(result.retried).toBe(0);
    expect(result.retained).toBe(1);
    expect(result.errors).toBe(1);
    expect(failCalls).toBe(0);
    expect(renewed).toEqual(['busy-chain']);
  });

  test('preserves the price-change no-op terminal status during recovery', async () => {
    const completions: Array<{ status: string; evidence?: Record<string, unknown> }> = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'price-change-predictions', queueName: 'data-sync' }],
      dependencies: {
        listCandidates: async () => [
          obligation('price-change-noop', 3, 'price-change-predictions'),
        ],
        inspectJobs: async () => ({
          jobs: [
            {
              ...queueJob('price-change-noop', 3, 'completed'),
              name: 'price-change-predictions',
              returnValue: { outcome: 'noop' },
            },
          ],
          missingEvidenceVerified: true,
        }),
        confirm: async () => true,
        start: async () => false,
        renew: async () => false,
        complete: async (input) => {
          completions.push({ status: input.status, evidence: input.evidence });
          return true;
        },
        fail: async () => false,
      },
    });

    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(1);
    expect(completions).toEqual([
      {
        status: 'skipped',
        evidence: expect.objectContaining({ reason: 'official_fields_not_open' }),
      },
    ]);
  });

  test('retains a completed entry root while its continuation is still pending', async () => {
    const renewed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'entry-results',
          queueName: 'entry-sync',
          recoveryCompletionMode: 'entry-scan-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => [obligation('entry-chain', 2, 'entry-results')],
        inspectJobs: async () => ({
          jobs: [
            {
              ...queueJob('entry-chain', 2, 'completed'),
              name: 'entry-results',
              returnValue: { scanComplete: false },
            },
            {
              ...queueJob('entry-chain', 2, 'waiting'),
              id: 'entry-continuation',
              name: 'entry-results',
            },
          ],
          missingEvidenceVerified: true,
        }),
        confirm: async () => true,
        start: async () => false,
        renew: async (input) => {
          renewed.push(input.obligationId);
          return true;
        },
        complete: async () => {
          throw new Error('root completion is not semantic entry completion');
        },
        fail: async () => false,
      },
    });

    expect(result.retained).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(renewed).toEqual(['entry-chain']);
  });

  test('requires scanComplete before recovering an entry chain as succeeded', async () => {
    const completed: string[] = [];
    const failed: string[] = [];
    const candidate = obligation('entry-chain', 3, 'entry-results');
    let inspections = 0;
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'entry-results',
          queueName: 'entry-sync',
          recoveryCompletionMode: 'entry-scan-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => [candidate],
        inspectJobs: async () => {
          inspections += 1;
          return {
            jobs: [
              {
                ...queueJob('entry-chain', 3, 'completed'),
                name: 'entry-results',
                returnValue: { scanComplete: inspections === 2 },
              },
            ],
            missingEvidenceVerified: true,
          };
        },
        confirm: async () => true,
        start: async () => false,
        renew: async () => false,
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

    expect(inspections).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.retried).toBe(0);
    expect(completed).toEqual(['entry-chain']);
    expect(failed).toEqual([]);
  });

  test('retries a drained chain whose root completed without finalizer evidence', async () => {
    const failed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'entry-results',
          queueName: 'entry-sync',
          recoveryCompletionMode: 'entry-scan-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => [obligation('lost-finalizer', 4, 'entry-results')],
        inspectJobs: async () => ({
          jobs: [
            {
              ...queueJob('lost-finalizer', 4, 'completed'),
              name: 'entry-results',
              returnValue: { scanComplete: false },
            },
          ],
          missingEvidenceVerified: true,
        }),
        confirm: async () => true,
        start: async () => false,
        renew: async () => false,
        complete: async () => false,
        fail: async (input) => {
          failed.push(input.obligationId);
          return true;
        },
      },
    });

    expect(result.succeeded).toBe(0);
    expect(result.retried).toBe(1);
    expect(failed).toEqual(['lost-finalizer']);
  });

  test('recognizes tournament and Understat semantic finalizers', async () => {
    const candidates = [
      obligation('tournament-chain', 5, 'tournament-event-results'),
      obligation('understat-chain', 6, 'understat-team-incremental'),
    ];
    const completed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [
        {
          name: 'tournament-event-results',
          queueName: 'tournament-sync',
          recoveryCompletionMode: 'tournament-cascade-finalizer',
        },
        {
          name: 'understat-team-incremental',
          queueName: 'understat-team-sync',
          recoveryCompletionMode: 'understat-finalizer',
        },
      ],
      dependencies: {
        listCandidates: async () => candidates,
        inspectJobs: async (queueName) => ({
          jobs:
            queueName === 'tournament-sync'
              ? [
                  {
                    ...queueJob('tournament-chain', 5, 'completed'),
                    name: 'tournament-event-results',
                    returnValue: { totalEntries: 100 },
                  },
                  {
                    ...queueJob('tournament-chain', 5, 'completed'),
                    id: 'tournament-finalizer',
                    name: 'tournament-materialized-views-refresh',
                  },
                ]
              : [
                  {
                    ...queueJob('understat-chain', 6, 'completed'),
                    name: 'understat-team-discover',
                  },
                  {
                    ...queueJob('understat-chain', 6, 'completed'),
                    id: 'understat-finalizer',
                    name: 'understat-team-finalize',
                  },
                ],
          missingEvidenceVerified: true,
        }),
        confirm: async () => true,
        start: async () => false,
        renew: async () => false,
        complete: async (input) => {
          completed.push(input.obligationId);
          return true;
        },
        fail: async () => false,
      },
    });

    expect(result.succeeded).toBe(2);
    expect(completed.sort()).toEqual(['tournament-chain', 'understat-chain']);
  });

  test('defers a missing job when the bounded Redis view was incomplete', async () => {
    let failCalls = 0;
    const renewed: string[] = [];
    const result = await reconcileExpiredSchedulerEnqueueClaims({
      definitions: [{ name: 'recoverable-job', queueName: 'recoverable-queue' }],
      dependencies: {
        listCandidates: async () => [obligation('outside-bounded-view', 7)],
        inspectJobs: async () => ({ jobs: [], missingEvidenceVerified: false }),
        confirm: async () => false,
        start: async () => false,
        renew: async (input) => {
          renewed.push(input.obligationId);
          return true;
        },
        complete: async () => false,
        fail: async () => {
          failCalls += 1;
          return true;
        },
      },
    });

    expect(result).toEqual({
      candidates: 1,
      running: 0,
      retained: 1,
      succeeded: 0,
      skipped: 0,
      retried: 0,
      unchanged: 0,
      errors: 1,
    });
    expect(failCalls).toBe(0);
    expect(renewed).toEqual(['outside-bounded-view']);
  });
});
