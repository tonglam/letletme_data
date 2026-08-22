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
  contentSourceEndpoints,
  contentSourcePartitions,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test.skipIf(process.env.RUN_LIVE_X !== '1')(
  'runs one real OfficialFPL Grok Build keyword scan through the formal Receipt pipeline',
  async () => {
    const bundle = await loadBriefingManifest();
    const budgetPolicy = compileXBudgetPolicy({
      coverage: bundle.coverage,
      globalRolling24hLimit: 2_400,
      final90Rolling90mLimit: 300,
    });
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'formal-x-live-test' });
    const db = await getDb();
    const [endpoint] = await db
      .select({ endpointId: contentSourceEndpoints.endpointId })
      .from(contentSourceEndpoints)
      .where(eq(contentSourceEndpoints.endpointKey, 'official-fpl-x'))
      .limit(1);
    const [partition] = await db
      .select({ partitionId: contentSourcePartitions.partitionId })
      .from(contentSourcePartitions)
      .where(eq(contentSourcePartitions.partitionKey, 'official-fpl'))
      .limit(1);
    if (!endpoint || !partition) throw new Error('OfficialFPL manifest rows are missing');

    await db
      .update(contentSourceEndpoints)
      .set({
        stableExternalId: '761568335138058240',
        identityStatus: 'VERIFIED',
        identityCheckedAt: new Date(),
        identityNextCheckAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
      })
      .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
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
      })
      .where(eq(contentSourceSchedules.partitionId, partition.partitionId));

    const claimed = await claimDueFormalRuns({
      enabledAdapters: ['X_ACCOUNT'],
      claimLimit: 1,
      xBudgetPolicy: budgetPolicy,
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.jobKind).toBe('X_KEYWORD_SCAN');
    expect(Object.keys(claimed[0]!.job).sort()).toEqual(['runId', 'schemaVersion']);
    expect(await confirmFormalRunEnqueued({ runId: claimed[0]!.runId })).toBe(true);

    const result = await runFormalXWorker(claimed[0]!.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
      },
      xBudgetPolicy: budgetPolicy,
    });
    expect(['EMPTY', 'COMPLETED', 'SATURATED']).toContain(result.status);

    const [terminal] = await db
      .select({
        status: contentAcquisitionRuns.status,
        runMetrics: contentAcquisitionRuns.runMetrics,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, claimed[0]!.runId));
    const traces = await db
      .select({ operation: contentAcquisitionProviderTraces.operation })
      .from(contentAcquisitionProviderTraces)
      .where(eq(contentAcquisitionProviderTraces.runId, claimed[0]!.runId));
    const receipts = await db
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(eq(contentSourceReceipts.primaryEndpointId, endpoint.endpointId));
    expect(terminal?.status).toBe(result.status);
    expect(
      (terminal?.runMetrics as { rawPostEvidenceAvailable?: boolean })?.rawPostEvidenceAvailable,
    ).toBe(false);
    expect(traces).toEqual([{ operation: 'x_keyword_search' }]);
    expect(receipts).toHaveLength(result.receiptCount);
  },
  300_000,
);
