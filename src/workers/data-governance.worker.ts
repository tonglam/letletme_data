import { QueueEvents, Worker, type Job } from 'bullmq';

import {
  DATA_GOVERNANCE_JOBS,
  dataGovernanceQueue,
  dataGovernanceQueueName,
  type DataGovernanceJobData,
} from '../queues/data-governance.queue';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../repositories/scheduler-obligations';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import {
  claimGovernanceCaseRepair,
  getFreshnessWindow,
  listGovernanceCases,
  observeDueFreshnessWindows,
  updateGovernanceCaseStatus,
} from '../services/data-governance.service';
import { enqueueDataGovernanceJob } from '../jobs/data-governance.jobs';
import { persistLiveLifecycleStatus } from '../services/live-lifecycle-orchestrator';
import { reconcileCoreAndMarketPublications } from '../services/data-publication-reconciler';
import type { WorkerRuntime } from './worker-runtime';

async function processDataGovernanceJob(job: Job<DataGovernanceJobData>): Promise<unknown> {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }

  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    source: 'governance',
    attempt: job.attemptsMade + 1,
  };
  logJobTriggered(context);
  return runTrackedJob(context, async () => {
    switch (job.name) {
      case DATA_GOVERNANCE_JOBS.LIFECYCLE_STATUS: {
        const tick = await persistLiveLifecycleStatus(new Date());
        return {
          state: tick?.decision.state ?? null,
          eventId: tick?.currentEvent.id ?? null,
        };
      }
      case DATA_GOVERNANCE_JOBS.PUBLICATION_RECONCILE:
        return reconcileCoreAndMarketPublications({
          seasonId: job.data.seasonId,
          seasonCode: job.data.seasonCode,
        });
      case DATA_GOVERNANCE_JOBS.FRESHNESS_OBSERVER:
        return observeDueFreshnessWindows({ limit: 100 });
      case DATA_GOVERNANCE_JOBS.GW_AUDIT: {
        // Auditing is an evidence checkpoint. It must not mark data complete
        // on its own; the freshness observer and downstream probes settle the
        // corresponding window or open a governance case.
        const openCases = await listGovernanceCases({
          status: ['OPEN', 'AUTO_REPAIRING', 'REQUIRES_REVIEW'],
          limit: 100,
        });
        return { auditedAt: new Date().toISOString(), openCases: openCases.length };
      }
      case DATA_GOVERNANCE_JOBS.CASE_RECHECK: {
        const openCases = await listGovernanceCases({
          status: ['OPEN', 'AUTO_REPAIRING'],
          limit: 100,
        });
        let recovered = 0;
        let dispatched = 0;
        let requiresReview = 0;
        for (const governanceCase of openCases) {
          // A freshness case is recovered only after the linked window has a
          // recorded consumer-visible recovery. A successful enqueue alone is
          // not evidence of repair.
          if (governanceCase.sloWindowId !== null) {
            const window = await getFreshnessWindow(governanceCase.sloWindowId);
            if (window?.recoveredAt) {
              const changed = await updateGovernanceCaseStatus({
                caseId: governanceCase.caseId,
                expectedUpdatedAt: governanceCase.updatedAt,
                status: 'RECOVERED',
                recoveryRevision: window.recoveryRevision,
              });
              if (changed) recovered += 1;
              continue;
            }
          }

          // Only freshness observer replay is safe to automate here. H2H
          // locked-hash drift, archive replay and denominator ambiguity stay
          // behind the protected dry-run/execute case action.
          if (governanceCase.caseKind !== 'freshness-breach') {
            if (governanceCase.status === 'AUTO_REPAIRING') {
              const changed = await updateGovernanceCaseStatus({
                caseId: governanceCase.caseId,
                expectedUpdatedAt: governanceCase.updatedAt,
                status: 'REQUIRES_REVIEW',
                lastError: 'AUTOMATIC_REPAIR_NOT_SAFE',
              });
              if (changed) requiresReview += 1;
            }
            continue;
          }

          if (governanceCase.attempts >= 2) {
            const changed = await updateGovernanceCaseStatus({
              caseId: governanceCase.caseId,
              expectedUpdatedAt: governanceCase.updatedAt,
              status: 'REQUIRES_REVIEW',
              lastError: 'AUTOMATIC_REPAIR_ATTEMPTS_EXHAUSTED',
            });
            if (changed) requiresReview += 1;
            continue;
          }

          const claimed = await claimGovernanceCaseRepair({
            caseId: governanceCase.caseId,
            expectedUpdatedAt: governanceCase.updatedAt,
          });
          if (!claimed) continue;
          try {
            await enqueueDataGovernanceJob(
              { seasonId: job.data.seasonId, seasonCode: job.data.seasonCode },
              DATA_GOVERNANCE_JOBS.FRESHNESS_OBSERVER,
              {
                scopeKey: governanceCase.scopeKey,
                jobId: `governance-freshness-repair-${governanceCase.caseId}-${claimed.attempts}`,
              },
            );
            dispatched += 1;
          } catch (repairError) {
            const changed = await updateGovernanceCaseStatus({
              caseId: governanceCase.caseId,
              expectedUpdatedAt: claimed.updatedAt,
              status: 'REQUIRES_REVIEW',
              lastError: 'AUTOMATIC_REPAIR_ENQUEUE_FAILED',
            });
            if (changed) requiresReview += 1;
            logError('Freshness governance repair enqueue failed', repairError, {
              caseId: governanceCase.caseId,
            });
          }
        }
        return { checked: openCases.length, recovered, dispatched, requiresReview };
      }
      default:
        throw new Error(`Unknown data governance job: ${job.name}`);
    }
  });
}

