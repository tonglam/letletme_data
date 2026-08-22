import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, describe, expect, test } from 'bun:test';
import { eq, ne, sql } from 'drizzle-orm';

import type { AcquisitionBatchV1 } from '../../src/content/acquisition/acquisition-contract';
import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import {
  beginFormalRun,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { persistAcquisitionResult } from '../../src/content/acquisition/receipt-repository';
import {
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceObservations,
  contentSourcePartitionMembers,
  contentSourcePartitions,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceRegistryReconciliations,
  contentSourceSchedules,
  contentSources,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

describe('Briefing source registry reconciliation', () => {
  test('atomically applies the manifest and makes the same hash an unchanged no-op', async () => {
    await resetBriefingAcquisitionState();
    const bundle = await loadBriefingManifest();
    const first = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: 'integration-test',
    });
    const second = await reconcileBriefingSourceRegistry({
      bundle,
      gitRevision: 'integration-test',
    });

    expect(first).toMatchObject({
      status: 'APPLIED',
      entityCount: 85,
      endpointCount: 108,
      partitionCount: 44,
      scheduleCount: 65,
      fullRolloutEligible: true,
    });
    expect(second).toMatchObject({ status: 'UNCHANGED', manifestHash: first.manifestHash });

    const db = await getDb();
    const [counts] = await db
      .select({
        entities: sql<number>`count(DISTINCT ${contentSources.sourceId})::int`,
        endpoints: sql<number>`count(DISTINCT ${contentSourceEndpoints.endpointId})::int`,
      })
      .from(contentSources)
      .leftJoin(
        contentSourceEndpoints,
        eq(contentSourceEndpoints.sourceId, contentSources.sourceId),
      )
      .where(eq(contentSources.origin, 'MANIFEST'));
    const [partitionCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourcePartitions);
    const [memberCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourcePartitionMembers);
    const [scheduleCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(contentSourceSchedules);
    const reconciliations = await db
      .select({ status: contentSourceRegistryReconciliations.status })
      .from(contentSourceRegistryReconciliations);

    expect(counts).toEqual({ entities: 85, endpoints: 108 });
    expect(partitionCount?.count).toBe(44);
    expect(memberCount?.count).toBe(87);
    expect(scheduleCount?.count).toBe(65);
    expect(reconciliations.map((row) => row.status).sort()).toEqual(['APPLIED', 'UNCHANGED']);
  });

  test('atomically creates, reuses and revises a stable Receipt', async () => {
    await resetBriefingAcquisitionState();
    const bundle = await loadBriefingManifest();
    await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'receipt-revision-test' });
    const db = await getDb();
    const endpointRows = await db
      .select({
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        profileKey: contentSourceEndpoints.profileKey,
        scheduleId: contentSourceSchedules.scheduleId,
      })
      .from(contentSourceEndpoints)
      .innerJoin(
        contentSourceSchedules,
        eq(contentSourceSchedules.endpointId, contentSourceEndpoints.endpointId),
      )
      .where(eq(contentSourceEndpoints.endpointKey, 'fpl-focal-youtube'))
      .limit(1);
    const endpoint = endpointRows[0];
    expect(endpoint).toBeDefined();
    if (!endpoint) return;

    const baseBatch: AcquisitionBatchV1 = {
      schemaVersion: 1,
      endpointKey: endpoint.endpointKey,
      checkedAt: new Date().toISOString(),
      validator: {
        etag: null,
        lastModified: null,
        providerCursor: 'Xef37ImWz3M',
        cacheNotBefore: null,
      },
      transportBodyHash: '1'.repeat(64),
      items: [
        {
          endpointKey: endpoint.endpointKey,
          externalItemId: 'Xef37ImWz3M',
          canonicalUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
          sourceUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
          linkAvailability: 'DIRECT',
          publishedAt: '2026-08-20T10:00:00.000Z',
          updatedAt: null,
          title: 'FPL Focal test video',
          authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
          contentKind: 'VIDEO',
          body: { availability: 'METADATA_ONLY', text: null },
          media: [],
          transcript: {
            status: 'PENDING',
            language: null,
            trackKind: null,
            providerRevision: null,
            segments: [],
          },
        },
      ],
    };

    await db
      .update(contentSourceSchedules)
      .set({ status: 'paused' })
      .where(ne(contentSourceSchedules.endpointId, endpoint.endpointId));

    const createRun = async (): Promise<string> => {
      await db
        .update(contentSourceSchedules)
        .set({
          status: 'active',
          nextDueAt: new Date(Date.now() - 60_000),
          leaseOwner: null,
          leaseExpiresAt: null,
        })
        .where(eq(contentSourceSchedules.scheduleId, endpoint.scheduleId));
      const [claimed] = await claimDueFormalRuns({
        enabledAdapters: ['YOUTUBE_CHANNEL'],
        claimLimit: 1,
      });
      if (!claimed) throw new Error('YouTube feed run was not claimed');
      expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
      const begun = await beginFormalRun({ runId: claimed.runId });
      expect(begun.status).toBe('RUNNING');
      return claimed.runId;
    };

    const firstRunId = await createRun();
    const first = await persistAcquisitionResult({
      runId: firstRunId,
      state: 'COMPLETED',
      batches: [baseBatch],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(first).toMatchObject({
      state: 'COMPLETED',
      receiptCount: 1,
      revisionCount: 1,
      outboxCount: 1,
      checkpointAdvanced: true,
    });

    const secondRunId = await createRun();
    const second = await persistAcquisitionResult({
      runId: secondRunId,
      state: 'COMPLETED',
      batches: [baseBatch],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(second).toMatchObject({
      state: 'CHECKED_NO_CHANGE',
      revisionCount: 0,
      unchangedCount: 1,
      outboxCount: 0,
    });

    const thirdRunId = await createRun();
    const third = await persistAcquisitionResult({
      runId: thirdRunId,
      state: 'COMPLETED',
      batches: [
        {
          ...baseBatch,
          items: [{ ...baseBatch.items[0]!, title: 'FPL Focal changed title' }],
        },
      ],
      checkpointComplete: true,
      checkpoint: { videoId: 'Xef37ImWz3M' },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
    });
    expect(third).toMatchObject({ revisionCount: 1, outboxCount: 1 });

    const [databaseCounts] = await db
      .select({
        receipts: sql<number>`count(DISTINCT ${contentSourceReceipts.receiptId})::int`,
        revisions: sql<number>`count(DISTINCT ${contentSourceReceiptRevisions.receiptRevisionId})::int`,
        observations: sql<number>`count(DISTINCT ${contentSourceObservations.observationId})::int`,
        outbox: sql<number>`count(DISTINCT ${contentPipelineOutbox.outboxId})::int`,
      })
      .from(contentSourceReceipts)
      .leftJoin(
        contentSourceReceiptRevisions,
        eq(contentSourceReceiptRevisions.receiptId, contentSourceReceipts.receiptId),
      )
      .leftJoin(
        contentSourceObservations,
        eq(contentSourceObservations.receiptId, contentSourceReceipts.receiptId),
      )
      .leftJoin(
        contentPipelineOutbox,
        eq(contentPipelineOutbox.receiptId, contentSourceReceipts.receiptId),
      );
    expect(databaseCounts).toEqual({ receipts: 1, revisions: 2, observations: 3, outbox: 2 });

    const revision = await db
      .select({ id: contentSourceReceiptRevisions.receiptRevisionId })
      .from(contentSourceReceiptRevisions)
      .limit(1);
    expect(revision[0]).toBeDefined();
    if (revision[0]) {
      await expect(
        (async () => {
          await db
            .update(contentSourceReceiptRevisions)
            .set({ bodyAvailability: 'FULL' })
            .where(eq(contentSourceReceiptRevisions.receiptRevisionId, revision[0].id));
        })(),
      ).rejects.toThrow();
    }
  });
});
