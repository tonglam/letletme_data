import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  contentPipelineOutbox,
  contentSourceMediaAssets,
  contentSourceMediaGates,
  contentSourceMediaItems,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../../db/singleton';
import { sha256CanonicalJson } from '../acquisition/canonicalization';
import type { XMediaInventoryItem } from './x-media-inventory';
import type { VerifiedSourceImage } from './source-media-download';

const RETRY_OFFSETS_MS = [
  0,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;
const FINAL_RETRY_CLAIM_GRACE_MS = 60_000;

export type ClaimedSourceMediaGate = Readonly<{
  gateId: string;
  receiptId: string;
  receiptRevisionId: string;
  postId: string;
  canonicalUrl: string;
  requestHash: string;
  statusBeforeClaim: string;
  releaseDeadlineAt: Date;
  repairUntilAt: Date;
  attemptCount: number;
  firstAttemptAt: Date;
  leaseOwner: string;
  leaseExpiresAt: Date;
}>;

export type SourceMediaItemRow = Readonly<{
  itemId: string;
  gateId: string;
  ordinal: number;
  role: 'IMAGE' | 'VIDEO_POSTER' | 'VIDEO_STREAM';
  sourceUrl: string;
  altText: string | null;
  sourceVariant: string;
  archiveStatus: string;
  assetId: string | null;
}>;

export type ReservedSourceMediaAsset = Readonly<{
  assetId: string;
  objectKey: string;
  storageState: 'AVAILABLE' | 'RESERVED';
  needsRecoveryCheck: boolean;
}>;

export function effectiveSourceMediaDeliveryState(input: {
  status: string;
  releaseDeadlineAt: Date;
  now?: Date;
}): 'PENDING' | 'COMPLETE' | 'CHECKED_NONE' | 'PARTIAL' {
  if (input.status === 'COMPLETE') return 'COMPLETE';
  if (input.status === 'CHECKED_NONE') return 'CHECKED_NONE';
  return (input.now ?? new Date()) >= input.releaseDeadlineAt ? 'PARTIAL' : 'PENDING';
}

async function databaseNow(db: DbOrTransaction): Promise<Date> {
  const rows = await db.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
  const value = rows[0]?.dbNow;
  const result = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

function failureHash(failureClass: string): string {
  return sha256CanonicalJson({ failureClass });
}

export function sourceMediaRepairExhaustionTimestamp(input: {
  dbNow: Date;
  releaseDeadlineAt: Date;
}): Date {
  return new Date(Math.max(input.dbNow.getTime(), input.releaseDeadlineAt.getTime()));
}

function assetLeaseOwner(workerId: string, gateId: string): string {
  return `${workerId}:gate:${gateId}`;
}

function retryAt(input: {
  attemptCount: number;
  firstAttemptAt: Date;
  repairUntilAt: Date;
  dbNow: Date;
}): Date | null {
  const offset = RETRY_OFFSETS_MS[input.attemptCount];
  if (offset === undefined) return null;
  const desired = new Date(input.firstAttemptAt.getTime() + offset);
  const scheduled = new Date(Math.min(desired.getTime(), input.repairUntilAt.getTime()));
  const bounded = new Date(Math.max(scheduled.getTime(), input.dbNow.getTime() + 1_000));
  return bounded <= input.repairUntilAt ? bounded : null;
}

export async function claimSourceMediaGates(input: {
  workerId: string;
  limit: number;
  leaseMs: number;
  db?: DbHandle;
}): Promise<readonly ClaimedSourceMediaGate[]> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);

    await tx
      .update(contentSourceMediaGates)
      .set({
        status: sql`CASE WHEN release_deadline_at <= ${dbNow.toISOString()}::timestamptz THEN 'PARTIAL' ELSE 'PENDING' END`,
        nextAttemptAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastFailureClass: 'LEASE_EXPIRED',
        lastFailureHash: failureHash('LEASE_EXPIRED'),
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentSourceMediaGates.status, 'RUNNING'),
          lte(contentSourceMediaGates.leaseExpiresAt, dbNow),
        ),
      );

    // A process can die after reserving an asset (or even after uploading its
    // object) but before committing AVAILABLE/FAILED. Once the bounded upload
    // lease expires there is no live writer to protect. Reconcile the row now
    // so a final-attempt crash cannot leave retention permanently blocked by a
    // RESERVED asset. A later observation of the same hash moves FAILED back
    // to RESERVED and performs the authenticated object/hash recovery check.
    await tx
      .update(contentSourceMediaAssets)
      .set({
        storageState: 'FAILED',
        uploadLeaseOwner: null,
        uploadLeaseExpiresAt: null,
        lastFailureHash: failureHash('SOURCE_MEDIA_ASSET_RESERVATION_EXPIRED'),
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentSourceMediaAssets.storageState, 'RESERVED'),
          lte(contentSourceMediaAssets.uploadLeaseExpiresAt, dbNow),
        ),
      );

    await tx
      .update(contentSourceMediaGates)
      .set({
        status: sql`CASE WHEN status = 'PENDING' THEN 'UNAVAILABLE' ELSE status END`,
        nextAttemptAt: null,
        repairExhaustedAt: dbNow,
        updatedAt: dbNow,
      })
      .where(
        and(
          inArray(contentSourceMediaGates.status, ['PENDING', 'PARTIAL', 'UNAVAILABLE']),
          lte(
            contentSourceMediaGates.repairUntilAt,
            new Date(dbNow.getTime() - FINAL_RETRY_CLAIM_GRACE_MS),
          ),
          isNull(contentSourceMediaGates.repairExhaustedAt),
        ),
      );

    const rows = await tx
      .select({
        gateId: contentSourceMediaGates.gateId,
        receiptId: contentSourceMediaGates.receiptId,
        receiptRevisionId: contentSourceMediaGates.receiptRevisionId,
        postId: contentSourceMediaGates.postId,
        canonicalUrl: contentSourceMediaGates.canonicalUrl,
        requestHash: contentSourceMediaGates.requestHash,
        status: contentSourceMediaGates.status,
        releaseDeadlineAt: contentSourceMediaGates.releaseDeadlineAt,
        repairUntilAt: contentSourceMediaGates.repairUntilAt,
        attemptCount: contentSourceMediaGates.attemptCount,
        firstAttemptAt: contentSourceMediaGates.firstAttemptAt,
      })
      .from(contentSourceMediaGates)
      .where(
        and(
          inArray(contentSourceMediaGates.status, ['PENDING', 'PARTIAL', 'UNAVAILABLE']),
          lte(contentSourceMediaGates.nextAttemptAt, dbNow),
          isNull(contentSourceMediaGates.repairExhaustedAt),
        ),
      )
      .orderBy(asc(contentSourceMediaGates.nextAttemptAt), asc(contentSourceMediaGates.gateId))
      .limit(Math.max(0, input.limit))
      .for('update', { skipLocked: true });

    if (rows.length === 0) return [];
    const leaseExpiresAt = new Date(dbNow.getTime() + input.leaseMs);
    const gateIds = rows.map((row) => row.gateId);
    await tx
      .update(contentSourceMediaGates)
      .set({
        status: 'RUNNING',
        leaseOwner: input.workerId,
        leaseExpiresAt,
        firstAttemptAt: sql`COALESCE(first_attempt_at, ${dbNow.toISOString()}::timestamptz)`,
        lastAttemptAt: dbNow,
        attemptCount: sql`${contentSourceMediaGates.attemptCount} + 1`,
        updatedAt: dbNow,
      })
      .where(inArray(contentSourceMediaGates.gateId, gateIds));

    return rows.map((row) => ({
      gateId: row.gateId,
      receiptId: row.receiptId,
      receiptRevisionId: row.receiptRevisionId,
      postId: row.postId,
      canonicalUrl: row.canonicalUrl,
      requestHash: row.requestHash,
      statusBeforeClaim: row.status,
      releaseDeadlineAt: row.releaseDeadlineAt,
      repairUntilAt: row.repairUntilAt,
      attemptCount: row.attemptCount + 1,
      firstAttemptAt: row.firstAttemptAt ?? dbNow,
      leaseOwner: input.workerId,
      leaseExpiresAt,
    }));
  });
}

