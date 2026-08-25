import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

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

const liveTest = process.env.RUN_LIVE_X === '1' ? test : test.skip;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

liveTest(
  'scans one real two-reporter partition with one combined X tool call',
  async () => {
    const bundle = await loadBriefingManifest();
    const budgetPolicy = compileXBudgetPolicy({
      coverage: bundle.coverage,
      globalRolling24hLimit: 2_400,
      final90Rolling90mLimit: 300,
    });
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'dual-reporter-live-test' });
    const db = await getDb();
    const endpointKeys = ['john-townley-x', 'jacob-tanswell-x'] as const;
    const flags = {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    };

    const verified = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        stableExternalId: contentSourceEndpoints.stableExternalId,
        identityRequirement: contentSourceEndpoints.identityRequirement,
        identityStatus: contentSourceEndpoints.identityStatus,
      })
      .from(contentSourceEndpoints)
      .where(inArray(contentSourceEndpoints.endpointKey, endpointKeys));
    expect(verified).toHaveLength(2);
    expect(
      verified.every(
        (endpoint) =>
          endpoint.identityRequirement === 'HANDLE_ONLY' && endpoint.stableExternalId === null,
      ),
    ).toBe(true);

    const [partition] = await db
      .select({ partitionId: contentSourcePartitions.partitionId })
      .from(contentSourcePartitions)
      .where(eq(contentSourcePartitions.partitionKey, 'reporters-villa'))
      .limit(1);
    if (!partition) throw new Error('Villa reporter partition is missing');
    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(inArray(contentSourceSchedules.adapterKind, ['X_ACCOUNT', 'X_SEMANTIC'] as const));
    await db
      .update(contentSourceSchedules)
      .set({
        status: 'active',
        nextDueAt: new Date(Date.now() - 60_000),
        leaseOwner: null,
        leaseExpiresAt: null,
      })
      .where(eq(contentSourceSchedules.partitionId, partition.partitionId));

    const scans = await claimDueFormalRuns({
      enabledAdapters: ['X_ACCOUNT'],
      claimLimit: 1,
      xBudgetPolicy: budgetPolicy,
    });
    expect(scans).toHaveLength(1);
    expect(await confirmFormalRunEnqueued({ runId: scans[0]!.runId })).toBe(true);
    const scan = await runFormalXWorker(scans[0]!.job, { flags, xBudgetPolicy: budgetPolicy });
    expect(['EMPTY', 'COMPLETED', 'PARTIAL', 'SATURATED']).toContain(scan.status);

    const [persistedRun] = await db
      .select({ requestSnapshot: contentAcquisitionRuns.requestSnapshot })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, scans[0]!.runId));
    const request = persistedRun?.requestSnapshot as {
      partition?: { members?: Array<{ endpointKey?: string }> };
      toolRequest?: { toolName?: string; query?: string };
    };
    expect(request.partition?.members?.map((member) => member.endpointKey).sort()).toEqual([
      'jacob-tanswell-x',
      'john-townley-x',
    ]);
    expect(request.toolRequest).toMatchObject({ toolName: 'x_keyword_search' });
    expect(request.toolRequest?.query).toContain('from:johntownley11');
    expect(request.toolRequest?.query).toContain('from:J_Tanswell');

    const traces = await db
      .select({ operation: contentAcquisitionProviderTraces.operation })
      .from(contentAcquisitionProviderTraces)
      .where(eq(contentAcquisitionProviderTraces.runId, scans[0]!.runId));
    expect(traces).toEqual([{ operation: 'x_keyword_search' }]);
    const receipts = await db
      .select({ receiptId: contentSourceReceipts.receiptId })
      .from(contentSourceReceipts)
      .where(
        inArray(
          contentSourceReceipts.primaryEndpointId,
          verified.map((endpoint) => endpoint.endpointId),
        ),
      );
    expect(receipts).toHaveLength(scan.receiptCount);
  },
  360_000,
);