export function createDataGovernanceWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<DataGovernanceJobData>(
    dataGovernanceQueueName,
    processDataGovernanceJob,
    {
      connection,
      concurrency: 2,
      lockDuration: 120_000,
      maxStalledCount: 2,
      stalledInterval: 15_000,
    },
  );
  const queueEvents = new QueueEvents(dataGovernanceQueueName, { connection });
  worker.on('completed', (job) => {
    logInfo('Data governance job completed', { jobId: job.id, name: job.name });
    if (job.id === undefined) return;
    const fence = inspectSchedulerObligationFence(job.data);
    const evidence = { queue: dataGovernanceQueueName, jobName: job.name };
    const completion =
      fence.kind === 'complete'
        ? completeSchedulerObligation({
            obligationId: fence.obligationId,
            generation: fence.generation,
            status: 'succeeded',
            evidence,
          })
        : fence.kind === 'none'
          ? completeSchedulerObligationByBullJobId({ bullJobId: job.id, evidence })
          : null;
    if (completion)
      void completion.catch((error) => logError('Governance obligation completion failed', error));
  });
  worker.on('failed', (job, error) => {
    logError('Data governance job failed', error, { jobId: job?.id, name: job?.name });
    if (!job) return;
    const fence = inspectSchedulerObligationFence(job.data);
    const terminal = job.attemptsMade >= (job.opts.attempts ?? 1);
    if (!terminal) return;
    const failure =
      fence.kind === 'complete'
        ? failSchedulerObligation({
            obligationId: fence.obligationId,
            generation: fence.generation,
            error,
          })
        : fence.kind === 'none' && job.id !== undefined
          ? failSchedulerObligationByBullJobId({ bullJobId: job.id, error })
          : null;
    if (failure)
      void failure.catch((failureError) =>
        logError('Governance obligation failure persistence failed', failureError),
      );
  });
  worker.on('error', (error) => logError('Data governance worker error', error));
  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [
      { queue: dataGovernanceQueue, queueEvents, queueName: dataGovernanceQueueName },
    ],
  };
}
