import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { HostGrokRunnerClient } from '../../src/content/acquisition/host-grok-runner-client';
import { dispatchAcquisitionJobOutbox } from '../../src/content/acquisition/job-outbox';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionGaps,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceObservations,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

const liveTest = process.env.RUN_BRIEFING_FULL_X_SWEEP === '1' ? test : test.skip;
const CONCURRENCY = 2;

type RunMetrics = Readonly<{
  durationMs?: number;
  totalCostUsd?: number | null;
  returned?: number;
  accepted?: number;
  rejected?: number;
}>;

function countBy(values: readonly string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function percentile(values: readonly number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index] ?? null;
}

afterAll(async () => {
  await databaseSingleton.disconnect();
});

liveTest(
  'runs every recurring X partition plus each bounded saturation follow-up once',
  async () => {
    const bundle = await loadBriefingManifest();
    const budgetPolicy = compileXBudgetPolicy({
      coverage: bundle.coverage,
      globalRolling24hLimit: 2_400,
      final90Rolling90mLimit: 300,
      identityRolling24hLimit: 100,
    });
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'full-x-sweep-live-rollout' });
    const db = await getDb();
    const identities = await db
      .select({
        endpointKey: contentSourceEndpoints.endpointKey,
        stableExternalId: contentSourceEndpoints.stableExternalId,
        identityStatus: contentSourceEndpoints.identityStatus,
      })
      .from(contentSourceEndpoints)
      .where(eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'));
    expect(identities).toHaveLength(bundle.coverage.endpointCounts.X_ACCOUNT);
    expect(
      identities.every(
        (endpoint) =>
          endpoint.identityStatus === 'VERIFIED' && /^\d+$/.test(endpoint.stableExternalId ?? ''),
      ),
    ).toBe(true);

    const recurringSchedules = await db
      .select({ scheduleId: contentSourceSchedules.scheduleId })
      .from(contentSourceSchedules)
      .where(inArray(contentSourceSchedules.adapterKind, ['X_ACCOUNT', 'X_SEMANTIC'] as const));
    expect(recurringSchedules).toHaveLength(bundle.plan.partitions.length);
    const targetScheduleIds = new Set(recurringSchedules.map((schedule) => schedule.scheduleId));

    await db
      .update(contentSourceSchedules)
      .set({
        status: 'active',
        nextDueAt: new Date(Date.now() - 60_000),
        leaseOwner: null,
        leaseExpiresAt: null,
        failureStreak: 0,
        circuitState: 'CLOSED',
        probeAfter: null,
      })
      .where(inArray(contentSourceSchedules.adapterKind, ['X_ACCOUNT', 'X_SEMANTIC'] as const));

    const flags = {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    };
    const executor = new HostGrokRunnerClient({
      socketPath: flags.grokRunnerSocket,
      expectedVersion: flags.grokExpectedVersion,
      expectedRunnerReleaseSha: flags.grokRunnerReleaseSha,
      timeoutMs: flags.grokTimeoutMs,
      maximumResponseBytes: flags.grokMaxOutputBytes,
    });
    const mainRunIds: string[] = [];
    const processedScheduleIds = new Set<string>();
    const followUpRunIds: string[] = [];
    const workerResults: Awaited<ReturnType<typeof runFormalXWorker>>[] = [];
    const processErrors: Array<{ runId: string; error: string }> = [];

    while (processedScheduleIds.size < targetScheduleIds.size) {
      const claimed = await claimDueFormalRuns({
        enabledAdapters: ['X_ACCOUNT', 'X_SEMANTIC'],
        claimLimit: Math.min(CONCURRENCY, targetScheduleIds.size - processedScheduleIds.size),
        xBudgetPolicy: budgetPolicy,
      });
      if (claimed.length === 0) break;
      for (const run of claimed) {
        if (!run.scheduleId || !targetScheduleIds.has(run.scheduleId)) {
          throw new Error(`Claimed unexpected recurring X schedule ${run.scheduleId ?? 'null'}`);
        }
        if (processedScheduleIds.has(run.scheduleId)) {
          throw new Error(`Claimed recurring X schedule twice: ${run.scheduleId}`);
        }
        processedScheduleIds.add(run.scheduleId);
      }
      await Promise.all(claimed.map((run) => confirmFormalRunEnqueued({ runId: run.runId })));
      mainRunIds.push(...claimed.map((run) => run.runId));
      const settled = await Promise.allSettled(
        claimed.map((run) =>
          runFormalXWorker(run.job, {
            flags,
            executor,
            xBudgetPolicy: budgetPolicy,
          }),
        ),
      );
      settled.forEach((result, index) => {
        if (result.status === 'fulfilled') workerResults.push(result.value);
        else {
          processErrors.push({
            runId: claimed[index]!.runId,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      });
      await db
        .update(contentSourceSchedules)
        .set({ status: 'paused', leaseOwner: null, leaseExpiresAt: null })
        .where(
          inArray(
            contentSourceSchedules.scheduleId,
            claimed.map((run) => run.scheduleId!),
          ),
        );
      console.warn(
        `[briefing-x-sweep] main ${processedScheduleIds.size}/${targetScheduleIds.size}; process errors ${processErrors.length}`,
      );
    }

    while (true) {
      const followUps: Array<{ job: { schemaVersion: 1; runId: string }; runId: string }> = [];
      const dispatched = await dispatchAcquisitionJobOutbox({
        enabledQueueNames: ['content-x-scan'],
        limit: 100,
        enqueue: async (job) => {
          followUps.push({ job: job.job, runId: job.runId });
        },
      });
      expect(dispatched.failed).toBe(0);
      if (followUps.length === 0) break;
      for (let index = 0; index < followUps.length; index += CONCURRENCY) {
        const batch = followUps.slice(index, index + CONCURRENCY);
        followUpRunIds.push(...batch.map((run) => run.runId));
        const settled = await Promise.allSettled(
          batch.map((run) =>
            runFormalXWorker(run.job, {
              flags,
              executor,
              xBudgetPolicy: budgetPolicy,
            }),
          ),
        );
        settled.forEach((result, resultIndex) => {
          if (result.status === 'fulfilled') workerResults.push(result.value);
          else {
            processErrors.push({
              runId: batch[resultIndex]!.runId,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
          }
        });
      }
      console.warn(
        `[briefing-x-sweep] follow-ups ${followUpRunIds.length}; process errors ${processErrors.length}`,
      );
    }

    const runIds = [...mainRunIds, ...followUpRunIds];
    const runs = await db
      .select({
        runId: contentAcquisitionRuns.runId,
        adapterKind: contentAcquisitionRuns.adapterKind,
        partitionKey: contentAcquisitionRuns.partitionKey,
        status: contentAcquisitionRuns.status,
        failureClass: contentAcquisitionRuns.failureClass,
        runMetrics: contentAcquisitionRuns.runMetrics,
      })
      .from(contentAcquisitionRuns)
      .where(inArray(contentAcquisitionRuns.runId, runIds));
    const traces = await db
      .select({ runId: contentAcquisitionProviderTraces.runId })
      .from(contentAcquisitionProviderTraces)
      .where(inArray(contentAcquisitionProviderTraces.runId, runIds));
    const receipts = await db
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(inArray(contentSourceReceipts.runId, runIds));
    const revisions = await db
      .select({ revisionId: contentSourceReceiptRevisions.receiptRevisionId })
      .from(contentSourceReceiptRevisions)
      .where(inArray(contentSourceReceiptRevisions.runId, runIds));
    const observations = await db
      .select({ outcome: contentSourceObservations.outcome })
      .from(contentSourceObservations)
      .where(inArray(contentSourceObservations.runId, runIds));
    const outbox = await db
      .select({ outboxId: contentPipelineOutbox.outboxId })
      .from(contentPipelineOutbox)
      .where(inArray(contentPipelineOutbox.runId, runIds));
    const gaps = await db
      .select({ reason: contentAcquisitionGaps.reason })
      .from(contentAcquisitionGaps)
      .where(inArray(contentAcquisitionGaps.declaringRunId, runIds));
    const durations = runs
      .map((run) => (run.runMetrics as RunMetrics).durationMs)
      .filter((duration): duration is number => typeof duration === 'number');
    const knownCosts = runs
      .map((run) => (run.runMetrics as RunMetrics).totalCostUsd)
      .filter((cost): cost is number => typeof cost === 'number');
    console.warn(
      JSON.stringify({
        recurringPartitions: bundle.plan.partitions.length,
        mainRuns: mainRunIds.length,
        followUpRuns: followUpRunIds.length,
        statuses: countBy(runs.map((run) => run.status)),
        adapterStatuses: Object.fromEntries(
          ['X_ACCOUNT', 'X_SEMANTIC'].map((adapterKind) => [
            adapterKind,
            countBy(runs.filter((run) => run.adapterKind === adapterKind).map((run) => run.status)),
          ]),
        ),
        returned: runs.reduce(
          (total, run) => total + ((run.runMetrics as RunMetrics).returned ?? 0),
          0,
        ),
        observations: countBy(observations.map((observation) => observation.outcome)),
        receipts: receipts.length,
        revisions: revisions.length,
        receiptOutbox: outbox.length,
        gaps: countBy(gaps.map((gap) => gap.reason)),
        traceCount: traces.length,
        processErrors,
        failedRuns: runs
          .filter((run) => run.status === 'FAILED')
          .map((run) => ({
            partitionKey: run.partitionKey,
            failureClass: run.failureClass,
          })),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        knownCostRunCount: knownCosts.length,
        totalKnownCostUsd: Number(knownCosts.reduce((sum, cost) => sum + cost, 0).toFixed(8)),
      }),
    );

    expect(processedScheduleIds.size).toBe(targetScheduleIds.size);
    expect(mainRunIds).toHaveLength(targetScheduleIds.size);
    expect(processErrors).toEqual([]);
    expect(runs).toHaveLength(runIds.length);
    expect(traces).toHaveLength(runIds.length);
    expect(runs.filter((run) => run.status === 'FAILED')).toEqual([]);
    expect(workerResults).toHaveLength(runIds.length);
  },
  30 * 60_000,
);
