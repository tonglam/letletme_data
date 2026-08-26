import { Queue, type Job, type JobType } from 'bullmq';

import {
  completeSchedulerObligation,
  confirmSchedulerObligationEnqueued,
  failSchedulerObligation,
  listExpiredSchedulerObligations,
  renewSchedulerObligation,
  startSchedulerObligation,
  type SchedulerObligation,
} from '../repositories/scheduler-obligations';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import type { ScheduledJobDefinition } from './job-registry';
import { queueLaneForSchedulerJob } from '../domain/data-contracts';
import { getConfig } from '../utils/config';

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
const RECOVERY_FALLBACK_SCAN_LIMIT_PER_STATE = 200;
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
  returnValue?: unknown;
  failedReason?: string;
}>;

export type SchedulerQueueInspection = Readonly<{
  jobs: readonly SchedulerQueueJobSnapshot[];
  missingEvidenceVerified: boolean;
  /** Obligations whose exact candidate Bull ids were all absent in this observation. */
  directLookupMissingObligationIds?: readonly string[];
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
  skipped: number;
  retried: number;
  unchanged: number;
  errors: number;
}>;

type RecoveryDependencies = Readonly<{
  listCandidates: typeof listExpiredSchedulerObligations;
  inspectJobs: (
    queueName: string,
    candidates: readonly SchedulerObligation[],
  ) => Promise<SchedulerQueueInspection>;
  confirm: typeof confirmSchedulerObligationEnqueued;
  start: typeof startSchedulerObligation;
  renew: typeof renewSchedulerObligation;
  complete: typeof completeSchedulerObligation;
  fail: typeof failSchedulerObligation;
}>;

