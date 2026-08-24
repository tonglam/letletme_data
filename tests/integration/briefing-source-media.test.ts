import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq, inArray, ne, sql } from 'drizzle-orm';

import type { AcquisitionBatchV1 } from '../../src/content/acquisition/acquisition-contract';
import {
  beginFormalRun,
  claimDueFormalRuns,
  confirmFormalRunEnqueued,
} from '../../src/content/acquisition/formal-run-repository';
import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import { reconcileBriefingSourceRegistry } from '../../src/content/acquisition/manifest-reconciler';
import { persistAcquisitionResult } from '../../src/content/acquisition/receipt-repository';
import { compileXBudgetPolicy } from '../../src/content/acquisition/x-budget';
import {
  claimSourceMediaGates,
  markSourceMediaItemArchived,
  markSourceMediaItemFailed,
  releaseSourceMediaGateLeases,
  reserveSourceMediaAsset,
  renewSourceMediaGateLease,
  saveSourceMediaInventory,
} from '../../src/content/media/source-media-repository';
import { processSourceMediaGate } from '../../src/content/media/source-media-processor';
import { runSourceMediaRetention } from '../../src/content/media/source-media-retention';
import {
  SourceMediaDownloadError,
  sourceMediaObjectKey,
  verifySourceImageBytes,
} from '../../src/content/media/source-media-download';
import {
  SourceMediaStorageError,
  type SourceMediaStorage,
} from '../../src/content/media/source-media-storage';
import {
  contentPipelineOutbox,
  contentSourceEndpoints,
  contentSourceMediaAssets,
  contentSourceMediaGates,
  contentSourceMediaItems,
  contentSourcePartitions,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSourceSchedules,
} from '../../src/db/schemas/content.schema';
import { databaseSingleton, getDb } from '../../src/db/singleton';
import { resetBriefingAcquisitionState } from './helpers/briefing-acquisition-reset';

afterAll(async () => {
  await databaseSingleton.disconnect();
});

const postIds = ['2091144605710647466', '2091144605710647467'] as const;
const tinyPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);

function batch(mediaIncluded: boolean): AcquisitionBatchV1 {
  const checkedAt = new Date().toISOString();
  return {
    schemaVersion: 1,
    endpointKey: 'official-fpl-x',
    checkedAt,
    validator: {
      etag: null,
      lastModified: null,
      providerCursor: null,
      cacheNotBefore: null,
    },
    transportBodyHash: '1'.repeat(64),
    items: postIds.map((postId, index) => ({
      endpointKey: 'official-fpl-x',
      externalItemId: postId,
      canonicalUrl: `https://x.com/OfficialFPL/status/${postId}`,
      sourceUrl: `https://x.com/OfficialFPL/status/${postId}`,
      linkAvailability: 'DIRECT' as const,
      publishedAt: `2026-08-22T17:5${index}:00.000Z`,
      updatedAt: null,
      title: null,
      authorExternalId: '761568335138058240',
      contentKind: 'POST' as const,
      body: { availability: 'FULL' as const, text: `Stable post body ${index}` },
      media: mediaIncluded
        ? [
            {
              kind: 'IMAGE' as const,
              url: `https://pbs.twimg.com/media/legacy-${index}?format=jpg&name=small`,
              mimeType: 'image/jpeg',
              durationSeconds: null,
            },
          ]
        : [],
      ...(mediaIncluded ? { mediaStatus: 'FOUND' as const } : {}),
      transcript: {
        status: 'NOT_APPLICABLE' as const,
        language: null,
        trackKind: null,
        providerRevision: null,
        segments: [],
      },
    })),
  };
}

function metadataOnlyBatch(): AcquisitionBatchV1 {
  const value = batch(false);
  return {
    ...value,
    items: value.items.map((item) => ({
      ...item,
      body: { availability: 'METADATA_ONLY' as const, text: null },
    })),
  };
}

