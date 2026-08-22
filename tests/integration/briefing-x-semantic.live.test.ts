import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceObservations,
  contentSourcePartitions,
  contentSourceSchedules,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test.skipIf(process.env.RUN_LIVE_X !== '1')(
  'runs one real semantic search and keeps discovered authors observed-only',
  async () => {
    const bundle = await loadBriefingManifest();
    const budgetPolicy = compileXBudgetPolicy({
      coverage: bundle.coverage,
      globalRolling24hLimit: 2_400,
      final90Rolling90mLimit: 300,
    });
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'formal-x-semantic-live-test' });
    const db = await getDb();
    const [partition] = await db
      .select({ partitionId: contentSourcePartitions.partitionId })
      .from(contentSourcePartitions)
      .where(eq(contentSourcePartitions.partitionKey, 'semantic-availability'))
      .limit(1);
    if (!partition) throw new Error('Semantic availability partition is missing');
    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(ne(contentSourceSchedules.partitionId, partition.partitionId));
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
      .where(eq(contentSourceSchedules.partitionId, partition.partitionId));

    const [claimed] = await claimDueFormalRuns({
      enabledAdapters: ['X_SEMANTIC'],
      claimLimit: 1,
      xBudgetPolicy: budgetPolicy,
    });
    if (!claimed) throw new Error('Semantic availability run was not claimed');
    expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
    const result = await runFormalXWorker(claimed.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
      },
      xBudgetPolicy: budgetPolicy,
    });
    expect(['EMPTY', 'COMPLETED', 'PARTIAL', 'SATURATED']).toContain(result.status);

    const [terminal] = await db
      .select({
        status: contentAcquisitionRuns.status,
        runMetrics: contentAcquisitionRuns.runMetrics,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, claimed.runId));
    const traces = await db
      .select({ operation: contentAcquisitionProviderTraces.operation })
      .from(contentAcquisitionProviderTraces)
      .where(eq(contentAcquisitionProviderTraces.runId, claimed.runId));
    const acceptedObservations = await db
      .select({ receiptId: contentSourceObservations.receiptId })
      .from(contentSourceObservations)
      .where(eq(contentSourceObservations.runId, claimed.runId));
    const discovered = await db
      .select({ status: contentSources.status })
      .from(contentSources)
      .where(eq(contentSources.origin, 'DISCOVERED'));
    expect(terminal?.status).toBe(result.status);
    expect(
      (terminal?.runMetrics as { rawPostEvidenceAvailable?: boolean })?.rawPostEvidenceAvailable,
    ).toBe(false);
    expect(traces).toEqual([{ operation: 'x_semantic_search' }]);
    expect(acceptedObservations).toHaveLength(result.receiptCount + result.rejectedCount);
    expect(
      acceptedObservations.filter((observation) => observation.receiptId !== null),
    ).toHaveLength(result.receiptCount);
    expect(discovered.every((source) => source.status === 'observed')).toBe(true);
  },
  300_000,
);
