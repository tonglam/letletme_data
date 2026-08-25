import { Queue, type JobType } from 'bullmq';

import {
  completeSchedulerObligation,
  confirmSchedulerObligationEnqueued,
  failSchedulerObligation,
  listExpiredUnconfirmedSchedulerObligations,
  renewSchedulerObligation,
  startSchedulerObligation,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import type { ScheduledJobDefinition } from './job-registry';

const RECOVERY_JOB_TYPES: JobType[] = [
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
  'active',
  'paused',
  'completed',
  'failed',
];
const NONTERMINAL_JOB_STATES = new Set([
  'waiting',
  'waiting-children',
  'delayed',
  'prioritized',
  'paused',
]);

export type SchedulerQueueJobSnapshot = Readonly<{
  id: string;
  name: string;
  state: string;
  data: Readonly<Record<string, unknown>>;
  failedReason?: string;
}>;

export type SchedulerEnqueueRecoveryDecision =
  | 'mark-running'
  | 'retain-enqueued'
  | 'mark-succeeded'
  | 'mark-failed'
  | 'retry-missing';

export type SchedulerEnqueueRecoveryResult = Readonly<{
  candidates: number;
  running: number;
  retained: number;
  succeeded: number;
  retried: number;
  unchanged: number;
  errors: number;
}>;

type RecoveryDependencies = Readonly<{
  listCandidates: typeof listExpiredUnconfirmedSchedulerObligations;
  loadJobs: (queueName: string) => Promise<readonly SchedulerQueueJobSnapshot[]>;
  confirm: typeof confirmSchedulerObligationEnqueued;
  start: typeof startSchedulerObligation;
  renew: typeof renewSchedulerObligation;
  complete: typeof completeSchedulerObligation;
  fail: typeof failSchedulerObligation;
}>;

const defaultRecoveryDependencies: RecoveryDependencies = {
  listCandidates: listExpiredUnconfirmedSchedulerObligations,
  loadJobs: loadSchedulerQueueJobs,
  confirm: confirmSchedulerObligationEnqueued,
  start: startSchedulerObligation,
  renew: renewSchedulerObligation,
  complete: completeSchedulerObligation,
  fail: failSchedulerObligation,
};

function recordData(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

async function loadSchedulerQueueJobs(
  queueName: string,
): Promise<readonly SchedulerQueueJobSnapshot[]> {
  const queue = new Queue<Record<string, unknown>>(queueName, {
    connection: getQueueConnection(),
  });
  try {
    const jobs = await queue.getJobs(RECOVERY_JOB_TYPES, 0, -1, false);
    return Promise.all(
      jobs.map(async (job) => ({
        id: String(job.id),
        name: job.name,
        state: await job.getState(),
        data: recordData(job.data),
        ...(job.failedReason ? { failedReason: job.failedReason } : {}),
      })),
    );
  } finally {
    await queue.close();
  }
}

export function matchesSchedulerObligationGeneration(
  job: SchedulerQueueJobSnapshot,
  obligation: Pick<SchedulerObligation, 'obligationId' | 'generation'>,
): boolean {
  return (
    job.data.obligationId === obligation.obligationId &&
    job.data.obligationGeneration === obligation.generation
  );
}

export function decideSchedulerEnqueueRecovery(
  jobs: readonly SchedulerQueueJobSnapshot[],
): SchedulerEnqueueRecoveryDecision {
  if (jobs.some((job) => job.state === 'active')) return 'mark-running';
  if (jobs.some((job) => NONTERMINAL_JOB_STATES.has(job.state))) return 'retain-enqueued';
  if (jobs.some((job) => job.state === 'failed')) return 'mark-failed';
  if (jobs.some((job) => job.state === 'completed')) return 'mark-succeeded';
  return 'retry-missing';
}

function groupRecoveryCandidates(
  candidates: readonly SchedulerObligation[],
  definitions: readonly Pick<ScheduledJobDefinition, 'name' | 'queueName'>[],
): Readonly<{
  byQueue: ReadonlyMap<string, readonly SchedulerObligation[]>;
  unknown: readonly SchedulerObligation[];
}> {
  const queues = new Map<string, SchedulerObligation[]>();
  const unknown: SchedulerObligation[] = [];
  const definitionQueues = new Map(
    definitions.map((definition) => [definition.name, definition.queueName]),
  );
  for (const obligation of candidates) {
    const queueName = definitionQueues.get(obligation.jobName);
    if (!queueName || queueName.includes('*')) {
      unknown.push(obligation);
      continue;
    }
    const queueCandidates = queues.get(queueName) ?? [];
    queueCandidates.push(obligation);
    queues.set(queueName, queueCandidates);
  }
  return { byQueue: queues, unknown };
}

/**
 * Recover only the narrow DB-claim/Bull-enqueue crash window. An expired
 * lease alone never authorizes a duplicate generation: Redis state is checked
 * first and every database mutation retains the exact generation fence.
 */
export async function reconcileExpiredSchedulerEnqueueClaims(input: {
  definitions: readonly Pick<ScheduledJobDefinition, 'name' | 'queueName'>[];
  dependencies?: Partial<RecoveryDependencies>;
}): Promise<SchedulerEnqueueRecoveryResult> {
  const dependencies = { ...defaultRecoveryDependencies, ...input.dependencies };
  const candidates = await dependencies.listCandidates();
  const grouped = groupRecoveryCandidates(candidates, input.definitions);
  const counters = {
    candidates: candidates.length,
    running: 0,
    retained: 0,
    succeeded: 0,
    retried: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const obligation of grouped.unknown) {
    const updated = await dependencies.fail({
      obligationId: obligation.obligationId,
      generation: obligation.generation,
      retryDelayMs: 0,
      error: new Error(`No concrete queue definition for ${obligation.jobName}`),
    });
    if (updated) counters.retried += 1;
    else counters.unchanged += 1;
  }

  for (const [queueName, queueCandidates] of grouped.byQueue) {
    let jobs: readonly SchedulerQueueJobSnapshot[];
    let missingEvidenceUnverified = false;
    try {
      jobs = await dependencies.loadJobs(queueName);
    } catch (error) {
      counters.errors += queueCandidates.length;
      logError('Scheduler enqueue recovery could not inspect BullMQ', error, {
        queueName,
        obligationIds: queueCandidates.map((candidate) => candidate.obligationId),
      });
      continue;
    }

    // BullMQ can move a job between Redis state sets while they are read.
    // Require two observations before declaring an enqueue missing, and keep
    // both snapshots so a transition visible in either one wins.
    if (
      queueCandidates.some(
        (candidate) => !jobs.some((job) => matchesSchedulerObligationGeneration(job, candidate)),
      )
    ) {
      try {
        const secondJobs = await dependencies.loadJobs(queueName);
        const merged = new Map([...jobs, ...secondJobs].map((job) => [job.id, job] as const));
        jobs = [...merged.values()];
      } catch (error) {
        missingEvidenceUnverified = true;
        logError('Scheduler enqueue recovery could not verify missing BullMQ jobs', error, {
          queueName,
        });
      }
    }

    for (const obligation of queueCandidates) {
      const matchingJobs = jobs.filter((job) =>
        matchesSchedulerObligationGeneration(job, obligation),
      );
      if (matchingJobs.length === 0 && missingEvidenceUnverified) {
        counters.errors += 1;
        continue;
      }
      const decision = decideSchedulerEnqueueRecovery(matchingJobs);
      try {
        if (decision === 'mark-running' || decision === 'retain-enqueued') {
          const representative =
            matchingJobs.find((job) => job.state === 'active') ?? matchingJobs[0];
          if (!representative || !obligation.leaseOwner) {
            const updated = await dependencies.fail({
              obligationId: obligation.obligationId,
              generation: obligation.generation,
              retryDelayMs: 0,
              error: new Error('Expired scheduler claim has no recoverable lease owner'),
            });
            if (updated) counters.retried += 1;
            else counters.unchanged += 1;
            continue;
          }
          const confirmed = await dependencies.confirm({
            obligationId: obligation.obligationId,
            owner: obligation.leaseOwner,
            bullJobId: representative.id,
          });
          if (!confirmed) {
            counters.unchanged += 1;
            continue;
          }
          const updated =
            decision === 'mark-running'
              ? await dependencies.start({
                  obligationId: obligation.obligationId,
                  generation: obligation.generation,
                })
              : await dependencies.renew({
                  obligationId: obligation.obligationId,
                  generation: obligation.generation,
                });
          if (updated && decision === 'mark-running') counters.running += 1;
          else if (updated) counters.retained += 1;
          else counters.unchanged += 1;
          continue;
        }

        if (decision === 'mark-succeeded') {
          const updated = await dependencies.complete({
            obligationId: obligation.obligationId,
            generation: obligation.generation,
            status: 'succeeded',
            evidence: {
              queue: queueName,
              reason: 'recovered-unconfirmed-enqueue',
              bullJobIds: matchingJobs.slice(0, 20).map((job) => job.id),
            },
          });
          if (updated) counters.succeeded += 1;
          else counters.unchanged += 1;
          continue;
        }

        const failedReasons = matchingJobs
          .map((job) => job.failedReason)
          .filter((reason): reason is string => Boolean(reason));
        const updated = await dependencies.fail({
          obligationId: obligation.obligationId,
          generation: obligation.generation,
          retryDelayMs: 0,
          error: new Error(
            decision === 'mark-failed'
              ? `Recovered failed BullMQ job: ${failedReasons[0] ?? 'unknown failure'}`
              : 'Claim expired before BullMQ enqueue confirmation and no matching job exists',
          ),
        });
        if (updated) counters.retried += 1;
        else counters.unchanged += 1;
      } catch (error) {
        counters.errors += 1;
        logError('Scheduler enqueue recovery failed', error, {
          queueName,
          jobName: obligation.jobName,
          obligationId: obligation.obligationId,
          generation: obligation.generation,
          decision,
        });
      }
    }
  }

  if (counters.candidates > 0) {
    logInfo('Scheduler expired enqueue claims reconciled', counters);
  }
  return counters;
}
