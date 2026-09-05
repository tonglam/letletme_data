import { randomUUID } from 'node:crypto';
import { Worker, Job, QueueEvents } from 'bullmq';

import { requireCurrentSeasonForJob } from '../services/season-scoped-job.service';
import {
  LIVE_JOBS,
  type LiveDataJobData,
  liveDataQueue,
  liveDataQueueName,
} from '../queues/live-data.queue';
import { enqueueFinalLeagueResultsAfterLiveSync } from '../services/live-data-cascade.service';
import { enqueueTournamentOfficialH2H } from '../jobs/tournament-sync.jobs';
import { enqueueRemainingLiveMatchCheckpoint } from '../jobs/live-data.jobs';
import { syncLiveSnapshotV2 } from '../services/live-snapshot-v2.service';
import {
  LiveFinalRetentionIncompleteError,
  liveFinalRetentionCompletionEvidence,
  runLiveFinalRetentionV2,
} from '../services/live-final-retention.service';
import { syncLiveMatchObservationV3 } from '../services/live-match-observation-v3.service';
import {
  checkpointLiveMatchScopeV3,
  hasFinalLiveMatchCheckpointsV3,
} from '../services/live-match-v3-checkpoint.service';
import {
  syncLiveClassicLeaguePublicationsV2,
  syncLiveH2HLeaguePublicationsV2,
} from '../services/live-league-publication-v2.service';
import { logJobTriggered, runTrackedJob } from '../utils/job-run-logger';
import { getQueueConnection } from '../utils/queue';
import { logError, logInfo } from '../utils/logger';
import { alertOnFinalFailure } from '../utils/notify';
import { eventRepository } from '../repositories/events';
import {
  recordFreshnessObservation,
  recordPendingLiveSnapshotCheckpointEvidence,
} from '../services/data-governance.service';
import { readLivePublicationV2Checkpoint } from '../services/live-publication-v2-checkpoint.service';
import { isTerminalJobFailure } from '../utils/worker-failure';
import {
  completeSchedulerObligation,
  completeSchedulerObligationByBullJobId,
  deferSchedulerObligationForWorker,
  failSchedulerObligation,
  failSchedulerObligationByBullJobId,
} from '../services/scheduler-obligation-lifecycle.service';
import type { WorkerRuntime } from './worker-runtime';
import { BULL_COMPLETED_RETENTION, BULL_FAILED_RETENTION } from '../queues/retention';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../utils/scheduler-obligation-fence';

const LIVE_FINALIZATION_RETRY_DELAY_MS = 60_000;

async function enqueueFinalOfficialH2HRefresh(
  season: Awaited<ReturnType<typeof requireCurrentSeasonForJob>>,
  eventId: number,
  obligationGeneration: number | undefined,
  freshAfter: string | null,
): Promise<void> {
  try {
    await enqueueTournamentOfficialH2H(season, eventId, 'reconcile', {
      // A failed Bull job is retained for seven days.  Never reuse its ID on
      // a later finalization pass or BullMQ will deduplicate the retry into the
      // terminal failed job instead of dispatching a new refresh.
      jobId: `live-final-official-h2h-e${eventId}-g${obligationGeneration ?? 'unknown'}-${randomUUID()}`,
      ...(freshAfter ? { freshAfter } : {}),
    });
    logInfo('Enqueued official H2H refresh after live finalization', {
      season: season.seasonCode,
      eventId,
      freshAfter,
    });
  } catch (error) {
    // The durable live-finalization obligation remains pending and will retry
    // this enqueue. Never acknowledge finalization based on a failed handoff.
    logError('Failed to enqueue official H2H refresh after live finalization', error, {
      season: season.seasonCode,
      eventId,
      freshAfter,
    });
  }
}

/**
 * Live Data Worker
 *
 * Processes live data sync jobs:
 * - live-snapshot: coherent upstream fetch + atomic Redis publication (30-sec)
 * - asynchronous V2 PostgreSQL checkpointing and the final-results cascade
 */
