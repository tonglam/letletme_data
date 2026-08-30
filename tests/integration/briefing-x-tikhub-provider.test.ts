import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { and, eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import {
  TikHubXTimelineError,
  type TikHubXTimelineExecutionResult,
} from '../../src/content/acquisition/tikhub-x-timeline-client';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentAcquisitionBudgetReservations,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceMediaGates,
  contentSourceObservations,
  contentSourcePartitions,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

function snowflakeAt(timestamp: Date): string {
  return ((BigInt(timestamp.getTime()) - X_SNOWFLAKE_EPOCH_MS) << 22n).toString();
}

async function claimOfficialTikHubRun(budgetPolicy: ReturnType<typeof compileXBudgetPolicy>) {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'tikhub-provider-test' });
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
    .where(
      and(
        eq(contentSourceSchedules.partitionId, partition.partitionId),
        eq(contentSourceSchedules.scheduleRole, 'PRIMARY'),
      ),
    );

  const [claimed] = await claimDueFormalRuns({
    enabledAdapters: ['X_ACCOUNT'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
    xAccountProvider: 'TIKHUB',
  });
  if (!claimed) throw new Error('OfficialFPL TikHub run was not claimed');
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
  return { claimed, db };
}

function testBudgetPolicy(coverage: Awaited<ReturnType<typeof loadBriefingManifest>>['coverage']) {
  return compileXBudgetPolicy({
    coverage,
    globalRolling24hLimit: 10_000,
    final90Rolling90mLimit: 1_000,
    laneCapMultiplier: 10,
    enforceLaneCaps: false,
  });
}

test('persists a TikHub timeline run with exact call accounting and no Grok follow-up', async () => {
  const bundle = await loadBriefingManifest();
  const budgetPolicy = testBudgetPolicy(bundle.coverage);
  const { claimed, db } = await claimOfficialTikHubRun(budgetPolicy);

  const result = await runFormalXWorker(claimed.job, {
    flags: {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
      xAccountProvider: 'TIKHUB',
      tikhubApiKeyPresent: true,
    },
    tikhubExecutor: {
      execute: async (request, hooks): Promise<TikHubXTimelineExecutionResult> => {
        await hooks?.beforeProviderCall?.(0);
        await hooks?.onProviderCallStart?.(0);
        await hooks?.beforeProviderCall?.(1);
        await hooks?.onProviderCallStart?.(1);
        const createdAt = new Date(
          (Date.parse(request.windowStart) + Date.parse(request.windowEnd)) / 2,
        );
        const postId = snowflakeAt(createdAt);
        return {
          provider: 'tikhub',
          operation: 'fetch_user_post_tweet',
          posts: [
            {
              postId,
              authorHandle: 'OfficialFPL',
              createdAt: createdAt.toISOString(),
              text: 'Deterministic TikHub integration post',
              url: `https://x.com/OfficialFPL/status/${postId}`,
            },
          ],
          providerUnits: 2,
          requestMetadataHash: 'a'.repeat(64),
          responseMetadataHash: 'b'.repeat(64),
          providerJobIdHash: 'c'.repeat(64),
          durationMs: 200,
          responseBytes: 4_096,
          rawReturnedCount: 3,
          excludedRetweets: 1,
          excludedOutsideWindow: 1,
          duplicatePosts: 0,
          saturated: false,
          memberMetrics: [
            {
              endpointKey: 'official-fpl-x',
              pages: 2,
              rawPosts: 3,
              acceptedPosts: 1,
              excludedRetweets: 1,
              excludedOutsideWindow: 1,
              duplicatePosts: 0,
              boundaryComplete: true,
              pageCapReached: false,
            },
          ],
          estimatedCostUsd: 0.002,
          pricingRevision: '2026-08-30-fetch-user-post-tweet',
        };
      },
    },
    xBudgetPolicy: budgetPolicy,
    db,
  });
  expect(result.status).toBe('COMPLETED');
  expect(result.receiptCount).toBe(1);
  expect(result.revisionCount).toBe(1);

  const [run] = await db
    .select({
      provider: contentAcquisitionRuns.provider,
      providerUnits: contentAcquisitionRuns.providerUnits,
      xCallCount: contentAcquisitionRuns.xCallCount,
      traceVerified: contentAcquisitionRuns.traceVerified,
      evidenceMode: contentAcquisitionRuns.evidenceMode,
      checkpointAdvanced: contentAcquisitionRuns.checkpointAdvanced,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, claimed.runId));
  expect(run).toMatchObject({
    provider: 'tikhub',
    providerUnits: '2.000000',
    xCallCount: 2,
    traceVerified: true,
    evidenceMode: 'PROVIDER_ATTESTED',
    checkpointAdvanced: true,
  });
  const traces = await db
    .select({
      provider: contentAcquisitionProviderTraces.provider,
      providerUnits: contentAcquisitionProviderTraces.providerUnits,
      terminalState: contentAcquisitionProviderTraces.terminalState,
    })
    .from(contentAcquisitionProviderTraces)
    .where(eq(contentAcquisitionProviderTraces.runId, claimed.runId));
  expect(traces).toEqual([
    {
      provider: 'tikhub',
      providerUnits: '2.000000',
      terminalState: 'HTTP_VALIDATED',
    },
  ]);
  const reservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, claimed.runId));
  expect(reservations.length).toBeGreaterThanOrEqual(1);
  expect(reservations.every((row) => row.status === 'COMMITTED')).toBe(true);
  expect(
    await db
      .select()
      .from(contentSourceObservations)
      .where(eq(contentSourceObservations.runId, claimed.runId)),
  ).toHaveLength(1);
  expect(await db.select().from(contentSourceReceipts)).toHaveLength(1);
  expect(await db.select().from(contentSourceReceiptRevisions)).toHaveLength(1);
  expect(await db.select().from(contentSourceMediaGates)).toHaveLength(1);
  expect(await db.select().from(contentPipelineOutbox)).toHaveLength(1);
  expect(
    await db
      .select()
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.parentRunId, claimed.runId)),
  ).toHaveLength(0);
});

