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
} from '../services/scheduler-obligation-lifecycle.service';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';
import {
  claimGovernanceCaseRepair,
  getFreshnessWindow,
  listGovernanceCases,
  observeFreshnessConsumerEvidence,
  observeDueFreshnessWindows,
  retireEmptyMyFplOutboxFreshnessWindows,
  reopenExpiredGovernanceCaseRepair,
  updateGovernanceCaseStatus,
} from '../services/data-governance.service';
import { dataContractRegistry } from '../domain/data-contracts';
import { getConfig } from '../utils/config';
import {
  enqueueCoreSnapshotJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
} from '../jobs/data-sync-enqueue';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { enqueueLivePicksRefresh } from '../jobs/live-picks.jobs';
import {
  enqueueMyFplSnapshot,
  enqueueMyFplSnapshotOutbox,
  enqueuePlayerMarketFreshness,
} from '../jobs/maintenance.jobs';
import { enqueueEntryPicksSyncJob } from '../jobs/entry-sync-enqueue';
import {
  enqueueTournamentEventPicks,
  enqueueTournamentEventResults,
  enqueueTournamentOfficialH2H,
} from '../jobs/tournament-sync.jobs';
import { formatCronDateKey } from '../utils/timezone';
import { persistLiveLifecycleStatus } from '../services/live-lifecycle-orchestrator';
import { reconcileCoreAndMarketPublications } from '../services/data-publication-reconciler';
import { reconcileLiveMatchCheckpointObligationsV2 } from '../services/live-match-v2-reconciler.service';
import { triggerPriceChangeLane } from '../scheduler/scheduler.service';
import { seasonRepository } from '../repositories/seasons';
import { publicationOutboxQueueName } from '../queues/names';
import type { WorkerRuntime } from './worker-runtime';

type GovernanceFreshnessCase = Awaited<ReturnType<typeof listGovernanceCases>>[number];

/**
 * Dispatch the concrete producer/repair lane for a freshness breach. The
 * observer only changes the evidence ledger; it cannot repair a missing
 * publication. Every automatic target is deterministic per case attempt so
 * a retry after an enqueue timeout converges on one Bull identity.
 */
