import { getContentRuntimeFlags, type ContentRuntimeFlags } from '../config';
import {
  claimDueXIdentityRuns,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
  failFormalRun,
  type ClaimedFormalRun,
  type RecurringAdapterKind,
} from './formal-run-repository';
import type { XBudgetPolicy } from './x-budget';
import { failXIdentityRun } from './x-identity-repository';
import { logError } from '../../utils/logger';

export type FormalRunEnqueuer = (run: ClaimedFormalRun) => Promise<unknown>;

export type FormalSchedulerResult = Readonly<{
  claimed: number;
  enqueued: number;
  enqueueFailed: number;
  skippedCoverageGate: boolean;
}>;

function xAdapters(flags: ContentRuntimeFlags): readonly RecurringAdapterKind[] {
  return flags.xScanEnabled && flags.realGrokEnabled ? ['X_ACCOUNT', 'X_SEMANTIC'] : [];
}

function httpAdapters(flags: ContentRuntimeFlags): readonly RecurringAdapterKind[] {
  if (!flags.httpAcquisitionEnabled) return [];
  return flags.youtubeDiscoveryEnabled
    ? ['RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL']
    : ['RSS_ATOM', 'PODCAST_FEED'];
}

export async function scheduleFormalAcquisition(input: {
  fullRolloutEligible: boolean;
  flags?: ContentRuntimeFlags;
  xBudgetPolicy?: XBudgetPolicy;
  enqueueX: FormalRunEnqueuer;
  enqueueHttp: FormalRunEnqueuer;
}): Promise<FormalSchedulerResult> {
  const flags = input.flags ?? getContentRuntimeFlags();
  if (!flags.pipelineEnabled) {
    return { claimed: 0, enqueued: 0, enqueueFailed: 0, skippedCoverageGate: false };
  }
  if (!input.fullRolloutEligible && !flags.acquisitionShadowMode) {
    return { claimed: 0, enqueued: 0, enqueueFailed: 0, skippedCoverageGate: true };
  }

  const xCapacity = flags.grokConcurrency * 2;
  if (flags.xScanEnabled && flags.realGrokEnabled && !input.xBudgetPolicy) {
    throw new Error('Formal X scheduling requires an explicit budget policy');
  }
  const [identityRuns, httpRuns] = await Promise.all([
    flags.xScanEnabled && flags.realGrokEnabled
      ? claimDueXIdentityRuns({
          claimLimit: xCapacity,
          budgetPolicy: input.xBudgetPolicy!,
        })
      : Promise.resolve([]),
    claimDueFormalRuns({
      enabledAdapters: httpAdapters(flags),
      claimLimit: flags.httpConcurrency * 2,
    }),
  ]);
  // Claim repositories enforce one shared DB admission limit across pending
  // and running X work. Asking both X claimers for the full capacity avoids
  // double-counting identity runs and wasting available slots.
  const xRuns = await claimDueFormalRuns({
    enabledAdapters: xAdapters(flags),
    claimLimit: xCapacity,
    xBudgetPolicy: input.xBudgetPolicy,
  });
  const runs = [...identityRuns, ...xRuns, ...httpRuns];
  let enqueued = 0;
  let enqueueFailed = 0;
  await Promise.all(
    runs.map(async (run) => {
      try {
        if (run.queueKind === 'X') await input.enqueueX(run);
        else await input.enqueueHttp(run);
        enqueued += 1;
      } catch (error) {
        enqueueFailed += 1;
        const errorSummary = error instanceof Error ? error.message : 'Formal queue enqueue failed';
        if (run.jobKind === 'X_IDENTITY') {
          await failXIdentityRun({
            runId: run.runId,
            failureClass: 'ENQUEUE_FAILED',
            errorSummary,
          });
        } else {
          await failFormalRun({
            runId: run.runId,
            failureClass: 'ENQUEUE_FAILED',
            errorSummary,
            retryDelayMs: 60_000,
          });
        }
        return;
      }

      // Queue insertion is the durable hand-off. Confirmation is an audit
      // marker only; a transient DB failure must not terminalize or release a
      // run that may already be RUNNING in the queue worker.
      try {
        await confirmFormalRunEnqueued({ runId: run.runId });
      } catch (error) {
        logError('Formal queue enqueue confirmation failed; run remains claimable', error, {
          runId: run.runId,
          queueKind: run.queueKind,
        });
      }
    }),
  );
  return {
    claimed: runs.length,
    enqueued,
    enqueueFailed,
    skippedCoverageGate: false,
  };
}
