import { createHash } from 'node:crypto';

import { logInfo, logWarn } from '../../utils/logger';
import {
  finalizeSourceMediaGate,
  listSourceMediaItems,
  markSourceMediaAssetAvailable,
  markSourceMediaAssetFailed,
  markSourceMediaItemArchived,
  markSourceMediaItemFailed,
  recordSourceMediaGateFailure,
  reserveSourceMediaAsset,
  saveSourceMediaInventory,
  type ClaimedSourceMediaGate,
} from './source-media-repository';
import {
  downloadAndVerifyXImage,
  sourceMediaObjectKey,
  SourceMediaDownloadError,
  type SourceMediaDownloadOptions,
  type VerifiedSourceImage,
} from './source-media-download';
import {
  fetchXMediaInventory,
  type XMediaInventoryOptions,
  type XMediaInventoryResult,
} from './x-media-inventory';
import { SourceMediaStorageError, type SourceMediaStorage } from './source-media-storage';

const ASSET_LEASE_MS = 5 * 60_000;
const UNSAFE_IMAGE_FAILURES = new Set([
  'IMAGE_HOST_FORBIDDEN',
  'IMAGE_SVG_FORBIDDEN',
  'IMAGE_TYPE_UNRECOGNIZED',
  'IMAGE_TOO_LARGE',
  'IMAGE_DIMENSIONS_INVALID',
  'IMAGE_DIMENSIONS_EXCEEDED',
]);

export type SourceMediaProcessorDependencies = Readonly<{
  storage: SourceMediaStorage;
  bucket: string;
  inventoryOptions?: XMediaInventoryOptions;
  downloadOptions?: SourceMediaDownloadOptions;
  fetchInventory?: (
    canonicalUrl: string,
    postId: string,
    options?: XMediaInventoryOptions,
  ) => Promise<XMediaInventoryResult>;
  downloadImage?: (
    sourceUrl: string,
    options?: SourceMediaDownloadOptions,
  ) => Promise<VerifiedSourceImage>;
}>;

function errorClass(error: unknown): string {
  if (error instanceof SourceMediaDownloadError || error instanceof SourceMediaStorageError) {
    return error.failureClass;
  }
  if (error instanceof Error && error.message === 'SOURCE_MEDIA_ASSET_BUSY') {
    return 'SOURCE_MEDIA_ASSET_BUSY';
  }
  if (error instanceof Error && error.message === 'SOURCE_MEDIA_INVENTORY_CHANGED') {
    return 'SOURCE_MEDIA_INVENTORY_CHANGED';
  }
  return 'SOURCE_MEDIA_PROCESSING_FAILED';
}

function sourceUrlHash(sourceUrl: string): string {
  return createHash('sha256').update(sourceUrl, 'utf8').digest('hex');
}

async function recoverOrUploadAsset(input: {
  gate: ClaimedSourceMediaGate;
  image: VerifiedSourceImage;
  storage: SourceMediaStorage;
  bucket: string;
  signal?: AbortSignal;
}): Promise<string> {
  const objectKey = sourceMediaObjectKey(input.image);
  const reservation = await reserveSourceMediaAsset({
    gateId: input.gate.gateId,
    image: input.image,
    objectKey,
    bucket: input.bucket,
    workerId: input.gate.leaseOwner,
    leaseMs: ASSET_LEASE_MS,
  });
  if (reservation.storageState === 'AVAILABLE') return reservation.assetId;

  try {
    let objectRecovered = false;
    if (reservation.needsRecoveryCheck) {
      try {
        const existing = await input.storage.download(reservation.objectKey, input.signal);
        const existingHash = createHash('sha256').update(existing).digest('hex');
        if (existingHash !== input.image.sha256) {
          throw new SourceMediaStorageError(
            'STORAGE_EXISTING_HASH_MISMATCH',
            'Content-addressed Storage object has unexpected bytes',
          );
        }
        objectRecovered = true;
      } catch (error) {
        if (!(error instanceof SourceMediaStorageError) || error.status !== 404) throw error;
      }
    }

    if (!objectRecovered) {
      try {
        await input.storage.upload(
          reservation.objectKey,
          input.image.bytes,
          input.image.actualMime,
          input.signal,
        );
      } catch (error) {
        if (
          !(error instanceof SourceMediaStorageError) ||
          error.failureClass !== 'STORAGE_OBJECT_EXISTS'
        ) {
          throw error;
        }
        const existing = await input.storage.download(reservation.objectKey, input.signal);
        const existingHash = createHash('sha256').update(existing).digest('hex');
        if (existingHash !== input.image.sha256) {
          throw new SourceMediaStorageError(
            'STORAGE_EXISTING_HASH_MISMATCH',
            'Conflicting Storage object does not match its content-addressed key',
          );
        }
      }
    }
    await markSourceMediaAssetAvailable({
      assetId: reservation.assetId,
      gateId: input.gate.gateId,
      workerId: input.gate.leaseOwner,
    });
    return reservation.assetId;
  } catch (error) {
    await markSourceMediaAssetFailed({
      assetId: reservation.assetId,
      gateId: input.gate.gateId,
      workerId: input.gate.leaseOwner,
      failureClass: errorClass(error),
    }).catch(() => undefined);
    throw error;
  }
}

