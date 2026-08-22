import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { eq, ne } from 'drizzle-orm';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import type { GrokBuildExecutionResult } from '../../src/content/acquisition/grok-build-executor';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import type { XToolRequestV1 } from '../../src/content/acquisition/x-query-compiler';
import { getContentRuntimeFlags } from '../../src/content/config';
import { runFormalXWorker } from '../../src/content/workers/formal-x.worker';
import {
  contentSourceEndpoints,
  contentSourcePartitions,
  contentSourceReceipts,
  contentSourceSchedules,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';

const X_SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;

afterAll(async () => {
  await databaseSingleton.disconnect();
});

function snowflakeAt(timestamp: Date, sequence: number): string {
  return (
    ((BigInt(timestamp.getTime()) - X_SNOWFLAKE_EPOCH_MS) << 22n) |
    BigInt(sequence)
  ).toString();
}

function semanticExecution(request: XToolRequestV1): GrokBuildExecutionResult {
  if (request.toolName !== 'x_semantic_search') throw new Error('Expected semantic request');
  const knownAt = new Date(Date.now() - 2 * 60_000);
  const observedAt = new Date(Date.now() - 3 * 60_000);
  const knownId = snowflakeAt(knownAt, 1);
  const observedId = snowflakeAt(observedAt, 2);
  return {
    toolName: 'x_semantic_search',
    toolInput: {
      query: request.query,
      from_date: request.fromDate,
      to_date: request.toDate,
      limit: request.limit,
    },
    posts: [
      {
        postId: knownId,
        authorHandle: 'OfficialFPL',
        createdAt: knownAt.toISOString(),
        text: 'Known source semantic result',
        url: `https://x.com/OfficialFPL/status/${knownId}`,
      },
      {
        postId: observedId,
        authorHandle: 'FixtureScout',
        createdAt: observedAt.toISOString(),
        text: 'Observed source semantic result',
        url: `https://x.com/FixtureScout/status/${observedId}`,
      },
    ],
    users: [],
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
  };
}

test('attributes semantic posts to known sources and non-recurring observed sources', async () => {
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'x-semantic-test' });
  const db = await getDb();
  const [knownEndpoint] = await db
    .select({ endpointId: contentSourceEndpoints.endpointId })
    .from(contentSourceEndpoints)
    .where(eq(contentSourceEndpoints.endpointKey, 'official-fpl-x'))
    .limit(1);
  const [partition] = await db
    .select({ partitionId: contentSourcePartitions.partitionId })
    .from(contentSourcePartitions)
    .where(eq(contentSourcePartitions.partitionKey, 'semantic-availability'))
    .limit(1);
  if (!knownEndpoint || !partition) throw new Error('Semantic fixture registry rows are missing');
  await db
    .update(contentSourceEndpoints)
    .set({
      stableExternalId: '761568335138058240',
      identityStatus: 'VERIFIED',
      identityCheckedAt: new Date(),
      identityNextCheckAt: new Date(Date.now() + 30 * 24 * 60 * 60_000),
    })
    .where(eq(contentSourceEndpoints.endpointId, knownEndpoint.endpointId));
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

  const [claimed] = await claimDueFormalRuns({
    enabledAdapters: ['X_SEMANTIC'],
    claimLimit: 1,
    xBudgetPolicy: budgetPolicy,
  });
  if (!claimed) throw new Error('Semantic run was not claimed');
  expect(claimed.jobKind).toBe('X_SEMANTIC_SCAN');
  expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
  const result = await runFormalXWorker(claimed.job, {
    flags: {
      ...getContentRuntimeFlags(),
      pipelineEnabled: true,
      acquisitionShadowMode: true,
      xScanEnabled: true,
      realGrokEnabled: true,
    },
    executor: { execute: async (request) => semanticExecution(request) },
    xBudgetPolicy: budgetPolicy,
  });
  expect(result).toMatchObject({ status: 'COMPLETED', receiptCount: 2, revisionCount: 2 });

  const observed = await db
    .select({
      sourceId: contentSources.sourceId,
      sourceKey: contentSources.sourceKey,
      sourceType: contentSources.sourceType,
      sourceStatus: contentSources.status,
      sourceOrigin: contentSources.origin,
      endpointId: contentSourceEndpoints.endpointId,
      endpointStatus: contentSourceEndpoints.status,
      endpointOrigin: contentSourceEndpoints.origin,
      identityStatus: contentSourceEndpoints.identityStatus,
      identityNextCheckAt: contentSourceEndpoints.identityNextCheckAt,
    })
    .from(contentSources)
    .innerJoin(contentSourceEndpoints, eq(contentSourceEndpoints.sourceId, contentSources.sourceId))
    .where(eq(contentSources.handle, 'FixtureScout'));
  expect(observed).toHaveLength(1);
  expect(observed[0]).toMatchObject({
    sourceType: 'DISCOVERED_UNKNOWN',
    sourceStatus: 'observed',
    sourceOrigin: 'DISCOVERED',
    endpointStatus: 'observed',
    endpointOrigin: 'DISCOVERED',
    identityStatus: 'PENDING',
    identityNextCheckAt: null,
  });
  const observedSchedules = await db
    .select({ scheduleId: contentSourceSchedules.scheduleId })
    .from(contentSourceSchedules)
    .where(eq(contentSourceSchedules.endpointId, observed[0]!.endpointId));
  expect(observedSchedules).toHaveLength(0);

  const receiptSources = await db
    .select({ sourceKey: contentSources.sourceKey })
    .from(contentSourceReceipts)
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceReceipts.sourceId));
  expect(receiptSources.map((row) => row.sourceKey).sort()).toEqual(
    [observed[0]!.sourceKey, 'official-fpl'].sort(),
  );
});