export async function renewSourceMediaGateLease(input: {
  gateId: string;
  workerId: string;
  leaseMs: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const rows = await db
    .update(contentSourceMediaGates)
    .set({
      leaseExpiresAt: new Date(dbNow.getTime() + input.leaseMs),
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaGates.gateId, input.gateId),
        eq(contentSourceMediaGates.status, 'RUNNING'),
        eq(contentSourceMediaGates.leaseOwner, input.workerId),
        gt(contentSourceMediaGates.leaseExpiresAt, dbNow),
      ),
    )
    .returning({ gateId: contentSourceMediaGates.gateId });
  return rows.length === 1;
}

export async function releaseSourceMediaGateLeases(input: {
  workerId: string;
  db?: DbHandle;
}): Promise<number> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const rows = await db
    .update(contentSourceMediaGates)
    .set({
      status: sql`CASE WHEN release_deadline_at <= ${dbNow.toISOString()}::timestamptz THEN 'PARTIAL' ELSE 'PENDING' END`,
      nextAttemptAt: dbNow,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaGates.status, 'RUNNING'),
        eq(contentSourceMediaGates.leaseOwner, input.workerId),
      ),
    )
    .returning({ gateId: contentSourceMediaGates.gateId });
  return rows.length;
}

export async function releaseSourceMediaGateLease(input: {
  gateId: string;
  workerId: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const rows = await db
    .update(contentSourceMediaGates)
    .set({
      status: sql`CASE WHEN release_deadline_at <= ${dbNow.toISOString()}::timestamptz THEN 'PARTIAL' ELSE 'PENDING' END`,
      nextAttemptAt: dbNow,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaGates.gateId, input.gateId),
        eq(contentSourceMediaGates.status, 'RUNNING'),
        eq(contentSourceMediaGates.leaseOwner, input.workerId),
      ),
    )
    .returning({ gateId: contentSourceMediaGates.gateId });
  return rows.length === 1;
}

