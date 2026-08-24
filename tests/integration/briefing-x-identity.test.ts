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
import { planTriggeredContentWork } from '../../src/content/acquisition/triggered-work-planner';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

test('resolves a pending X endpoint through one runId-only x_user_search job', async () => {
  await resetBriefingAcquisitionState();
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
        outputContractRevision: 3,
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
    .select({
      status: contentAcquisitionRuns.status,
      xCallCount: contentAcquisitionRuns.xCallCount,
      traceVerified: contentAcquisitionRuns.traceVerified,
    })
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
  expect(run).toMatchObject({ status: 'COMPLETED', xCallCount: 1, traceVerified: true });
  expect(traces).toEqual([{ operation: 'x_user_search' }]);
  expect(await claimDueXIdentityRuns({ claimLimit: 1, budgetPolicy })).toHaveLength(0);
});

test('conservatively commits budget when the Grok identity process starts but trace parsing fails', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-identity-attempt-test' });
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

  const [claimed] = await claimDueXIdentityRuns({ claimLimit: 1, budgetPolicy });
  if (!claimed) throw new Error('X identity run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
  await expect(
    runFormalXWorker(claimed.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
      },
      executor: {
        execute: async (_request, hooks) => {
          hooks?.onProviderProcessStart?.();
          throw new Error('Synthetic malformed trace after provider process launch');
        },
      },
    }),
  ).rejects.toThrow('Synthetic malformed trace');

  const [run] = await db
    .select({
      status: contentAcquisitionRuns.status,
      provider: contentAcquisitionRuns.provider,
      providerUnits: contentAcquisitionRuns.providerUnits,
      xCallCount: contentAcquisitionRuns.xCallCount,
      traceVerified: contentAcquisitionRuns.traceVerified,
      runMetrics: contentAcquisitionRuns.runMetrics,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, claimed.runId));
  expect(run).toMatchObject({
    status: 'FAILED',
    provider: 'grok-build',
    providerUnits: '1.000000',
    xCallCount: 1,
    traceVerified: false,
    runMetrics: { providerProcessStarted: true, providerTraceVerified: false },
  });
  const reservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, claimed.runId));
  expect(reservations.length).toBeGreaterThan(0);
  expect(reservations.every((reservation) => reservation.status === 'COMMITTED')).toBe(true);
  const traces = await db
    .select({ traceId: contentAcquisitionProviderTraces.traceId })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, claimed.runId));
  expect(traces).toEqual([]);
});

test('identity scheduler owns stale lease recovery and creates a fresh bounded attempt', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-identity-recovery-test' });
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

  const [stale] = await claimDueXIdentityRuns({ claimLimit: 1, budgetPolicy });
  if (!stale) throw new Error('Initial X identity run was not claimed');
  await db
    .update(contentAcquisitionRuns)
    .set({ leaseExpiresAt: new Date(Date.now() - 60_000) })
    .where(eq(contentAcquisitionRuns.runId, stale.runId));

  const genericRecovery = await planTriggeredContentWork({
    flags: { ...getContentRuntimeFlags(), pipelineEnabled: true },
    limit: 1,
  });
  expect(genericRecovery.reclaimed).toBe(0);
  const [stillPending] = await db
    .select({ status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, stale.runId));
  expect(stillPending?.status).toBe('PENDING');

  const [replacement] = await claimDueXIdentityRuns({ claimLimit: 1, budgetPolicy });
  if (!replacement) throw new Error('Replacement X identity run was not claimed');
  expect(replacement.runId).not.toBe(stale.runId);
  const recoveredRuns = await db
    .select({
      runId: contentAcquisitionRuns.runId,
      status: contentAcquisitionRuns.status,
      failureClass: contentAcquisitionRuns.failureClass,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.endpointId, endpoint.endpointId));
  expect(recoveredRuns).toEqual(
    expect.arrayContaining([
      { runId: stale.runId, status: 'FAILED', failureClass: 'LEASE_EXPIRED' },
      { runId: replacement.runId, status: 'PENDING', failureClass: null },
    ]),
  );
  const oldReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, stale.runId));
  const newReservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, replacement.runId));
  expect(oldReservations.length).toBeGreaterThan(0);
  expect(newReservations.length).toBeGreaterThan(0);
  expect(oldReservations.every((reservation) => reservation.status === 'RELEASED')).toBe(true);
  expect(newReservations.every((reservation) => reservation.status === 'RESERVED')).toBe(true);
});