export async function processSourceMediaGate(
  gate: ClaimedSourceMediaGate,
  dependencies: SourceMediaProcessorDependencies,
  signal?: AbortSignal,
): Promise<{ status: string; retryAt: Date | null }> {
  const fetchInventory = dependencies.fetchInventory ?? fetchXMediaInventory;
  const downloadImage = dependencies.downloadImage ?? downloadAndVerifyXImage;
  try {
    const inventory = await fetchInventory(gate.canonicalUrl, gate.postId, {
      ...dependencies.inventoryOptions,
      signal,
    });
    if (inventory.status === 'UNAVAILABLE') {
      const retryAt = await recordSourceMediaGateFailure({
        gate,
        failureClass: inventory.failureClass,
      });
      logWarn('Source-media X page inventory unavailable', {
        gateId: gate.gateId,
        receiptRevisionId: gate.receiptRevisionId,
        attempt: gate.attemptCount,
        failureClass: inventory.failureClass,
        retryAt: retryAt?.toISOString() ?? null,
      });
      return { status: 'UNAVAILABLE', retryAt };
    }
    if (inventory.status === 'CHECKED_NONE') {
      const finalized = await finalizeSourceMediaGate({
        gateId: gate.gateId,
        workerId: gate.leaseOwner,
        checkedNone: true,
      });
      return finalized;
    }

    await saveSourceMediaInventory({
      gateId: gate.gateId,
      workerId: gate.leaseOwner,
      items: inventory.items,
    });
    const items = await listSourceMediaItems({ gateId: gate.gateId });
    for (const item of items) {
      if (signal?.aborted) throw new Error('SOURCE_MEDIA_ABORTED');
      if (
        item.role === 'VIDEO_STREAM' ||
        item.archiveStatus === 'ARCHIVED' ||
        item.archiveStatus === 'REJECTED_UNSAFE'
      ) {
        continue;
      }
      const startedAt = performance.now();
      try {
        const image = await downloadImage(item.sourceUrl, {
          ...dependencies.downloadOptions,
          signal,
        });
        const assetId = await recoverOrUploadAsset({
          gate,
          image,
          storage: dependencies.storage,
          bucket: dependencies.bucket,
          signal,
        });
        await markSourceMediaItemArchived({
          itemId: item.itemId,
          gateId: gate.gateId,
          workerId: gate.leaseOwner,
          assetId,
          actualMime: image.actualMime,
          sourceVariant: image.sourceVariant,
        });
        logInfo('Source-media image archived', {
          gateId: gate.gateId,
          receiptRevisionId: gate.receiptRevisionId,
          sourceUrlHash: sourceUrlHash(item.sourceUrl),
          ordinal: item.ordinal,
          sourceVariant: image.sourceVariant,
          actualMime: image.actualMime,
          bytes: image.byteSize,
          width: image.width,
          height: image.height,
          storageLatencyMs: Math.round(performance.now() - startedAt),
          attempt: gate.attemptCount,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        const failureClass = errorClass(error);
        await markSourceMediaItemFailed({
          itemId: item.itemId,
          gateId: gate.gateId,
          workerId: gate.leaseOwner,
          failureClass,
          unsafe: UNSAFE_IMAGE_FAILURES.has(failureClass),
        });
        logWarn('Source-media image archive failed', {
          gateId: gate.gateId,
          receiptRevisionId: gate.receiptRevisionId,
          sourceUrlHash: sourceUrlHash(item.sourceUrl),
          ordinal: item.ordinal,
          attempt: gate.attemptCount,
          failureClass,
        });
      }
    }
    return finalizeSourceMediaGate({ gateId: gate.gateId, workerId: gate.leaseOwner });
  } catch (error) {
    if (signal?.aborted) throw error;
    const failureClass = errorClass(error);
    const retryAt = await recordSourceMediaGateFailure({ gate, failureClass }).catch(() => null);
    throw Object.assign(error instanceof Error ? error : new Error(failureClass), {
      failureClass,
      retryAt,
    });
  }
}