async function lockedClaimedGate(input: {
  tx: Parameters<Parameters<DbHandle['transaction']>[0]>[0];
  gateId: string;
  workerId: string;
}) {
  const rows = await input.tx
    .select({
      gateId: contentSourceMediaGates.gateId,
      receiptId: contentSourceMediaGates.receiptId,
      receiptRevisionId: contentSourceMediaGates.receiptRevisionId,
      status: contentSourceMediaGates.status,
      attemptCount: contentSourceMediaGates.attemptCount,
      firstAttemptAt: contentSourceMediaGates.firstAttemptAt,
      releaseDeadlineAt: contentSourceMediaGates.releaseDeadlineAt,
      repairUntilAt: contentSourceMediaGates.repairUntilAt,
      archivedCount: contentSourceMediaGates.archivedCount,
      mediaStateHash: contentSourceMediaGates.mediaStateHash,
      leaseOwner: contentSourceMediaGates.leaseOwner,
      leaseExpiresAt: contentSourceMediaGates.leaseExpiresAt,
    })
    .from(contentSourceMediaGates)
    .where(eq(contentSourceMediaGates.gateId, input.gateId))
    .for('update')
    .limit(1);
  const gate = rows[0];
  if (!gate || gate.status !== 'RUNNING') throw new Error('Source-media gate is not RUNNING');
  if (gate.leaseOwner !== input.workerId) {
    throw new Error('Source-media gate lease owner changed');
  }
  if (!gate.leaseExpiresAt || gate.leaseExpiresAt <= (await databaseNow(input.tx))) {
    throw new Error('Source-media gate lease expired');
  }
  return gate;
}