test('decouples X receipts from durable media processing and reuses legacy core revisions', async () => {
  await resetBriefingAcquisitionState();
  const bundle = await loadBriefingManifest();
  const budgetPolicy = compileXBudgetPolicy({
    coverage: bundle.coverage,
    globalRolling24hLimit: 2_400,
    final90Rolling90mLimit: 300,
  });
  await reconcileBriefingSourceRegistry({ bundle, gitRevision: 'source-media-integration' });
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
  if (!endpoint || !partition) throw new Error('OfficialFPL X manifest rows are missing');
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

  const createRun = async (): Promise<string> => {
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
      enabledAdapters: ['X_ACCOUNT'],
      claimLimit: 1,
      xBudgetPolicy: budgetPolicy,
    });
    if (!claimed) throw new Error('OfficialFPL X run was not claimed');
    expect(await confirmFormalRunEnqueued({ runId: claimed.runId })).toBe(true);
    expect((await beginFormalRun({ runId: claimed.runId })).status).toBe('RUNNING');
    return claimed.runId;
  };

  const persist = async (runId: string, value: AcquisitionBatchV1) =>
    persistAcquisitionResult({
      runId,
      state: 'COMPLETED',
      batches: [value],
      checkpointComplete: true,
      checkpoint: { windowEnd: new Date().toISOString() },
      nextDueAt: new Date(Date.now() + 30 * 60_000),
      providerTraces: [
        {
          sequence: 0,
          provider: 'grok-build',
          operation: 'x_keyword_search',
          requestMetadataHash: 'a'.repeat(64),
          responseMetadataHash: 'b'.repeat(64),
          providerJobIdHash: null,
          providerUnits: 1,
          terminalState: 'ATTESTED_FINAL',
        },
      ],
      providerResult: { provider: 'grok-build', providerUnits: 1 },
    });

  const first = await persist(await createRun(), batch(true));
  expect(first).toMatchObject({ revisionCount: 2, outboxCount: 2, checkpointAdvanced: true });

  const gates = await db
    .select()
    .from(contentSourceMediaGates)
    .orderBy(contentSourceMediaGates.postId);
  expect(gates).toHaveLength(2);
  expect(gates.every((gate) => gate.status === 'PENDING')).toBe(true);
  const baseEvents = await db
    .select({
      outboxId: contentPipelineOutbox.outboxId,
      mediaGateId: contentPipelineOutbox.mediaGateId,
      availableAt: contentPipelineOutbox.availableAt,
      createdAt: contentPipelineOutbox.createdAt,
    })
    .from(contentPipelineOutbox)
    .where(inArray(contentPipelineOutbox.eventType, ['receipt.accepted.v1', 'receipt.updated.v1']));
  expect(baseEvents).toHaveLength(2);
  expect(baseEvents.every((event) => event.mediaGateId !== null)).toBe(true);
  expect(
    baseEvents.every(
      (event) => event.availableAt.getTime() - event.createdAt.getTime() >= 19 * 60_000,
    ),
  ).toBe(true);

  const workerAClaims = await claimSourceMediaGates({
    workerId: 'media-worker-a',
    limit: 2,
    leaseMs: 5 * 60_000,
  });
  expect(workerAClaims).toHaveLength(2);
  expect(
    await claimSourceMediaGates({
      workerId: 'media-worker-b',
      limit: 2,
      leaseMs: 5 * 60_000,
    }),
  ).toHaveLength(0);
  expect(await releaseSourceMediaGateLeases({ workerId: 'media-worker-a' })).toBe(2);
  const workerBClaims = await claimSourceMediaGates({
    workerId: 'media-worker-b',
    limit: 2,
    leaseMs: 5 * 60_000,
  });
  expect(workerBClaims).toHaveLength(2);
  const noneGate = workerBClaims.find((gate) => gate.postId === postIds[0]);
  const mediaGate = workerBClaims.find((gate) => gate.postId === postIds[1]);
  if (!noneGate || !mediaGate) throw new Error('Claimed media gates do not match fixture posts');

  const noMediaResult = await processSourceMediaGate(noneGate, {
    bucket: 'briefing-source-media',
    storage: unreachableStorage(),
    fetchInventory: async () => ({ status: 'CHECKED_NONE', items: [] }),
  });
  expect(noMediaResult.status).toBe('CHECKED_NONE');
  const [advancedBaseEvent] = await db
    .select({ availableAt: contentPipelineOutbox.availableAt })
    .from(contentPipelineOutbox)
    .where(eq(contentPipelineOutbox.mediaGateId, noneGate.gateId));
  expect(advancedBaseEvent?.availableAt.getTime() ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
    Date.now() + 1_000,
  );

  const image = await verifySourceImageBytes(
    tinyPng,
    'https://pbs.twimg.com/media/source-media.png',
    'PAGE',
  );
  const objectKey = sourceMediaObjectKey(image);
  const storedObjects = new Map([[objectKey, image.bytes]]);
  let uploadCalls = 0;
  let secondImageFails = true;
  let assertRetentionCanUseDb = false;
  let retentionDbPreemptionChecks = 0;
  const storage: SourceMediaStorage = {
    ensureBucket: async () => ({}),
    upload: async (key, bytes) => {
      uploadCalls += 1;
      storedObjects.set(key, bytes);
    },
    download: async (key) => {
      const bytes = storedObjects.get(key);
      if (!bytes) {
        // Supabase Storage returns 400 (not_found) for a missing object on
        // some authenticated object reads; recovery must treat it like 404.
        throw new SourceMediaStorageError(
          'STORAGE_REQUEST_FAILED',
          'authenticated download failed with 400 (not_found)',
          400,
        );
      }
      return bytes;
    },
    remove: async (key) => {
      if (assertRetentionCanUseDb) {
        await claimSourceMediaGates({
          workerId: 'retention-db-preemption-check',
          limit: 0,
          leaseMs: 5 * 60_000,
        });
        retentionDbPreemptionChecks += 1;
      }
      return storedObjects.delete(key) ? 'deleted' : 'missing';
    },
    provisionAndProbe: async () => undefined,
  };

  await reserveSourceMediaAsset({
    gateId: mediaGate.gateId,
    image,
    objectKey,
    bucket: 'briefing-source-media',
    workerId: mediaGate.leaseOwner,
    leaseMs: 5 * 60_000,
  });
  await db
    .update(contentPipelineOutbox)
    .set({
      status: 'DELIVERED',
      availableAt: new Date(Date.now() - 1_000),
      deliveredAt: new Date(),
    })
    .where(eq(contentPipelineOutbox.mediaGateId, mediaGate.gateId));

  const inventory = {
    status: 'FOUND' as const,
    items: [
      {
        ordinal: 0,
        role: 'IMAGE' as const,
        sourceUrl: 'https://pbs.twimg.com/media/first?format=png&name=small',
        altText: 'First image',
        sourceVariant: 'PAGE' as const,
      },
      {
        ordinal: 1,
        role: 'IMAGE' as const,
        sourceUrl: 'https://pbs.twimg.com/media/second?format=png&name=small',
        altText: 'Second image',
        sourceVariant: 'PAGE' as const,
      },
      {
        ordinal: 2,
        role: 'VIDEO_STREAM' as const,
        sourceUrl: 'https://video.twimg.com/amplify_video/123/pl/master.m3u8',
        altText: null,
        sourceVariant: 'PAGE' as const,
      },
    ],
  };
  const partial = await processSourceMediaGate(mediaGate, {
    bucket: 'briefing-source-media',
    storage,
    fetchInventory: async () => inventory,
    downloadImage: async (sourceUrl) => {
      if (sourceUrl.includes('/second') && secondImageFails) {
        throw new SourceMediaDownloadError('IMAGE_HTTP_STATUS', 'synthetic retryable image');
      }
      return image;
    },
  });
  expect(partial.status).toBe('PARTIAL');
  expect(uploadCalls).toBe(0);
  const [recoveredAsset] = await db
    .select({
      assetId: contentSourceMediaAssets.assetId,
      state: contentSourceMediaAssets.storageState,
    })
    .from(contentSourceMediaAssets)
    .where(eq(contentSourceMediaAssets.sha256, image.sha256));
  expect(recoveredAsset?.state).toBe('AVAILABLE');
  const [staleWriteTarget] = await db
    .select({ itemId: contentSourceMediaItems.itemId })
    .from(contentSourceMediaItems)
    .where(
      sql`${contentSourceMediaItems.gateId} = ${mediaGate.gateId}::uuid
        AND ${contentSourceMediaItems.ordinal} = 0`,
    )
    .limit(1);
  if (!staleWriteTarget) throw new Error('Archived media item disappeared');
  await expect(
    markSourceMediaItemFailed({
      itemId: staleWriteTarget.itemId,
      gateId: mediaGate.gateId,
      workerId: mediaGate.leaseOwner,
      failureClass: 'STALE_WORKER_WRITE',
      unsafe: false,
    }),
  ).rejects.toThrow('Source-media item failure lease was lost');
  const partialUpdates = await db
    .select({ eventKey: contentPipelineOutbox.eventKey })
    .from(contentPipelineOutbox)
    .where(eq(contentPipelineOutbox.eventType, 'receipt.media.updated.v1'));
  expect(partialUpdates).toHaveLength(1);

  await db
    .update(contentSourceMediaGates)
    .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
    .where(eq(contentSourceMediaGates.gateId, mediaGate.gateId));
  const [repairClaim] = await claimSourceMediaGates({
    workerId: 'media-worker-c',
    limit: 1,
    leaseMs: 5 * 60_000,
  });
  if (!repairClaim) throw new Error('Partial media gate was not reclaimed');
  await expect(
    saveSourceMediaInventory({
      gateId: repairClaim.gateId,
      workerId: repairClaim.leaseOwner,
      items: inventory.items.map((item) =>
        item.ordinal === 0 ? { ...item, altText: 'Changed evidence' } : item,
      ),
    }),
  ).rejects.toThrow('SOURCE_MEDIA_INVENTORY_CHANGED');
  await db
    .update(contentSourceMediaGates)
    .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
    .where(eq(contentSourceMediaGates.gateId, repairClaim.gateId));
  expect(
    await renewSourceMediaGateLease({
      gateId: repairClaim.gateId,
      workerId: repairClaim.leaseOwner,
      leaseMs: 5 * 60_000,
    }),
  ).toBe(false);
  await expect(
    markSourceMediaItemFailed({
      itemId: staleWriteTarget.itemId,
      gateId: repairClaim.gateId,
      workerId: repairClaim.leaseOwner,
      failureClass: 'EXPIRED_LEASE_WRITE',
      unsafe: false,
    }),
  ).rejects.toThrow('Source-media item failure lease was lost');
  const [replacementClaim] = await claimSourceMediaGates({
    workerId: 'media-worker-d',
    limit: 1,
    leaseMs: 5 * 60_000,
  });
  if (!replacementClaim) throw new Error('Expired media gate lease was not reclaimed');
  const [retryableItem] = await db
    .select({ itemId: contentSourceMediaItems.itemId })
    .from(contentSourceMediaItems)
    .where(
      sql`${contentSourceMediaItems.gateId} = ${mediaGate.gateId}::uuid
        AND ${contentSourceMediaItems.ordinal} = 1`,
    )
    .limit(1);
  if (!retryableItem) throw new Error('Retryable media item disappeared');
  await db
    .update(contentSourceMediaAssets)
    .set({
      uploadLeaseOwner: 'retention-race',
      uploadLeaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    })
    .where(eq(contentSourceMediaAssets.assetId, recoveredAsset.assetId));
  await expect(
    markSourceMediaItemArchived({
      itemId: retryableItem.itemId,
      gateId: replacementClaim.gateId,
      workerId: replacementClaim.leaseOwner,
      assetId: recoveredAsset.assetId,
      actualMime: image.actualMime,
      sourceVariant: image.sourceVariant,
    }),
  ).rejects.toThrow('Source-media item archive lease or asset was lost');
  await expect(
    db
      .update(contentSourceMediaItems)
      .set({
        archiveStatus: 'ARCHIVED',
        assetId: recoveredAsset.assetId,
        actualMime: image.actualMime,
      })
      .where(eq(contentSourceMediaItems.itemId, retryableItem.itemId))
      .execute(),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('AVAILABLE MIME-matched asset'),
    },
  });
  await db
    .update(contentSourceMediaAssets)
    .set({ uploadLeaseOwner: null, uploadLeaseExpiresAt: null })
    .where(eq(contentSourceMediaAssets.assetId, recoveredAsset.assetId));
  // Simulate retention deleting the object and crashing before it can persist
  // DELETED. AVAILABLE with the expired retention marker must take the
  // authenticated recovery path rather than being trusted as present.
  await db
    .update(contentSourceMediaAssets)
    .set({
      uploadLeaseOwner: 'crashed-retention-worker',
      uploadLeaseExpiresAt: new Date(Date.now() - 1_000),
    })
    .where(eq(contentSourceMediaAssets.assetId, recoveredAsset.assetId));
  storedObjects.delete(objectKey);
  const crashRecoveryReservation = await reserveSourceMediaAsset({
    gateId: replacementClaim.gateId,
    image,
    objectKey,
    bucket: 'briefing-source-media',
    workerId: replacementClaim.leaseOwner,
    leaseMs: 5 * 60_000,
  });
  expect(crashRecoveryReservation).toMatchObject({
    assetId: recoveredAsset.assetId,
    storageState: 'RESERVED',
    needsRecoveryCheck: true,
  });
  secondImageFails = false;
  const complete = await processSourceMediaGate(replacementClaim, {
    bucket: 'briefing-source-media',
    storage,
    fetchInventory: async () => inventory,
    downloadImage: async () => image,
  });
  expect(complete.status).toBe('COMPLETE');
  expect(uploadCalls).toBe(1);
  expect(storedObjects.has(objectKey)).toBe(true);
  const mediaUpdates = await db
    .select({ eventKey: contentPipelineOutbox.eventKey })
    .from(contentPipelineOutbox)
    .where(eq(contentPipelineOutbox.eventType, 'receipt.media.updated.v1'));
  expect(mediaUpdates).toHaveLength(2);
  expect(new Set(mediaUpdates.map((event) => event.eventKey)).size).toBe(2);
  const items = await db
    .select({
      ordinal: contentSourceMediaItems.ordinal,
      status: contentSourceMediaItems.archiveStatus,
    })
    .from(contentSourceMediaItems)
    .where(eq(contentSourceMediaItems.gateId, mediaGate.gateId))
    .orderBy(contentSourceMediaItems.ordinal);
  expect(items).toEqual([
    { ordinal: 0, status: 'ARCHIVED' },
    { ordinal: 1, status: 'ARCHIVED' },
    { ordinal: 2, status: 'UNAVAILABLE' },
  ]);
  await expect(
    db
      .update(contentSourceMediaItems)
      .set({ sourceUrl: 'https://pbs.twimg.com/media/tampered.png' })
      .where(eq(contentSourceMediaItems.gateId, mediaGate.gateId))
      .execute(),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('source_media_items observed evidence is immutable'),
    },
  });
  expect(await runSourceMediaRetention({ workerId: 'retention-pass', storage })).toEqual({
    claimed: 0,
    deleted: 0,
    failed: 0,
  });

  const secondRunId = await createRun();
  const second = await persist(secondRunId, batch(false));
  expect(second).toMatchObject({
    state: 'CHECKED_NO_CHANGE',
    revisionCount: 0,
    unchangedCount: 2,
    outboxCount: 0,
  });

  const thirdRunId = await createRun();
  const third = await persist(thirdRunId, metadataOnlyBatch());
  expect(third).toMatchObject({
    state: 'CHECKED_NO_CHANGE',
    revisionCount: 0,
    unchangedCount: 2,
    outboxCount: 0,
  });
  const currentBodies = await db
    .select({ bodyAvailability: contentSourceReceiptRevisions.bodyAvailability })
    .from(contentSourceReceiptRevisions);
  expect(currentBodies).toHaveLength(2);
  expect(currentBodies.every((row) => row.bodyAvailability === 'FULL')).toBe(true);

  const [counts] = await db
    .select({
      receipts: sql<number>`count(DISTINCT ${contentSourceReceipts.receiptId})::integer`,
      revisions: sql<number>`count(DISTINCT ${contentSourceReceiptRevisions.receiptRevisionId})::integer`,
      gates: sql<number>`count(DISTINCT ${contentSourceMediaGates.gateId})::integer`,
    })
    .from(contentSourceReceipts)
    .innerJoin(
      contentSourceReceiptRevisions,
      eq(contentSourceReceiptRevisions.receiptId, contentSourceReceipts.receiptId),
    )
    .innerJoin(
      contentSourceMediaGates,
      eq(
        contentSourceMediaGates.receiptRevisionId,
        contentSourceReceiptRevisions.receiptRevisionId,
      ),
    );
  expect(counts).toEqual({ receipts: 2, revisions: 2, gates: 2 });

  if (!recoveredAsset) throw new Error('Recovered shared asset disappeared');
  const [revisionFacts] = await db
    .select({
      receiptId: contentSourceReceiptRevisions.receiptId,
      runId: contentSourceReceiptRevisions.runId,
      endpointId: contentSourceReceiptRevisions.endpointId,
      payload: contentSourceReceiptRevisions.payload,
      canonicalHash: contentSourceReceiptRevisions.canonicalHash,
      bodyAvailability: contentSourceReceiptRevisions.bodyAvailability,
    })
    .from(contentSourceReceiptRevisions)
    .where(eq(contentSourceReceiptRevisions.receiptRevisionId, mediaGate.receiptRevisionId))
    .limit(1);
  const [seasonFacts] = await db
    .select({ seasonId: contentSourceMediaGates.seasonId })
    .from(contentSourceMediaGates)
    .where(eq(contentSourceMediaGates.gateId, mediaGate.gateId))
    .limit(1);
  const [fallbackSeason] = await db.execute<{ seasonId: number }>(
    sql`SELECT season_id AS "seasonId" FROM fpl.seasons ORDER BY season_id LIMIT 1`,
  );
  if (!revisionFacts) throw new Error('Source revision facts disappeared');
  const expiredRevisionId = randomUUID();
  const expiredGateId = randomUUID();
  const expiredAssetId = randomUUID();
  const expiredSha = 'f'.repeat(64);
  const expiredObjectKey = `x/images/sha256/ff/${expiredSha}.png`;
  const orphanAssetId = randomUUID();
  const orphanSha = 'a'.repeat(64);
  const orphanObjectKey = `x/images/sha256/aa/${orphanSha}.png`;
  // Keep the fixture comfortably beyond the 24-hour orphan threshold even if
  // the local and PostgreSQL clocks differ slightly.
  const yesterday = new Date(Date.now() - 25 * 60 * 60_000);
  const retentionSeasonId = seasonFacts?.seasonId ?? fallbackSeason?.seasonId;
  if (!retentionSeasonId) throw new Error('Retention fixture requires one FPL season');
  await db.transaction(async (tx) => {
    await tx.insert(contentSourceReceiptRevisions).values({
      receiptRevisionId: expiredRevisionId,
      receiptId: revisionFacts.receiptId,
      revisionNumber: 2,
      runId: secondRunId,
      endpointId: revisionFacts.endpointId,
      payload: revisionFacts.payload,
      canonicalHash: revisionFacts.canonicalHash,
      bodyAvailability: revisionFacts.bodyAvailability,
    });
    await tx.insert(contentSourceMediaGates).values({
      gateId: expiredGateId,
      receiptId: revisionFacts.receiptId,
      receiptRevisionId: expiredRevisionId,
      postId: mediaGate.postId,
      canonicalUrl: mediaGate.canonicalUrl,
      requestHash: 'e'.repeat(64),
      seasonId: retentionSeasonId,
      retainUntil: yesterday.toISOString().slice(0, 10),
      status: 'COMPLETE',
      releaseDeadlineAt: yesterday,
      repairUntilAt: yesterday,
      attemptCount: 1,
      firstAttemptAt: yesterday,
      lastAttemptAt: yesterday,
      completedAt: yesterday,
      discoveredCount: 2,
      archivedCount: 2,
      mediaStateHash: 'd'.repeat(64),
    });
    await tx.insert(contentSourceMediaAssets).values({
      assetId: expiredAssetId,
      sha256: expiredSha,
      objectKey: expiredObjectKey,
      actualMime: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      bucket: 'briefing-source-media',
      storageState: 'AVAILABLE',
      availableAt: yesterday,
    });
    await tx.insert(contentSourceMediaAssets).values({
      assetId: orphanAssetId,
      sha256: orphanSha,
      objectKey: orphanObjectKey,
      actualMime: 'image/png',
      byteSize: 1,
      width: 1,
      height: 1,
      bucket: 'briefing-source-media',
      storageState: 'AVAILABLE',
      availableAt: yesterday,
    });
    await tx.insert(contentSourceMediaItems).values([
      {
        itemId: randomUUID(),
        gateId: expiredGateId,
        ordinal: 0,
        role: 'IMAGE',
        sourceUrl: 'https://pbs.twimg.com/media/shared.png',
        sourceVariant: 'ORIG',
        actualMime: 'image/png',
        archiveStatus: 'ARCHIVED',
        assetId: recoveredAsset.assetId,
      },
      {
        itemId: randomUUID(),
        gateId: expiredGateId,
        ordinal: 1,
        role: 'IMAGE',
        sourceUrl: 'https://pbs.twimg.com/media/expired.png',
        sourceVariant: 'ORIG',
        actualMime: 'image/png',
        archiveStatus: 'ARCHIVED',
        assetId: expiredAssetId,
      },
    ]);
  });
  storedObjects.set(expiredObjectKey, Uint8Array.of(1));
  storedObjects.set(orphanObjectKey, Uint8Array.of(1));
  const [retentionHealthBeforeDelete] = await db.execute<{ retentionDueCount: number }>(sql`
    SELECT retention_due_count::integer AS "retentionDueCount"
    FROM content.source_media_health
  `);
  expect(retentionHealthBeforeDelete?.retentionDueCount).toBe(2);
  assertRetentionCanUseDb = true;
  expect(await runSourceMediaRetention({ workerId: 'retention-delete', storage })).toEqual({
    claimed: 2,
    deleted: 2,
    failed: 0,
  });
  assertRetentionCanUseDb = false;
  expect(retentionDbPreemptionChecks).toBe(2);
  const retentionStates = await db
    .select({
      assetId: contentSourceMediaAssets.assetId,
      state: contentSourceMediaAssets.storageState,
    })
    .from(contentSourceMediaAssets)
    .where(
      inArray(contentSourceMediaAssets.assetId, [
        recoveredAsset.assetId,
        expiredAssetId,
        orphanAssetId,
      ]),
    );
  expect(new Map(retentionStates.map((asset) => [asset.assetId, asset.state]))).toEqual(
    new Map([
      [recoveredAsset.assetId, 'AVAILABLE'],
      [expiredAssetId, 'DELETED'],
      [orphanAssetId, 'DELETED'],
    ]),
  );
  expect(storedObjects.has(objectKey)).toBe(true);
  expect(storedObjects.has(expiredObjectKey)).toBe(false);
  expect(storedObjects.has(orphanObjectKey)).toBe(false);

  const staleReservationAssetId = randomUUID();
  const staleReservationSha = 'c'.repeat(64);
  const staleReservationObjectKey = `x/images/sha256/cc/${staleReservationSha}.png`;
  await db.insert(contentSourceMediaAssets).values({
    assetId: staleReservationAssetId,
    sha256: staleReservationSha,
    objectKey: staleReservationObjectKey,
    actualMime: 'image/png',
    byteSize: 1,
    width: 1,
    height: 1,
    bucket: 'briefing-source-media',
    storageState: 'RESERVED',
    uploadLeaseOwner: 'dead-worker:gate:expired',
    uploadLeaseExpiresAt: yesterday,
    createdAt: yesterday,
  });
  storedObjects.set(staleReservationObjectKey, Uint8Array.of(1));
  expect(
    await claimSourceMediaGates({
      workerId: 'reservation-reconciler',
      limit: 0,
      leaseMs: 5 * 60_000,
    }),
  ).toHaveLength(0);
  const [reconciledReservation] = await db
    .select({
      state: contentSourceMediaAssets.storageState,
      leaseOwner: contentSourceMediaAssets.uploadLeaseOwner,
      leaseExpiresAt: contentSourceMediaAssets.uploadLeaseExpiresAt,
      failureHash: contentSourceMediaAssets.lastFailureHash,
    })
    .from(contentSourceMediaAssets)
    .where(eq(contentSourceMediaAssets.assetId, staleReservationAssetId))
    .limit(1);
  expect(reconciledReservation).toMatchObject({
    state: 'FAILED',
    leaseOwner: null,
    leaseExpiresAt: null,
    failureHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  const [retentionHealthAfterReservationRecovery] = await db.execute<{
    retentionDueCount: number;
  }>(sql`
    SELECT retention_due_count::integer AS "retentionDueCount"
    FROM content.source_media_health
  `);
  expect(retentionHealthAfterReservationRecovery?.retentionDueCount).toBe(1);
  expect(
    await runSourceMediaRetention({
      workerId: 'retention-failed-reservation',
      storage,
    }),
  ).toEqual({ claimed: 1, deleted: 1, failed: 0 });
  expect(storedObjects.has(staleReservationObjectKey)).toBe(false);

  const retentionLeaseRaceAssets = [
    {
      assetId: randomUUID(),
      sha256: '6'.repeat(64),
      objectKey: `x/images/sha256/66/${'6'.repeat(64)}.png`,
    },
    {
      assetId: randomUUID(),
      sha256: '7'.repeat(64),
      objectKey: `x/images/sha256/77/${'7'.repeat(64)}.png`,
    },
  ] as const;
  await db.insert(contentSourceMediaAssets).values(
    retentionLeaseRaceAssets.map((asset) => ({
      ...asset,
      actualMime: 'image/png' as const,
      byteSize: 1,
      width: 1,
      height: 1,
      bucket: 'briefing-source-media',
      storageState: 'AVAILABLE' as const,
      availableAt: yesterday,
    })),
  );
  for (const asset of retentionLeaseRaceAssets) {
    storedObjects.set(asset.objectKey, Uint8Array.of(1));
  }
  const retentionLeaseRaceRemoveKeys: string[] = [];
  const retentionLeaseRaceStorage: SourceMediaStorage = {
    ...storage,
    remove: async (key) => {
      retentionLeaseRaceRemoveKeys.push(key);
      if (retentionLeaseRaceRemoveKeys.length === 1) {
        const expiredRows = await db.execute<{ objectKey: string }>(sql`
          UPDATE content.source_media_assets
          SET upload_lease_expires_at = ${yesterday.toISOString()}::timestamptz,
              updated_at = now()
          WHERE asset_id IN (
            ${retentionLeaseRaceAssets[0].assetId}::uuid,
            ${retentionLeaseRaceAssets[1].assetId}::uuid
          )
            AND object_key <> ${key}
            AND upload_lease_owner = 'retention-lease-race'
          RETURNING object_key AS "objectKey"
        `);
        expect(expiredRows).toHaveLength(1);
        expect(expiredRows[0]?.objectKey).not.toBe(key);
        const [expiredLease] = await db.execute<{ expired: boolean }>(sql`
          SELECT upload_lease_expires_at <= clock_timestamp() AS expired
          FROM content.source_media_assets
          WHERE object_key = ${expiredRows[0]?.objectKey ?? ''}
        `);
        expect(expiredLease?.expired).toBe(true);
      }
      return storedObjects.delete(key) ? 'deleted' : 'missing';
    },
  };
  expect(
    await runSourceMediaRetention({
      workerId: 'retention-lease-race',
      storage: retentionLeaseRaceStorage,
    }),
  ).toEqual({ claimed: 2, deleted: 1, failed: 1 });
  expect(retentionLeaseRaceRemoveKeys).toHaveLength(1);
  const retentionLeaseRaceStates = await db
    .select({
      objectKey: contentSourceMediaAssets.objectKey,
      state: contentSourceMediaAssets.storageState,
      leaseOwner: contentSourceMediaAssets.uploadLeaseOwner,
    })
    .from(contentSourceMediaAssets)
    .where(
      inArray(
        contentSourceMediaAssets.assetId,
        retentionLeaseRaceAssets.map((asset) => asset.assetId),
      ),
    );
  expect(retentionLeaseRaceStates.filter((asset) => asset.state === 'DELETED')).toHaveLength(1);
  expect(retentionLeaseRaceStates.filter((asset) => asset.state === 'FAILED')).toHaveLength(1);
  expect(retentionLeaseRaceStates.every((asset) => asset.leaseOwner === null)).toBe(true);
  expect(
    retentionLeaseRaceAssets.filter((asset) => storedObjects.has(asset.objectKey)),
  ).toHaveLength(1);
  expect(
    await runSourceMediaRetention({
      workerId: 'retention-lease-race-recovery',
      storage,
    }),
  ).toEqual({ claimed: 1, deleted: 1, failed: 0 });
  const recoveredRetentionStates = await db
    .select({ state: contentSourceMediaAssets.storageState })
    .from(contentSourceMediaAssets)
    .where(
      inArray(
        contentSourceMediaAssets.assetId,
        retentionLeaseRaceAssets.map((asset) => asset.assetId),
      ),
    );
  expect(recoveredRetentionStates.every((asset) => asset.state === 'DELETED')).toBe(true);
  expect(retentionLeaseRaceAssets.some((asset) => storedObjects.has(asset.objectKey))).toBe(false);

  await db
    .update(contentSourceMediaAssets)
    .set({ storageState: 'RESERVED', deletedAt: null })
    .where(eq(contentSourceMediaAssets.assetId, expiredAssetId));
  await expect(
    db
      .update(contentSourceMediaAssets)
      .set({ width: 2 })
      .where(eq(contentSourceMediaAssets.assetId, expiredAssetId))
      .execute(),
  ).rejects.toMatchObject({
    cause: {
      message: expect.stringContaining('available source_media_assets facts are immutable'),
    },
  });
  await db
    .update(contentSourceMediaAssets)
    .set({ storageState: 'DELETED', deletedAt: new Date() })
    .where(eq(contentSourceMediaAssets.assetId, expiredAssetId));
}, 15_000);

function unreachableStorage(): SourceMediaStorage {
  const fail = async (): Promise<never> => {
    throw new Error('Storage must not be called for CHECKED_NONE');
  };
  return {
    ensureBucket: fail,
    upload: fail,
    download: fail,
    remove: fail,
    provisionAndProbe: fail,
  };
}