async function enqueueFreshnessCaseRepair(input: {
  governanceCase: GovernanceFreshnessCase;
  window: NonNullable<Awaited<ReturnType<typeof getFreshnessWindow>>>;
  season: { seasonId: number; seasonCode: string };
}): Promise<void> {
  const { governanceCase: item, window, season } = input;
  const jobId = `governance-case-${item.caseId}-attempt-${item.attempts}`;
  const eventId = window.eventId ?? undefined;

  switch (item.contractKey) {
    case 'core-fixtures':
      await enqueueCoreSnapshotJob(season, 'reconcile', {
        jobId,
        removeOnSettle: false,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'market-price':
      if (window.periodKey.startsWith('price-change-')) {
        await triggerPriceChangeLane({ freshnessWindowId: window.windowId });
        return;
      }
      if (window.periodKey.startsWith('maintenance-')) {
        await enqueuePlayerMarketFreshness(season, 'reconcile', {
          jobId,
          freshnessWindowId: window.windowId,
        });
        return;
      }
      if (!window.sourceDay) {
        throw new Error('SOURCE_ARCHIVE_MISSING: market freshness window has no source day');
      }
      const sourceDay = window.sourceDay.replaceAll('-', '');
      if (sourceDay !== formatCronDateKey()) {
        throw new Error(`SOURCE_ARCHIVE_MISSING: historical market day ${window.sourceDay}`);
      }
      await enqueuePlayerValuesSyncJob(season, 'reconcile', {
        changeDate: sourceDay,
        jobId,
        removeOnSettle: false,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'live-snapshot':
      if (!eventId) throw new Error('Live freshness repair has no event id');
      await enqueueLiveSnapshot(season, eventId, 'reconcile', {
        jobId,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'live-picks':
      if (!eventId) throw new Error('Live picks freshness repair has no event id');
      await enqueueLivePicksRefresh(season, eventId, {
        jobId,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'entry-data':
      if (!eventId) throw new Error('Entry freshness repair has no event id');
      await enqueueEntryPicksSyncJob(season, 'reconcile', {
        eventId,
        lane: 'entry-sync',
        jobId,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'league-tournament':
      if (!eventId) throw new Error('Tournament freshness repair has no event id');
      if (window.periodKey.includes('results')) {
        await enqueueTournamentEventResults(season, eventId, 'reconcile', {
          jobId,
          freshnessWindowId: window.windowId,
        });
      } else {
        await enqueueTournamentEventPicks(season, eventId, 'reconcile', {
          jobId,
          freshnessWindowId: window.windowId,
        });
      }
      return;
    case 'my-fpl':
      // Prefer the durable lane recorded on the governance case. The period
      // prefix was added after older windows were created, so the lane is the
      // only reliable discriminator for historical outbox cases.
      if (
        item.lane === publicationOutboxQueueName ||
        window.periodKey.includes('outbox') ||
        window.periodKey.startsWith('maintenance-')
      ) {
        await enqueueMyFplSnapshotOutbox(season, 'reconcile', {
          jobId,
          freshnessWindowId: window.windowId,
        });
        return;
      }
      if (!eventId) throw new Error('My FPL freshness repair has no event id');
      await enqueueMyFplSnapshot(season, 'reconcile', {
        eventId,
        snapshotKind: window.periodKey.startsWith('final-') ? 'FINAL' : 'PROVISIONAL',
        jobId,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'official-h2h':
      if (!eventId) throw new Error('Official H2H freshness repair has no event id');
      await enqueueTournamentOfficialH2H(season, eventId, 'reconcile', {
        jobId,
        officialH2HMode: 'full-reconcile',
        officialH2HReconcileKey: `governance-case-${item.caseId}`,
        freshnessWindowId: window.windowId,
      });
      return;
    case 'player-stats':
      await enqueuePlayerStatsSyncJob(season, 'reconcile', {
        ...(eventId === undefined ? {} : { eventId }),
        jobId,
        removeOnSettle: false,
        freshnessWindowId: window.windowId,
      });
      return;
    default:
      throw new Error(
        `AUTOMATIC_REPAIR_NOT_SAFE: unsupported freshness contract ${item.contractKey}`,
      );
  }
}

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
      case DATA_GOVERNANCE_JOBS.PUBLICATION_RECONCILE: {
        const season = {
          seasonId: job.data.seasonId,
          seasonCode: job.data.seasonCode,
        };
        const publications = await reconcileCoreAndMarketPublications(season);
        const liveMatches = await reconcileLiveMatchCheckpointObligationsV2(season);
        return { publications, liveMatches };
      }
      case DATA_GOVERNANCE_JOBS.FRESHNESS_OBSERVER: {
        const retiredNoopOutbox = await retireEmptyMyFplOutboxFreshnessWindows({ limit: 100 });
        const consumers = await observeFreshnessConsumerEvidence({ limit: 100 });
        const overdue = await observeDueFreshnessWindows({ limit: 100 });
        return { ...overdue, consumers, retiredNoopOutbox };
      }
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
        if (getConfig().FRESHNESS_SLO_MODE !== 'enforced') {
          // Shadow mode is deliberately observation-only. Do not claim cases
          // or enqueue any producer repair until enforcement is enabled.
          return { checked: 0, recovered: 0, dispatched: 0, requiresReview: 0, shadow: true };
        }
        // Claimable OPEN cases and in-flight settlement checks have different
        // ordering requirements.  Never let the newest 100 AUTO_REPAIRING
        // rows crowd older OPEN cases out of the repair cursor.
        const [claimableCases, settlingCases] = await Promise.all([
          listGovernanceCases({ status: 'OPEN', limit: 100, order: 'claimable-asc' }),
          listGovernanceCases({
            status: 'AUTO_REPAIRING',
            limit: 100,
            order: 'claimable-asc',
          }),
        ]);
        const openCases = [...claimableCases, ...settlingCases];
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

          // H2H locked-hash drift, archive replay and denominator ambiguity
          // stay behind the protected dry-run/execute case action. A normal
          // freshness breach is dispatched to the concrete producer lane;
          // merely running the observer would leave the source unchanged and
          // make the case churn forever.
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

          // A claimed repair owns a bounded settlement window. Rechecks run
          // every minute, so never dispatch another attempt while the prior
          // producer/outbox/cache chain can still be settling. Once the
          // deadline has elapsed, reopen with a CAS; the next pass may claim
          // the next attempt.
          if (governanceCase.status === 'AUTO_REPAIRING') {
            if (!governanceCase.repairDeadlineAt) {
              const changed = await updateGovernanceCaseStatus({
                caseId: governanceCase.caseId,
                expectedUpdatedAt: governanceCase.updatedAt,
                status: 'REQUIRES_REVIEW',
                lastError: 'AUTOMATIC_REPAIR_DEADLINE_MISSING',
              });
              if (changed) requiresReview += 1;
              continue;
            }
            if (governanceCase.repairDeadlineAt.getTime() > Date.now()) continue;
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
            await reopenExpiredGovernanceCaseRepair({
              caseId: governanceCase.caseId,
              expectedUpdatedAt: governanceCase.updatedAt,
            });
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
            repairJobId: `governance-case-${governanceCase.caseId}-attempt-${governanceCase.attempts + 1}`,
            settlementMs:
              dataContractRegistry.find(
                (contract) => contract.contractKey === governanceCase.contractKey,
              )?.executionBudgetMs ?? 15 * 60_000,
          });
          if (!claimed) continue;
          try {
            const window =
              governanceCase.sloWindowId === null
                ? null
                : await getFreshnessWindow(governanceCase.sloWindowId);
            if (!window) throw new Error('Freshness governance case has no linked SLO window');
            const linkedSeason =
              window.seasonId === null ? null : await seasonRepository.findById(window.seasonId);
            if (!linkedSeason) {
              throw new Error('FRESHNESS_SEASON_MISSING: linked SLO window season is unavailable');
            }
            await enqueueFreshnessCaseRepair({
              governanceCase: claimed,
              window,
              // A governance case may outlive a current-season rollover. The
              // linked window is the authority for repair scope; never use the
              // worker's current season as a substitute.
              season: linkedSeason,
            });
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