export async function saveSourceMediaInventory(input: {
  gateId: string;
  workerId: string;
  items: readonly XMediaInventoryItem[];
  db?: DbHandle;
}): Promise<void> {
  const db = input.db ?? (await getDb());
  await db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);
    await lockedClaimedGate({ tx, gateId: input.gateId, workerId: input.workerId });
    const existingItems = await tx
      .select({
        ordinal: contentSourceMediaItems.ordinal,
        role: contentSourceMediaItems.role,
        sourceUrl: contentSourceMediaItems.sourceUrl,
        altText: contentSourceMediaItems.altText,
        sourceVariant: contentSourceMediaItems.sourceVariant,
      })
      .from(contentSourceMediaItems)
      .where(eq(contentSourceMediaItems.gateId, input.gateId))
      .orderBy(asc(contentSourceMediaItems.ordinal));
    if (
      existingItems.length > 0 &&
      (existingItems.length !== input.items.length ||
        existingItems.some((existing, index) => {
          const observed = input.items[index];
          return (
            !observed ||
            existing.ordinal !== observed.ordinal ||
            existing.role !== observed.role ||
            existing.sourceUrl !== observed.sourceUrl ||
            existing.altText !== observed.altText ||
            existing.sourceVariant !== observed.sourceVariant
          );
        }))
    ) {
      throw new Error('SOURCE_MEDIA_INVENTORY_CHANGED');
    }
    if (existingItems.length > 0) return;
    for (const item of input.items) {
      const stream = item.role === 'VIDEO_STREAM';
      await tx.insert(contentSourceMediaItems).values({
        itemId: randomUUID(),
        gateId: input.gateId,
        ordinal: item.ordinal,
        role: item.role,
        sourceUrl: item.sourceUrl,
        altText: item.altText,
        sourceVariant: item.sourceVariant,
        archiveStatus: stream ? 'UNAVAILABLE' : 'PENDING',
        failureClass: stream ? 'VIDEO_STREAM_MANIFEST_ONLY' : null,
        failureHash: stream ? failureHash('VIDEO_STREAM_MANIFEST_ONLY') : null,
        updatedAt: dbNow,
      });
    }
    await tx
      .update(contentSourceMediaGates)
      .set({ discoveredCount: input.items.length, updatedAt: dbNow })
      .where(eq(contentSourceMediaGates.gateId, input.gateId));
  });
}

export async function listSourceMediaItems(input: {
  gateId: string;
  db?: DbHandle;
}): Promise<readonly SourceMediaItemRow[]> {
  const db = input.db ?? (await getDb());
  const rows = await db
    .select({
      itemId: contentSourceMediaItems.itemId,
      gateId: contentSourceMediaItems.gateId,
      ordinal: contentSourceMediaItems.ordinal,
      role: contentSourceMediaItems.role,
      sourceUrl: contentSourceMediaItems.sourceUrl,
      altText: contentSourceMediaItems.altText,
      sourceVariant: contentSourceMediaItems.sourceVariant,
      archiveStatus: contentSourceMediaItems.archiveStatus,
      assetId: contentSourceMediaItems.assetId,
    })
    .from(contentSourceMediaItems)
    .where(eq(contentSourceMediaItems.gateId, input.gateId))
    .orderBy(asc(contentSourceMediaItems.ordinal));
  return rows as readonly SourceMediaItemRow[];
}