async function processLiveDataJob(job: Job<LiveDataJobData>) {
  if (
    !(await startCurrentSchedulerJob(job.data, {
      queueName: job.queueName,
      jobName: job.name,
      jobId: job.id,
    }))
  ) {
    return { skipped: true, staleSchedulerGeneration: true };
  }
  const season = await requireCurrentSeasonForJob(job.data);
  const { eventId, source } = job.data;
  const context = {
    jobType: 'queue' as const,
    queueName: job.queueName,
    jobId: job.id,
    jobName: job.name,
    eventId,
    source,
    attempt: job.attemptsMade + 1,
  };

  logJobTriggered(context);

  return runTrackedJob(context, async () => {
    if (job.name === LIVE_JOBS.LIVE_FINAL_RETENTION) {
      const fence = inspectSchedulerObligationFence(job.data);
      if (fence.kind === 'malformed') {
        throw new Error(`Live final retention scheduler fence is malformed: ${fence.reason}`);
      }
      const result = await runLiveFinalRetentionV2(season, eventId, {
        authority:
          fence.kind === 'complete'
            ? {
                kind: 'scheduler',
                obligationId: fence.obligationId,
                generation: fence.generation,
              }
            : { kind: 'manual-current' },
      });
      if (result.status !== 'succeeded') {
        throw new LiveFinalRetentionIncompleteError(result);
      }
      return result;
    }
    if (job.name === LIVE_JOBS.LIVE_MATCH_CHECKPOINT) {
      if (!job.data.checkpointKind) {
        throw new Error('Live Match checkpoint job is missing checkpoint kind');
      }
      const result = await checkpointLiveMatchScopeV3({
        season,
        eventId,
        kind: job.data.checkpointKind,
      });
      // A failed or coalesced checkpoint leaves the Redis desired marker in
      // place for the periodic reconciler. Re-enqueue only after a successful
      // checkpoint, when a newer desired marker could have arrived during the
      // DB transaction. Calling this on every normal failure creates a zero-
      // delay successor loop that can starve live snapshot work for 24 hours.
      if (result.checkpointed) {
        await enqueueRemainingLiveMatchCheckpoint(season, eventId, job.data.checkpointKind);
      }
      return result;
    }
    if (job.name !== LIVE_JOBS.LIVE_SNAPSHOT) {
      throw new Error(`Unknown job name: ${job.name}`);
    }
    if (job.data.matchObservationOnly) {
      const result = await syncLiveMatchObservationV3(season, eventId, {
        lifecycleState: job.data.lifecycleState,
        expectedNextCheckAt: job.data.expectedNextCheckAt,
        // Preserve the broader scheduler decision explicitly: PICKS_PROBE is
        // normalized to the Match PRE_DEADLINE state for publication schema,
        // but it is post-deadline and may advance the eventless pointer.
        promoteActiveEvent: job.data.promoteActiveEvent === true,
      });
      if (result.checkpointObligationFailed) {
        throw new Error(`Live Match checkpoint obligation was not created for event ${eventId}`);
      }
      return result;
    }
    const snapshot = await syncLiveSnapshotV2(season, eventId, {
      finalizeEvent: job.data.finalizeEvent === true,
      lifecycleState: job.data.lifecycleState,
      expectedNextCheckAt: job.data.expectedNextCheckAt,
      trigger: source,
      sourceRunId: job.data.runId,
    });
    if (snapshot.checkpointObligationFailed) {
      throw new Error(`Live Match checkpoint obligation was not created for event ${eventId}`);
    }
    // League boards are a sibling publication. A missing roster input or a
    // transient Redis/DB read must retain the last complete board and must not
    // turn a successful global live observation into a failed live job.
    let classicLeagueResult: Awaited<ReturnType<typeof syncLiveClassicLeaguePublicationsV2>> = null;
    try {
      classicLeagueResult = await syncLiveClassicLeaguePublicationsV2(
        season,
        eventId,
        job.data.expectedNextCheckAt,
      );
    } catch (error) {
      logError(
        'Live Classic league publication pass failed; global publication is retained',
        error,
        {
          season: season.seasonCode,
          eventId,
        },
      );
    }
    let h2hLeagueResult: Awaited<ReturnType<typeof syncLiveH2HLeaguePublicationsV2>> = null;
    try {
      h2hLeagueResult = await syncLiveH2HLeaguePublicationsV2(
        season,
        eventId,
        job.data.expectedNextCheckAt,
      );
    } catch (error) {
      logError('Live H2H league publication pass failed; global publication is retained', error, {
        season: season.seasonCode,
        eventId,
      });
    }
    if (
      job.data.freshnessWindowId !== undefined &&
      snapshot.publicationId !== null &&
      snapshot.generation !== null
    ) {
      const sourceCheckedAt = snapshot.sourceCheckedAt ? new Date(snapshot.sourceCheckedAt) : null;
      // A coalesced Redis publication can legitimately return
      // `checkpointed: false` even when the durable checkpoint already holds
      // the exact publication identity. Always read the checkpoint here; the
      // freshness window is scoped to the returned publication, not to the
      // boolean that says whether this invocation performed the checkpoint.
      const durableCheckpoint = await readLivePublicationV2Checkpoint(season, eventId).catch(
        (error) => {
          logError('Live snapshot durable checkpoint read failed for freshness evidence', error, {
            eventId,
            windowId: job.data.freshnessWindowId,
          });
          return null;
        },
      );
      const checkpoint = durableCheckpoint;
      const checkpointedAt = checkpoint?.publication.checkpointedAt;
      const pgPublishedAt = checkpointedAt ? new Date(checkpointedAt) : null;
      const checkpointMatchesSnapshot =
        checkpoint?.publication.publicationId === snapshot.publicationId &&
        checkpoint.publication.generation === snapshot.generation;
      const validSourceCheckedAt =
        sourceCheckedAt !== null && Number.isFinite(sourceCheckedAt.getTime());
      const validPgPublishedAt = pgPublishedAt !== null && Number.isFinite(pgPublishedAt.getTime());
      const revision = `${snapshot.publicationId}:${snapshot.generation}`;
      const redisSeenAt = new Date();
      if (validSourceCheckedAt) {
        try {
          await recordFreshnessObservation({
            windowId: job.data.freshnessWindowId,
            sourceCheckedAt,
            ...(checkpointMatchesSnapshot && validPgPublishedAt ? { pgPublishedAt } : {}),
            redisSeenAt,
            producerRevision: revision,
            redisRevision: revision,
            completenessStatus: 'COMPLETE',
            evidence: { liveCheckpointPending: !(checkpointMatchesSnapshot && validPgPublishedAt) },
          });
        } catch (error) {
          // Freshness telemetry is additive. The Redis publication and the
          // scheduler completion remain authoritative when the governance DB
          // is temporarily unavailable.
          logError('Live snapshot freshness evidence update failed', error, {
            eventId,
            windowId: job.data.freshnessWindowId,
            publicationId: snapshot.publicationId,
          });
        }
      }
      if (checkpointMatchesSnapshot && validSourceCheckedAt && validPgPublishedAt) {
        try {
          await recordPendingLiveSnapshotCheckpointEvidence({
            seasonId: season.seasonId,
            eventId,
            sourceCheckedAt,
            pgPublishedAt,
            redisSeenAt,
            revision,
          });
        } catch (error) {
          logError('Live snapshot pending freshness checkpoint reconciliation failed', error, {
            eventId,
            windowId: job.data.freshnessWindowId,
            publicationId: snapshot.publicationId,
          });
        }
      } else if (checkpoint && !checkpointMatchesSnapshot) {
        logError(
          'Live snapshot freshness evidence checkpoint identity changed before observation',
          new Error('live publication checkpoint identity mismatch'),
          {
            eventId,
            windowId: job.data.freshnessWindowId,
            snapshotPublicationId: snapshot.publicationId,
            snapshotGeneration: snapshot.generation,
            checkpointPublicationId: checkpoint.publication.publicationId,
            checkpointGeneration: checkpoint.publication.generation,
          },
        );
      }
    }
    const classicGlobalIdentityMatches =
      classicLeagueResult?.globalPublicationId === snapshot.publicationId &&
      classicLeagueResult?.globalGeneration === snapshot.generation;
    const h2hGlobalIdentityMatches =
      h2hLeagueResult?.globalPublicationId === snapshot.publicationId &&
      h2hLeagueResult?.globalGeneration === snapshot.generation;
    const leagueFinalReady =
      snapshot.state === 'FINALIZED' &&
      classicGlobalIdentityMatches &&
      h2hGlobalIdentityMatches &&
      classicLeagueResult?.finalReady === true &&
      h2hLeagueResult?.finalReady === true;

    if (
      snapshot.state === 'FINALIZED' &&
      (!h2hGlobalIdentityMatches || !h2hLeagueResult?.finalReady)
    ) {
      const finalizationFreshAfter = await eventRepository.findDataCheckedAtExact(season, eventId);
      await enqueueFinalOfficialH2HRefresh(
        season,
        eventId,
        job.data.obligationGeneration,
        finalizationFreshAfter,
      );
    }

    if (snapshot.state === 'FINALIZED') {
      if (!snapshot.checkpointed) {
        throw new Error(
          `Finalized live publication is not durably checkpointed for event ${eventId}`,
        );
      }
      if (!leagueFinalReady) {
        logInfo('Finalized live publication is waiting for league finalization evidence', {
          season: season.seasonCode,
          eventId,
          globalIdentityMatches: classicGlobalIdentityMatches && h2hGlobalIdentityMatches,
          classicFinalReady: classicLeagueResult?.finalReady ?? false,
          h2hFinalReady: h2hLeagueResult?.finalReady ?? false,
        });
        if (job.data.obligationId !== undefined && job.data.obligationGeneration !== undefined) {
          const deferred = await deferSchedulerObligationForWorker({
            obligationId: job.data.obligationId,
            generation: job.data.obligationGeneration,
            delayMs: LIVE_FINALIZATION_RETRY_DELAY_MS,
            evidence: {
              finalization: 'waiting-for-league-evidence',
              classicFinalReady: classicLeagueResult?.finalReady ?? false,
              h2hFinalReady: h2hLeagueResult?.finalReady ?? false,
            },
          });
          if (!deferred) {
            throw new Error(
              `Live finalization obligation could not be deferred for event ${eventId}`,
            );
          }
        }
        return snapshot;
      }
      // Final Match obligations are queued for normal recovery, but the final
      // snapshot must not race those jobs on this same two-slot worker before
      // it starts the downstream final-results cascade. Consume both exact
      // desired markers inline once; any duplicate queue jobs then observe an
      // already-cleared marker and become harmless no-ops.
      for (const kind of ['desk', 'detail'] as const) {
        await checkpointLiveMatchScopeV3({ season, eventId, kind });
      }
      if (!(await hasFinalLiveMatchCheckpointsV3(season, eventId))) {
        throw new Error(
          `Finalized Live Matches desk/detail are not durably checkpointed for event ${eventId}`,
        );
      }
      await enqueueFinalLeagueResultsAfterLiveSync(season, eventId);
    }
    return snapshot;
  });
}