test('records billable TikHub page failures without creating fake empty data', async () => {
  const bundle = await loadBriefingManifest();
  const budgetPolicy = testBudgetPolicy(bundle.coverage);
  const { claimed, db } = await claimOfficialTikHubRun(budgetPolicy);

  try {
    await runFormalXWorker(claimed.job, {
      flags: {
        ...getContentRuntimeFlags(),
        pipelineEnabled: true,
        acquisitionShadowMode: true,
        xScanEnabled: true,
        realGrokEnabled: true,
        xAccountProvider: 'TIKHUB',
        tikhubApiKeyPresent: true,
      },
      tikhubExecutor: {
        execute: async (_request, hooks) => {
          await hooks?.beforeProviderCall?.(0);
          await hooks?.onProviderCallStart?.(0);
          await hooks?.beforeProviderCall?.(1);
          await hooks?.onProviderCallStart?.(1);
          throw new TikHubXTimelineError(
            'TIKHUB_SCHEMA_INVALID',
            'Fixture response failed schema validation',
            {
              provider: 'tikhub',
              operation: 'fetch_user_post_tweet',
              requestMetadataHash: 'd'.repeat(64),
              responseMetadataHash: 'e'.repeat(64),
              providerJobIdHash: 'f'.repeat(64),
              providerUnits: 2,
              durationMs: 300,
              responseBytes: 8_192,
              httpStatus: 200,
              estimatedCostUsd: 0.002,
              pricingRevision: '2026-08-30-fetch-user-post-tweet',
            },
          );
        },
      },
      xBudgetPolicy: budgetPolicy,
      db,
    });
    throw new Error('Expected TikHub worker failure');
  } catch (error) {
    expect(error).toBeInstanceOf(TikHubXTimelineError);
    expect(error).toMatchObject({ failureClass: 'TIKHUB_SCHEMA_INVALID' });
  }

  const [run] = await db
    .select({
      status: contentAcquisitionRuns.status,
      provider: contentAcquisitionRuns.provider,
      providerUnits: contentAcquisitionRuns.providerUnits,
      xCallCount: contentAcquisitionRuns.xCallCount,
      checkpointAdvanced: contentAcquisitionRuns.checkpointAdvanced,
      failureClass: contentAcquisitionRuns.failureClass,
    })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, claimed.runId));
  expect(run).toEqual({
    status: 'FAILED',
    provider: 'tikhub',
    providerUnits: '2.000000',
    xCallCount: 2,
    checkpointAdvanced: false,
    failureClass: 'TIKHUB_SCHEMA_INVALID',
  });
  expect(
    await db
      .select({
        provider: contentAcquisitionProviderTraces.provider,
        providerUnits: contentAcquisitionProviderTraces.providerUnits,
        terminalState: contentAcquisitionProviderTraces.terminalState,
      })
      .from(contentAcquisitionProviderTraces)
      .where(eq(contentAcquisitionProviderTraces.runId, claimed.runId)),
  ).toEqual([
    {
      provider: 'tikhub',
      providerUnits: '2.000000',
      terminalState: 'FAILED:TIKHUB_SCHEMA_INVALID',
    },
  ]);
  const reservations = await db
    .select({ status: contentAcquisitionBudgetReservations.status })
    .from(contentAcquisitionBudgetReservations)
    .where(eq(contentAcquisitionBudgetReservations.runId, claimed.runId));
  expect(reservations.length).toBeGreaterThanOrEqual(1);
  expect(reservations.every((row) => row.status === 'COMMITTED')).toBe(true);
  expect(await db.select().from(contentSourceObservations)).toHaveLength(0);
  expect(await db.select().from(contentSourceReceipts)).toHaveLength(0);
  expect(await db.select().from(contentSourceReceiptRevisions)).toHaveLength(0);
  expect(await db.select().from(contentSourceMediaGates)).toHaveLength(0);
  expect(await db.select().from(contentPipelineOutbox)).toHaveLength(0);
});