export async function reserveSourceMediaAsset(input: {
  gateId: string;
  image: VerifiedSourceImage;
  objectKey: string;
  bucket: string;
  workerId: string;
  leaseMs: number;
  db?: DbHandle;
}): Promise<ReservedSourceMediaAsset> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);
    await lockedClaimedGate({ tx, gateId: input.gateId, workerId: input.workerId });
    const uploadLeaseOwner = assetLeaseOwner(input.workerId, input.gateId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.image.sha256}))`);
    const rows = await tx
      .select()
      .from(contentSourceMediaAssets)
      .where(eq(contentSourceMediaAssets.sha256, input.image.sha256))
      .for('update')
      .limit(1);
    const existing = rows[0];
    if (existing) {
      if (
        existing.objectKey !== input.objectKey ||
        existing.actualMime !== input.image.actualMime ||
        existing.byteSize !== input.image.byteSize ||
        existing.width !== input.image.width ||
        existing.height !== input.image.height ||
        existing.bucket !== input.bucket
      ) {
        throw new Error('Source-media SHA identity conflicts with stored asset facts');
      }
      if (
        existing.uploadLeaseOwner &&
        existing.uploadLeaseOwner !== uploadLeaseOwner &&
        existing.uploadLeaseExpiresAt &&
        existing.uploadLeaseExpiresAt > dbNow
      ) {
        throw new Error('SOURCE_MEDIA_ASSET_BUSY');
      }
      if (
        existing.storageState === 'AVAILABLE' &&
        existing.uploadLeaseOwner === null &&
        existing.uploadLeaseExpiresAt === null
      ) {
        return {
          assetId: existing.assetId,
          objectKey: existing.objectKey,
          storageState: 'AVAILABLE',
          needsRecoveryCheck: false,
        };
      }
      // AVAILABLE with a stale upload lease is a durable retention-delete
      // marker. The object may have been removed before a worker crash, so it
      // must not take the trusted fast path. Move it back through RESERVED and
      // require the authenticated object/hash recovery used by other
      // non-AVAILABLE states.
      await tx
        .update(contentSourceMediaAssets)
        .set({
          storageState: 'RESERVED',
          deletedAt: null,
          uploadLeaseOwner,
          uploadLeaseExpiresAt: new Date(dbNow.getTime() + input.leaseMs),
          updatedAt: dbNow,
        })
        .where(eq(contentSourceMediaAssets.assetId, existing.assetId));
      return {
        assetId: existing.assetId,
        objectKey: existing.objectKey,
        storageState: 'RESERVED',
        needsRecoveryCheck: true,
      };
    }

    const assetId = randomUUID();
    await tx.insert(contentSourceMediaAssets).values({
      assetId,
      sha256: input.image.sha256,
      objectKey: input.objectKey,
      actualMime: input.image.actualMime,
      byteSize: input.image.byteSize,
      width: input.image.width,
      height: input.image.height,
      bucket: input.bucket,
      storageState: 'RESERVED',
      uploadLeaseOwner,
      uploadLeaseExpiresAt: new Date(dbNow.getTime() + input.leaseMs),
    });
    return {
      assetId,
      objectKey: input.objectKey,
      storageState: 'RESERVED',
      needsRecoveryCheck: true,
    };
  });
}

export async function markSourceMediaAssetAvailable(input: {
  assetId: string;
  gateId: string;
  workerId: string;
  db?: DbHandle;
}): Promise<void> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const uploadLeaseOwner = assetLeaseOwner(input.workerId, input.gateId);
  const rows = await db
    .update(contentSourceMediaAssets)
    .set({
      storageState: 'AVAILABLE',
      uploadLeaseOwner: null,
      uploadLeaseExpiresAt: null,
      availableAt: sql`COALESCE(available_at, ${dbNow.toISOString()}::timestamptz)`,
      lastFailureHash: null,
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaAssets.assetId, input.assetId),
        eq(contentSourceMediaAssets.storageState, 'RESERVED'),
        eq(contentSourceMediaAssets.uploadLeaseOwner, uploadLeaseOwner),
        gt(contentSourceMediaAssets.uploadLeaseExpiresAt, dbNow),
        sql`EXISTS (
          SELECT 1
          FROM ${contentSourceMediaGates} AS claimed_gate
          WHERE claimed_gate.gate_id = ${input.gateId}::uuid
            AND claimed_gate.status = 'RUNNING'
            AND claimed_gate.lease_owner = ${input.workerId}
            AND claimed_gate.lease_expires_at > now()
        )`,
      ),
    )
    .returning({ assetId: contentSourceMediaAssets.assetId });
  if (rows.length !== 1) throw new Error('Source-media asset reservation or gate lease was lost');
}

export async function markSourceMediaAssetFailed(input: {
  assetId: string;
  gateId: string;
  workerId: string;
  failureClass: string;
  db?: DbHandle;
}): Promise<void> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const uploadLeaseOwner = assetLeaseOwner(input.workerId, input.gateId);
  await db
    .update(contentSourceMediaAssets)
    .set({
      storageState: 'FAILED',
      uploadLeaseOwner: null,
      uploadLeaseExpiresAt: null,
      lastFailureHash: failureHash(input.failureClass),
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaAssets.assetId, input.assetId),
        eq(contentSourceMediaAssets.storageState, 'RESERVED'),
        eq(contentSourceMediaAssets.uploadLeaseOwner, uploadLeaseOwner),
        gt(contentSourceMediaAssets.uploadLeaseExpiresAt, dbNow),
        sql`EXISTS (
          SELECT 1
          FROM ${contentSourceMediaGates} AS claimed_gate
          WHERE claimed_gate.gate_id = ${input.gateId}::uuid
            AND claimed_gate.status = 'RUNNING'
            AND claimed_gate.lease_owner = ${input.workerId}
            AND claimed_gate.lease_expires_at > now()
        )`,
      ),
    );
}

export async function markSourceMediaItemArchived(input: {
  itemId: string;
  gateId: string;
  workerId: string;
  assetId: string;
  actualMime: string;
  sourceVariant: string;
  db?: DbHandle;
}): Promise<void> {
  const db = input.db ?? (await getDb());
  await db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);
    await lockedClaimedGate({ tx, gateId: input.gateId, workerId: input.workerId });
    const asset = (
      await tx
        .select({
          storageState: contentSourceMediaAssets.storageState,
          actualMime: contentSourceMediaAssets.actualMime,
          uploadLeaseOwner: contentSourceMediaAssets.uploadLeaseOwner,
        })
        .from(contentSourceMediaAssets)
        .where(eq(contentSourceMediaAssets.assetId, input.assetId))
        .for('update')
        .limit(1)
    )[0];
    if (
      !asset ||
      asset.storageState !== 'AVAILABLE' ||
      asset.actualMime !== input.actualMime ||
      asset.uploadLeaseOwner !== null
    ) {
      throw new Error('Source-media item archive lease or asset was lost');
    }
    const rows = await tx
      .update(contentSourceMediaItems)
      .set({
        archiveStatus: 'ARCHIVED',
        assetId: input.assetId,
        actualMime: input.actualMime,
        sourceVariant: input.sourceVariant,
        failureClass: null,
        failureHash: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentSourceMediaItems.itemId, input.itemId),
          eq(contentSourceMediaItems.gateId, input.gateId),
        ),
      )
      .returning({ itemId: contentSourceMediaItems.itemId });
    if (rows.length !== 1) throw new Error('Source-media item archive lease or asset was lost');
  });
}

export async function markSourceMediaItemFailed(input: {
  itemId: string;
  gateId: string;
  workerId: string;
  failureClass: string;
  unsafe: boolean;
  db?: DbHandle;
}): Promise<void> {
  const db = input.db ?? (await getDb());
  const dbNow = await databaseNow(db);
  const rows = await db
    .update(contentSourceMediaItems)
    .set({
      archiveStatus: input.unsafe ? 'REJECTED_UNSAFE' : 'RETRYABLE',
      assetId: null,
      actualMime: null,
      failureClass: input.failureClass,
      failureHash: failureHash(input.failureClass),
      updatedAt: dbNow,
    })
    .where(
      and(
        eq(contentSourceMediaItems.itemId, input.itemId),
        eq(contentSourceMediaItems.gateId, input.gateId),
        sql`EXISTS (
          SELECT 1
          FROM ${contentSourceMediaGates} AS claimed_gate
          WHERE claimed_gate.gate_id = ${input.gateId}::uuid
            AND claimed_gate.status = 'RUNNING'
            AND claimed_gate.lease_owner = ${input.workerId}
            AND claimed_gate.lease_expires_at > now()
        )`,
      ),
    )
    .returning({ itemId: contentSourceMediaItems.itemId });
  if (rows.length !== 1) throw new Error('Source-media item failure lease was lost');
}

async function writeMediaUpdateOutbox(input: {
  tx: Parameters<Parameters<DbHandle['transaction']>[0]>[0];
  gateId: string;
  receiptId: string;
  receiptRevisionId: string;
  mediaStateHash: string;
  dbNow: Date;
}): Promise<void> {
  const facts = (
    await input.tx
      .select({
        runId: contentSourceReceiptRevisions.runId,
        endpointId: contentSourceReceiptRevisions.endpointId,
        sourceId: contentSourceReceipts.sourceId,
      })
      .from(contentSourceReceiptRevisions)
      .innerJoin(
        contentSourceReceipts,
        eq(contentSourceReceipts.receiptId, contentSourceReceiptRevisions.receiptId),
      )
      .where(eq(contentSourceReceiptRevisions.receiptRevisionId, input.receiptRevisionId))
      .limit(1)
  )[0];
  if (!facts) throw new Error('Source-media outbox facts disappeared');
  const occurredAt = input.dbNow.toISOString();
  await input.tx
    .insert(contentPipelineOutbox)
    .values({
      outboxId: randomUUID(),
      eventKey: `receipt.media.updated.v1:${input.receiptRevisionId}:${input.mediaStateHash}`,
      eventType: 'receipt.media.updated.v1',
      receiptId: input.receiptId,
      receiptRevisionId: input.receiptRevisionId,
      runId: facts.runId,
      sourceId: facts.sourceId,
      endpointId: facts.endpointId,
      mediaGateId: input.gateId,
      occurredAt: input.dbNow,
      availableAt: input.dbNow,
      payload: {
        receiptId: input.receiptId,
        receiptRevisionId: input.receiptRevisionId,
        runId: facts.runId,
        sourceId: facts.sourceId,
        endpointId: facts.endpointId,
        occurredAt,
      },
    })
    .onConflictDoNothing({ target: contentPipelineOutbox.eventKey });
}

export async function finalizeSourceMediaGate(input: {
  gateId: string;
  workerId: string;
  checkedNone?: boolean;
  db?: DbHandle;
}): Promise<{
  status: 'COMPLETE' | 'CHECKED_NONE' | 'PARTIAL' | 'UNAVAILABLE';
  retryAt: Date | null;
}> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);
    const gate = await lockedClaimedGate({ tx, gateId: input.gateId, workerId: input.workerId });
    const items = await tx
      .select({
        ordinal: contentSourceMediaItems.ordinal,
        role: contentSourceMediaItems.role,
        sourceUrl: contentSourceMediaItems.sourceUrl,
        archiveStatus: contentSourceMediaItems.archiveStatus,
        assetId: contentSourceMediaItems.assetId,
        actualMime: contentSourceMediaItems.actualMime,
        failureClass: contentSourceMediaItems.failureClass,
      })
      .from(contentSourceMediaItems)
      .where(eq(contentSourceMediaItems.gateId, input.gateId))
      .orderBy(asc(contentSourceMediaItems.ordinal));

    if (input.checkedNone && items.length > 0) {
      throw new Error('CHECKED_NONE is forbidden after a media inventory was observed');
    }
    const staticItems = items.filter((item) => item.role !== 'VIDEO_STREAM');
    const archivedCount = staticItems.filter((item) => item.archiveStatus === 'ARCHIVED').length;
    const rejectedCount = staticItems.filter(
      (item) => item.archiveStatus === 'REJECTED_UNSAFE',
    ).length;
    const retryableCount = staticItems.filter((item) =>
      ['PENDING', 'RETRYABLE', 'UNAVAILABLE'].includes(item.archiveStatus),
    ).length;
    let status: 'COMPLETE' | 'CHECKED_NONE' | 'PARTIAL' | 'UNAVAILABLE';
    if (input.checkedNone) status = 'CHECKED_NONE';
    else if (staticItems.length > 0 && archivedCount === staticItems.length) status = 'COMPLETE';
    else if (archivedCount > 0) status = 'PARTIAL';
    else status = 'UNAVAILABLE';

    const mediaStateHash = sha256CanonicalJson({
      status,
      items: items.map((item) => ({
        ordinal: item.ordinal,
        role: item.role,
        sourceUrlHash: sha256CanonicalJson({ url: item.sourceUrl }),
        archiveStatus: item.archiveStatus,
        assetId: item.assetId,
        actualMime: item.actualMime,
        failureClass: item.failureClass,
      })),
    });
    const nextAttemptAt =
      status === 'COMPLETE' || status === 'CHECKED_NONE' || retryableCount === 0
        ? null
        : retryAt({
            attemptCount: gate.attemptCount,
            firstAttemptAt: gate.firstAttemptAt ?? dbNow,
            repairUntilAt: gate.repairUntilAt,
            dbNow,
          });
    const repairExhaustedAt =
      status === 'COMPLETE' || status === 'CHECKED_NONE' || nextAttemptAt
        ? null
        : sourceMediaRepairExhaustionTimestamp({
            dbNow,
            releaseDeadlineAt: gate.releaseDeadlineAt,
          });

    await tx
      .update(contentSourceMediaGates)
      .set({
        status,
        nextAttemptAt,
        repairExhaustedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: status === 'COMPLETE' || status === 'CHECKED_NONE' ? dbNow : null,
        archivedCount,
        rejectedCount,
        mediaStateHash,
        lastFailureClass: status === 'UNAVAILABLE' ? 'MEDIA_ARCHIVE_UNAVAILABLE' : null,
        lastFailureHash: status === 'UNAVAILABLE' ? failureHash('MEDIA_ARCHIVE_UNAVAILABLE') : null,
        updatedAt: dbNow,
      })
      .where(eq(contentSourceMediaGates.gateId, input.gateId));

    const baseEvents = await tx
      .select({
        outboxId: contentPipelineOutbox.outboxId,
        status: contentPipelineOutbox.status,
        leaseOwner: contentPipelineOutbox.leaseOwner,
      })
      .from(contentPipelineOutbox)
      .where(
        and(
          eq(contentPipelineOutbox.receiptRevisionId, gate.receiptRevisionId),
          inArray(contentPipelineOutbox.eventType, ['receipt.accepted.v1', 'receipt.updated.v1']),
        ),
      )
      .orderBy(asc(contentPipelineOutbox.createdAt))
      .for('update')
      .limit(1);
    const baseEvent = baseEvents[0];
    let baseEventAdvanced = false;
    if ((status === 'COMPLETE' || status === 'CHECKED_NONE') && baseEvent) {
      const advanced = await tx
        .update(contentPipelineOutbox)
        .set({ availableAt: dbNow, updatedAt: dbNow })
        .where(
          and(
            eq(contentPipelineOutbox.outboxId, baseEvent.outboxId),
            eq(contentPipelineOutbox.status, 'PENDING'),
            isNull(contentPipelineOutbox.leaseOwner),
          ),
        )
        .returning({ outboxId: contentPipelineOutbox.outboxId });
      baseEventAdvanced = advanced.length === 1;
    }
    const baseUnavailable =
      !baseEvent || baseEvent.status === 'DELIVERED' || baseEvent.leaseOwner !== null;
    const stateChanged = gate.mediaStateHash !== mediaStateHash;
    const mediaImproved =
      status === 'COMPLETE' ||
      status === 'CHECKED_NONE' ||
      (status === 'PARTIAL' && archivedCount > gate.archivedCount);
    if (!baseEventAdvanced && baseUnavailable && stateChanged && mediaImproved) {
      await writeMediaUpdateOutbox({
        tx,
        gateId: input.gateId,
        receiptId: gate.receiptId,
        receiptRevisionId: gate.receiptRevisionId,
        mediaStateHash,
        dbNow,
      });
    }
    return { status, retryAt: nextAttemptAt };
  });
}

export async function recordSourceMediaGateFailure(input: {
  gate: ClaimedSourceMediaGate;
  failureClass: string;
  db?: DbHandle;
}): Promise<Date | null> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const dbNow = await databaseNow(tx);
    const gate = await lockedClaimedGate({
      tx,
      gateId: input.gate.gateId,
      workerId: input.gate.leaseOwner,
    });
    const itemCounts = await tx
      .select({
        itemCount: sql<number>`count(*)::integer`,
        archivedCount: sql<number>`count(*) FILTER (WHERE archive_status = 'ARCHIVED')::integer`,
      })
      .from(contentSourceMediaItems)
      .where(eq(contentSourceMediaItems.gateId, input.gate.gateId));
    const counts = itemCounts[0] ?? { itemCount: 0, archivedCount: 0 };
    const status = counts.archivedCount > 0 ? 'PARTIAL' : 'UNAVAILABLE';
    const nextAttemptAt = retryAt({
      attemptCount: gate.attemptCount,
      firstAttemptAt: gate.firstAttemptAt ?? dbNow,
      repairUntilAt: gate.repairUntilAt,
      dbNow,
    });
    await tx
      .update(contentSourceMediaGates)
      .set({
        status,
        nextAttemptAt,
        repairExhaustedAt: nextAttemptAt
          ? null
          : sourceMediaRepairExhaustionTimestamp({
              dbNow,
              releaseDeadlineAt: gate.releaseDeadlineAt,
            }),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastFailureClass: input.failureClass,
        lastFailureHash: failureHash(input.failureClass),
        discoveredCount: counts.itemCount,
        archivedCount: counts.archivedCount,
        updatedAt: dbNow,
      })
      .where(eq(contentSourceMediaGates.gateId, input.gate.gateId));
    return nextAttemptAt;
  });
}

export const sourceMediaRetryOffsetsMs = RETRY_OFFSETS_MS;