export function createLiveDataWorker(): WorkerRuntime {
  const connection = getQueueConnection();
  const worker = new Worker<LiveDataJobData>(liveDataQueueName, processLiveDataJob, {
    connection,
    // Publication persistence owns the small DB pool; FPL request admission
    // separately caps the host at five and reserves live slots.
    concurrency: 2,
    removeOnComplete: BULL_COMPLETED_RETENTION,
    removeOnFail: BULL_FAILED_RETENTION,
    lockDuration: 120_000,
    maxStalledCount: 2,
    stalledInterval: 15_000,
  });
  const queueEvents = new QueueEvents(liveDataQueueName, { connection });

  worker.on('completed', (job) => {
    logInfo('Live data worker completed job', {
      jobId: job.id,
      jobName: job.name,
      eventId: job.data.eventId,
    });
    if (job.id !== undefined) {
      const fence = inspectSchedulerObligationFence(job.data);
      const evidence = {
        queue: liveDataQueueName,
        jobName: job.name,
        eventId: job.data.eventId,
        ...(job.name === LIVE_JOBS.LIVE_FINAL_RETENTION && job.returnvalue
          ? {
              retentionPolicyVersion: job.returnvalue.policyVersion,
              retention: liveFinalRetentionCompletionEvidence(job.returnvalue),
            }
          : {}),
        ...(job.data.freshnessWindowId === undefined
          ? {}
          : { freshnessWindowId: job.data.freshnessWindowId }),
      };
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
      if (completion) void completion.catch(() => undefined);
    }
  });
  worker.on('failed', (job, err) => {
    logError('Live data worker failed job', err, {
      jobId: job?.id,
      jobName: job?.name,
      eventId: job?.data.eventId,
    });
    if (job) {
      void alertOnFinalFailure(job, err);
      const fence = inspectSchedulerObligationFence(job.data);
      const failureEvidence =
        err instanceof LiveFinalRetentionIncompleteError
          ? {
              retentionPolicyVersion: err.evidence.policyVersion,
              retention: err.evidence,
            }
          : undefined;
      if (isTerminalJobFailure(job, err) && fence.kind === 'complete') {
        void failSchedulerObligation({
          obligationId: fence.obligationId,
          generation: fence.generation,
          error: err,
          ...(failureEvidence ? { evidence: failureEvidence } : {}),
        }).catch(() => undefined);
      } else if (job.id !== undefined && isTerminalJobFailure(job, err) && fence.kind === 'none') {
        void failSchedulerObligationByBullJobId({
          bullJobId: job.id,
          error: err,
          ...(failureEvidence ? { evidence: failureEvidence } : {}),
        }).catch(() => undefined);
      }
    }
  });
  worker.on('error', (err) => logError('Live data worker error', err));

  return {
    workers: [worker],
    queueEvents: [queueEvents],
    monitorTargets: [{ queue: liveDataQueue, queueEvents, queueName: liveDataQueueName }],
  };
}