const defaultRecoveryDependencies: RecoveryDependencies = {
  listCandidates: listExpiredSchedulerObligations,
  inspectJobs: inspectSchedulerQueueJobs,
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

export function schedulerRecoveryBullJobIds(
  obligation: Pick<SchedulerObligation, 'obligationId' | 'generation' | 'bullJobId' | 'scopeKey'>,
): readonly string[] {
  if (obligation.bullJobId !== null) return [obligation.bullJobId];
  const baseId = `scheduler-${obligation.obligationId}-g${obligation.generation}`;
  const seasonCode = /^(\d{4})(?::|$)/.exec(obligation.scopeKey)?.[1];
  return seasonCode ? [baseId, `${seasonCode}-${baseId}`] : [baseId];
}

function jobDataMatchesSchedulerObligation(
  value: unknown,
  obligation: Pick<SchedulerObligation, 'obligationId' | 'generation'>,
): boolean {
  const data = recordData(value);
  return (
    data.obligationId === obligation.obligationId &&
    data.obligationGeneration === obligation.generation
  );
}

async function snapshotSchedulerQueueJobs(
  jobs: readonly Job<Record<string, unknown>>[],
): Promise<readonly SchedulerQueueJobSnapshot[]> {
  return Promise.all(
    jobs.map(async (job) => ({
      id: String(job.id),
      name: job.name,
      state: await job.getState(),
      data: recordData(job.data),
      ...(job.returnvalue === undefined ? {} : { returnValue: job.returnvalue }),
      ...(job.failedReason ? { failedReason: job.failedReason } : {}),
    })),
  );
}

async function inspectSchedulerQueueJobs(
  queueName: string,
  candidates: readonly SchedulerObligation[],
): Promise<SchedulerQueueInspection> {
  const queue = new Queue<Record<string, unknown>>(queueName, {
    connection: getQueueConnection(),
  });
  try {
    const lookupIds = [...new Set(candidates.flatMap(schedulerRecoveryBullJobIds))];
    const directLookups = await Promise.all(lookupIds.map((jobId) => queue.getJob(jobId)));
    const directJobs = directLookups.filter(
      (job): job is Job<Record<string, unknown>> => job !== undefined,
    );
    const foundDirectIds = new Set(directJobs.map((job) => String(job.id)));
    // A confirmed Bull id identifies only the scheduler root. Durable chains
    // carry the same generation into continuation/finalizer jobs, so always
    // take one bounded queue view as well as the direct root lookup.
    const [fallbackJobs, fallbackJobCount] = await Promise.all([
      queue.getJobs(RECOVERY_JOB_TYPES, 0, RECOVERY_FALLBACK_SCAN_LIMIT_PER_STATE - 1, false),
      queue.getJobCountByTypes(...RECOVERY_JOB_TYPES),
    ]);
    const uniqueJobs = new Map<string, Job<Record<string, unknown>>>();
    for (const job of [...directJobs, ...fallbackJobs]) {
      if (job.id !== undefined) uniqueJobs.set(String(job.id), job);
    }
    return {
      jobs: await snapshotSchedulerQueueJobs([...uniqueJobs.values()]),
      // BullMQ applies the range per state. Prove the whole multi-state queue
      // fits inside one page before treating a random-id job as absent.
      missingEvidenceVerified: schedulerRecoveryFallbackViewComplete(fallbackJobCount),
      directLookupMissingObligationIds: candidates
        .filter((candidate) =>
          schedulerRecoveryBullJobIds(candidate).every((jobId) => !foundDirectIds.has(jobId)),
        )
        .map((candidate) => candidate.obligationId),
    };
  } finally {
    await queue.close();
  }
}

export function schedulerRecoveryFallbackViewComplete(jobCount: number): boolean {
  return jobCount <= RECOVERY_FALLBACK_SCAN_LIMIT_PER_STATE;
}

export function matchesSchedulerObligationGeneration(
  job: SchedulerQueueJobSnapshot,
  obligation: Pick<SchedulerObligation, 'obligationId' | 'generation'>,
): boolean {
  return jobDataMatchesSchedulerObligation(job.data, obligation);
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

type RecoveryCompletionMode = NonNullable<ScheduledJobDefinition['recoveryCompletionMode']>;

function schedulerRecoveryCompletionJob(
  jobs: readonly SchedulerQueueJobSnapshot[],
  mode: RecoveryCompletionMode,
): SchedulerQueueJobSnapshot | null {
  const completed = jobs.filter((job) => job.state === 'completed');
  if (mode === 'root-job') return completed[0] ?? null;
  if (mode === 'entry-scan-finalizer') {
    return completed.find((job) => recordData(job.returnValue).scanComplete === true) ?? null;
  }
  if (mode === 'live-picks-finalizer') {
    return (
      completed.find(
        (job) =>
          recordData(job.returnValue).scanComplete === true ||
          (job.data.lane === 'live-picks' &&
            recordData(job.returnValue).hasMore === false &&
            recordData(job.returnValue).failedUnits === 0),
      ) ?? null
    );
  }
  if (mode === 'tournament-cascade-finalizer') {
    return (
      completed.find(
        (job) =>
          job.name === 'tournament-materialized-views-refresh' ||
          (job.name === 'tournament-event-results' &&
            recordData(job.returnValue).totalEntries === 0),
      ) ?? null
    );
  }
  return completed.find((job) => job.name.endsWith('-finalize')) ?? null;
}

function schedulerRecoveryTerminalOutcome(
  definition: Pick<ScheduledJobDefinition, 'name'>,
  completionJob: SchedulerQueueJobSnapshot,
): Readonly<{
  status: 'succeeded' | 'skipped';
  evidence: Readonly<Record<string, unknown>>;
}> {
  const skippedPriceChange =
    definition.name === 'price-change-predictions' &&
    recordData(completionJob.returnValue).outcome === 'noop';
  return {
    status: skippedPriceChange ? 'skipped' : 'succeeded',
    evidence: skippedPriceChange ? { reason: 'official_fields_not_open' } : {},
  };
}

function recoveryCompletionMode(
  definition: Pick<ScheduledJobDefinition, 'recoveryCompletionMode'>,
): RecoveryCompletionMode {
  return definition.recoveryCompletionMode ?? 'root-job';
}

function recoveryExpectedStatus(
  obligation: Pick<SchedulerObligation, 'status'>,
): 'enqueued' | 'running' | undefined {
  return obligation.status === 'enqueued' || obligation.status === 'running'
    ? obligation.status
    : undefined;
}

function groupRecoveryCandidates(
  candidates: readonly SchedulerObligation[],
  definitions: readonly Pick<
    ScheduledJobDefinition,
    'name' | 'queueName' | 'recoveryCompletionMode'
  >[],
): Readonly<{
  byQueue: ReadonlyMap<string, readonly SchedulerObligation[]>;
  unknown: readonly SchedulerObligation[];
}> {
  const queues = new Map<string, SchedulerObligation[]>();
  const unknown: SchedulerObligation[] = [];
  const lanesV2Enabled = getConfig().QUEUE_LANES_V2_ENABLED;
  const definitionQueues = new Map(
    definitions.map((definition) => [
      definition.name,
      lanesV2Enabled
        ? (queueLaneForSchedulerJob(definition.name) ?? definition.queueName)
        : definition.queueName,
    ]),
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
 * Reconcile expired in-flight obligations against their exact Bull generation.
 * An expired lease alone never authorizes a duplicate generation: Redis state
 * is checked first and every database mutation retains the generation fence.
 */
export async function reconcileExpiredSchedulerEnqueueClaims(input: {
  definitions: readonly Pick<
    ScheduledJobDefinition,
    'name' | 'queueName' | 'recoveryCompletionMode'
  >[];
  /** Latest-wins lanes are reconciled by their lane state machine instead. */
  excludedJobNames?: readonly string[];
  dependencies?: Partial<RecoveryDependencies>;
}): Promise<SchedulerEnqueueRecoveryResult> {
  const dependencies = { ...defaultRecoveryDependencies, ...input.dependencies };
  const candidates = await dependencies.listCandidates({
    excludedJobNames: input.excludedJobNames,
  });
  const grouped = groupRecoveryCandidates(candidates, input.definitions);
  const definitionsByName = new Map(
    input.definitions.map((definition) => [definition.name, definition]),
  );
  const counters = {
    candidates: candidates.length,
    running: 0,
    retained: 0,
    succeeded: 0,
    skipped: 0,
    retried: 0,
    unchanged: 0,
    errors: 0,
  };
  const deferUncertainCandidate = async (
    obligation: SchedulerObligation,
    queueName: string,
    reason: string,
  ): Promise<void> => {
    // Move an unresolved row behind the current expired window. Otherwise the
    // oldest limited result set can permanently starve later obligations.
    counters.errors += 1;
    try {
      const updated = await dependencies.renew({
        obligationId: obligation.obligationId,
        generation: obligation.generation,
      });
      if (updated) counters.retained += 1;
      else counters.unchanged += 1;
    } catch (error) {
      logError('Scheduler enqueue recovery could not defer an uncertain generation', error, {
        queueName,
        jobName: obligation.jobName,
        obligationId: obligation.obligationId,
        generation: obligation.generation,
        reason,
      });
    }
  };

  for (const obligation of grouped.unknown) {
    const updated = await dependencies.fail({
      obligationId: obligation.obligationId,
      generation: obligation.generation,
      expectedStatus: recoveryExpectedStatus(obligation),
      retryDelayMs: 0,
      error: new Error(`No concrete queue definition for ${obligation.jobName}`),
    });
    if (updated) counters.retried += 1;
    else counters.unchanged += 1;
  }

  for (const [queueName, queueCandidates] of grouped.byQueue) {
    let jobs: readonly SchedulerQueueJobSnapshot[];
    let missingEvidenceUnverified = false;
    let directLookupMissingObligationIds = new Set<string>();
    try {
      const inspection = await dependencies.inspectJobs(queueName, queueCandidates);
      jobs = inspection.jobs;
      missingEvidenceUnverified = !inspection.missingEvidenceVerified;
      directLookupMissingObligationIds = new Set(inspection.directLookupMissingObligationIds ?? []);
    } catch (error) {
      logError('Scheduler enqueue recovery could not inspect BullMQ', error, {
        queueName,
        obligationIds: queueCandidates.map((candidate) => candidate.obligationId),
      });
      for (const obligation of queueCandidates) {
        await deferUncertainCandidate(obligation, queueName, 'queue-inspection-failed');
      }
      continue;
    }

    // BullMQ can move a job between Redis state sets while they are read.
    // Require two observations before declaring an enqueue missing, and keep
    // both snapshots so a transition visible in either one wins.
    if (
      queueCandidates.some((candidate) => {
        const matchingJobs = jobs.filter((job) =>
          matchesSchedulerObligationGeneration(job, candidate),
        );
        if (matchingJobs.length === 0) return true;
        const definition = definitionsByName.get(candidate.jobName);
        if (!definition) return true;
        const mode = recoveryCompletionMode(definition);
        const decision = decideSchedulerEnqueueRecovery(matchingJobs);
        return (
          mode !== 'root-job' &&
          decision !== 'mark-running' &&
          decision !== 'retain-enqueued' &&
          schedulerRecoveryCompletionJob(matchingJobs, mode) === null
        );
      })
    ) {
      try {
        const secondInspection = await dependencies.inspectJobs(queueName, queueCandidates);
        const merged = new Map(
          [...jobs, ...secondInspection.jobs].map((job) => [job.id, job] as const),
        );
        jobs = [...merged.values()];
        missingEvidenceUnverified ||= !secondInspection.missingEvidenceVerified;
        const secondDirectMissing = new Set(
          secondInspection.directLookupMissingObligationIds ?? [],
        );
        directLookupMissingObligationIds = new Set(
          [...directLookupMissingObligationIds].filter((obligationId) =>
            secondDirectMissing.has(obligationId),
          ),
        );
      } catch (error) {
        missingEvidenceUnverified = true;
        directLookupMissingObligationIds.clear();
        logError('Scheduler enqueue recovery could not verify missing BullMQ jobs', error, {
          queueName,
        });
      }
    }

    for (const obligation of queueCandidates) {
      const definition = definitionsByName.get(obligation.jobName);
      if (!definition) {
        counters.errors += 1;
        continue;
      }
      const completionMode = recoveryCompletionMode(definition);
      const matchingJobs = jobs.filter((job) =>
        matchesSchedulerObligationGeneration(job, obligation),
      );
      // A durable chain cannot publish descendants while its obligation is
      // still enqueued: every root worker crosses the generation fence and
      // moves the row to running first. Two absent deterministic-root reads
      // therefore prove a never-started chain is safe to retry.
      const deterministicRootAbsenceVerified =
        directLookupMissingObligationIds.has(obligation.obligationId) &&
        (completionMode === 'root-job' || obligation.status === 'enqueued');
      if (
        matchingJobs.length === 0 &&
        missingEvidenceUnverified &&
        !deterministicRootAbsenceVerified
      ) {
        await deferUncertainCandidate(obligation, queueName, 'bounded-view-incomplete');
        continue;
      }
      const decision = decideSchedulerEnqueueRecovery(matchingJobs);
      const semanticCompletionJob = schedulerRecoveryCompletionJob(matchingJobs, completionMode);
      try {
        if (decision === 'mark-running' || decision === 'retain-enqueued') {
          const representative =
            matchingJobs.find((job) => job.state === 'active') ?? matchingJobs[0];
          if (!representative) {
            const updated = await dependencies.fail({
              obligationId: obligation.obligationId,
              generation: obligation.generation,
              expectedStatus: recoveryExpectedStatus(obligation),
              retryDelayMs: 0,
              error: new Error('Expired scheduler claim has no matching nonterminal Bull job'),
            });
            if (updated) counters.retried += 1;
            else counters.unchanged += 1;
            continue;
          }
          if (obligation.bullJobId === null) {
            if (!obligation.leaseOwner) {
              const updated = await dependencies.fail({
                obligationId: obligation.obligationId,
                generation: obligation.generation,
                expectedStatus: recoveryExpectedStatus(obligation),
                retryDelayMs: 0,
                error: new Error('Expired unconfirmed scheduler claim has no lease owner'),
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
          if (!semanticCompletionJob) {
            if (missingEvidenceUnverified) {
              await deferUncertainCandidate(
                obligation,
                queueName,
                'semantic-finalizer-not-visible',
              );
              continue;
            }
            const updated = await dependencies.fail({
              obligationId: obligation.obligationId,
              generation: obligation.generation,
              expectedStatus: recoveryExpectedStatus(obligation),
              retryDelayMs: 0,
              error: new Error(`Bull root completed without ${completionMode} completion evidence`),
            });
            if (updated) counters.retried += 1;
            else counters.unchanged += 1;
            continue;
          }
          const terminalOutcome = schedulerRecoveryTerminalOutcome(
            definition,
            semanticCompletionJob,
          );
          const updated = await dependencies.complete({
            obligationId: obligation.obligationId,
            generation: obligation.generation,
            status: terminalOutcome.status,
            evidence: {
              queue: queueName,
              reason: 'recovered-expired-bull-generation',
              completionMode,
              semanticBullJobId: semanticCompletionJob.id,
              semanticBullJobName: semanticCompletionJob.name,
              bullJobIds: matchingJobs.slice(0, 20).map((job) => job.id),
              ...terminalOutcome.evidence,
            },
          });
          if (updated && terminalOutcome.status === 'skipped') counters.skipped += 1;
          else if (updated) counters.succeeded += 1;
          else counters.unchanged += 1;
          continue;
        }

        const failedReasons = matchingJobs
          .map((job) => job.failedReason)
          .filter((reason): reason is string => Boolean(reason));
        if (
          decision === 'mark-failed' &&
          completionMode !== 'root-job' &&
          missingEvidenceUnverified
        ) {
          // A failed chain root can coexist with descendants that were
          // published before the handoff failed. Never open a new generation
          // until the bounded queue view proves no descendant is still live.
          await deferUncertainCandidate(obligation, queueName, 'chain-descendants-not-visible');
          continue;
        }
        const updated = await dependencies.fail({
          obligationId: obligation.obligationId,
          generation: obligation.generation,
          expectedStatus: recoveryExpectedStatus(obligation),
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
    logInfo('Scheduler expired Bull generations reconciled', counters);
  }
  return counters;
}
