import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueXIdentityRuns,
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
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test('resolves a pending X endpoint through one runId-only x_user_search job', async () => {
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-identity-test' });
  const db = await getDb();
  const [endpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'official-fpl-x'))
    .limit(1);
  if (!endpoint) throw new Error('OfficialFPL endpoint is missing');
  await db
    .update(contentSourceEndpoints)
    .set({ status: 'paused' })
    .where(ne(contentSourceEndpoints.endpointId, endpoint.endpointId));

  const claimed = await claimDueXIdentityRuns({ claimLimit: 2, budgetPolicy });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.jobKind).toBe('X_IDENTITY');
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
    executor: {
      execute: async () => ({
        toolName: 'x_user_search',
        toolInput: { query: 'OfficialFPL', count: 3 },
        posts: [],
        users: [
          {
            userId: '761568335138058240',
            handle: 'OfficialFPL',
            displayName: 'Fantasy Premier League',
          },
        ],
        requestMetadataHash: 'a'.repeat(64),
        responseMetadataHash: 'b'.repeat(64),
        traceHash: 'c'.repeat(64),
        toolCallIdHash: 'd'.repeat(64),
        eventCount: 5,
        durationMs: 100,
        inputTokens: 100,
        outputTokens: 20,
        totalCostUsd: 0.01,
        rawPostEvidenceAvailable: false,
      }),
    },
  });
  expect(result).toMatchObject({ status: 'COMPLETED', receiptCount: 0, returnedCount: 1 });

  const [verified] = await db
    .select({
      stableExternalId: contentSourceEndpoints.stableExternalId,
      identityStatus: contentSourceEndpoints.identityStatus,
      identityNextCheckAt: contentSourceEndpoints.identityNextCheckAt,
      platform: contentSources.platform,
      externalId: contentSources.externalId,
      handle: contentSources.handle,
    })
    .from(contentSourceEndpoints)
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
    .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
  const [run] = await db
    .select({ status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, claimed[0]!.runId));
  const traces = await db
    .select({ operation: contentAcquisitionProviderTraces.operation })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, claimed[0]!.runId));
  expect(verified).toMatchObject({
    stableExternalId: '761568335138058240',
    identityStatus: 'VERIFIED',
    platform: 'X',
    externalId: '761568335138058240',
    handle: 'OfficialFPL',
  });
  expect(verified?.identityNextCheckAt?.getTime()).toBeGreaterThan(Date.now());
  expect(run?.status).toBe('COMPLETED');
  expect(traces).toEqual([{ operation: 'x_user_search' }]);
  expect(await claimDueXIdentityRuns({ claimLimit: 1, budgetPolicy })).toHaveLength(0);
});
