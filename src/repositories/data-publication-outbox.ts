import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  dataPublicationOutboxInOps,
  datasetPublicationItemsInOps,
  datasetPublicationsInOps,
  syncRunsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import {
  activateDataPublicationPointer,
  parseDataPublicationManifest,
  stageDataPublication,
  type DataPublicationDeliveryItem,
  type DataPublicationManifest,
} from '../cache/data-publication';
import { canonicalJson, postgresJsonbCanonicalJson } from '../utils/content-hash';
import { logError } from '../utils/logger';

type DatabaseClock = Date | string;

function asDate(value: DatabaseClock | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (!Number.isFinite(date.getTime())) throw new Error('Database clock is invalid');
  return date;
}

export type ClaimedDataPublicationOutbox = Readonly<{
  outboxId: string;
  owner: string;
  publicationId: string;
  manifest: DataPublicationManifest;
  items: readonly DataPublicationDeliveryItem[];
}>;

async function loadPreparedPublication(
  db: DbOrTransaction,
  publicationId: string,
  manifestValue: unknown,
): Promise<{ manifest: DataPublicationManifest; items: readonly DataPublicationDeliveryItem[] }> {
  const manifest = parseDataPublicationManifest(JSON.stringify(manifestValue));
  if (!manifest) throw new Error(`Publication ${publicationId} has an invalid manifest`);
  const rows = await db
    .select({
      itemName: datasetPublicationItemsInOps.itemName,
      payload: datasetPublicationItemsInOps.payload,
      itemCount: datasetPublicationItemsInOps.itemCount,
      checksum: datasetPublicationItemsInOps.checksum,
    })
    .from(datasetPublicationItemsInOps)
    .where(eq(datasetPublicationItemsInOps.publicationId, publicationId));
  const items: DataPublicationDeliveryItem[] = [];
  for (const itemManifest of manifest.items) {
    const row = rows.find((candidate) => candidate.itemName === itemManifest.name);
    if (!row) throw new Error(`Publication ${publicationId} is missing ${itemManifest.name}`);
    const payloadCandidates = [
      manifest.dataset === 'fpl:live'
        ? postgresJsonbCanonicalJson(row.payload)
        : canonicalJson(row.payload),
      JSON.stringify(row.payload),
      postgresJsonbCanonicalJson(row.payload),
    ];
    const payload = payloadCandidates.find(
      (candidate) =>
        Buffer.byteLength(candidate, 'utf8') === itemManifest.bytes &&
        createSha256(candidate) === itemManifest.sha256 &&
        row.checksum === itemManifest.sha256,
    );
    if (!payload) {
      throw new Error(`Publication ${publicationId} has invalid proof for ${itemManifest.name}`);
    }
    items.push({ manifest: itemManifest, payload });
  }
  return { manifest, items };
}

export async function loadDataPublicationDelivery(publicationId: string): Promise<{
  readonly manifest: DataPublicationManifest;
  readonly items: readonly DataPublicationDeliveryItem[];
}> {
  const db = await getDb();
  const rows = await db
    .select({ manifest: datasetPublicationsInOps.manifest })
    .from(datasetPublicationsInOps)
    .where(eq(datasetPublicationsInOps.publicationId, publicationId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`Publication ${publicationId} does not exist`);
  return loadPreparedPublication(db, publicationId, row.manifest);
}

function createSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export async function claimDataPublicationOutbox(input: {
  limit?: number;
  leaseMs?: number;
  publicationId?: string;
  db?: DbHandle;
}): Promise<readonly ClaimedDataPublicationOutbox[]> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Data publication outbox claim limit must be between 1 and 100');
  }
  const leaseMs = input.leaseMs ?? 60_000;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Data publication outbox lease must be positive');
  }
  const db = input.db ?? (await getDb());
  const owner = randomUUID();
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: DatabaseClock }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(clockRows[0]?.dbNow);
    const leaseExpiresAt = new Date(dbNow.getTime() + leaseMs);
    const rows = await tx
      .select({
        outboxId: dataPublicationOutboxInOps.outboxId,
        publicationId: dataPublicationOutboxInOps.publicationId,
        manifest: dataPublicationOutboxInOps.manifest,
      })
      .from(dataPublicationOutboxInOps)
      .where(
        and(
          input.publicationId
            ? eq(dataPublicationOutboxInOps.publicationId, input.publicationId)
            : undefined,
          isNull(dataPublicationOutboxInOps.deliveredAt),
          lte(dataPublicationOutboxInOps.availableAt, dbNow),
          or(
            isNull(dataPublicationOutboxInOps.leaseExpiresAt),
            lte(dataPublicationOutboxInOps.leaseExpiresAt, dbNow),
          ),
          inArray(dataPublicationOutboxInOps.status, [
            'pending',
            'staged',
            'db_activated',
            'redis_activated',
          ]),
        ),
      )
      .orderBy(
        asc(dataPublicationOutboxInOps.availableAt),
        asc(dataPublicationOutboxInOps.outboxId),
      )
      .limit(limit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedDataPublicationOutbox[] = [];
    for (const row of rows) {
      await tx
        .update(dataPublicationOutboxInOps)
        .set({
          leaseOwner: owner,
          leaseExpiresAt,
          attempts: sql`${dataPublicationOutboxInOps.attempts} + 1`,
          updatedAt: dbNow,
        })
        .where(eq(dataPublicationOutboxInOps.outboxId, row.outboxId));
      const prepared = await loadPreparedPublication(tx, row.publicationId, row.manifest);
      claimed.push({
        outboxId: row.outboxId,
        owner,
        publicationId: row.publicationId,
        ...prepared,
      });
    }
    return claimed;
  });
}

export async function markDataPublicationOutboxDelivered(input: {
  outboxId: string;
  owner: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(dataPublicationOutboxInOps)
      .set({
        status: 'delivered',
        deliveredAt: sql`clock_timestamp()`,
        redisActivatedAt: sql`coalesce(${dataPublicationOutboxInOps.redisActivatedAt}, clock_timestamp())`,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(dataPublicationOutboxInOps.outboxId, input.outboxId),
          eq(dataPublicationOutboxInOps.leaseOwner, input.owner),
          isNull(dataPublicationOutboxInOps.deliveredAt),
        ),
      )
      .returning({
        outboxId: dataPublicationOutboxInOps.outboxId,
        publicationId: dataPublicationOutboxInOps.publicationId,
        sourceRunId: dataPublicationOutboxInOps.sourceRunId,
      });
    const row = updated[0];
    if (!row) return false;
    // A source run becomes published only after the Redis pointer has been
    // CAS-activated and the durable outbox receipt is committed.  This keeps
    // DB-only activation visible as ready_to_publish rather than a false
    // success if the process dies between the two stores.
    if (row.sourceRunId) {
      await tx
        .update(syncRunsInOps)
        .set({
          status: 'published',
          publicationId: row.publicationId,
          completedAt: sql`coalesce(${syncRunsInOps.completedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(syncRunsInOps.runId, row.sourceRunId),
            inArray(syncRunsInOps.status, ['ready_to_publish', 'published']),
          ),
        );
    }
    return true;
  });
}

/**
 * Close an outbox receipt after a reconciler has compare-and-swap repaired the
 * Redis pointer directly.  This is intentionally separate from the leased
 * dispatcher acknowledgement: the dispatcher must never mark a row delivered
 * before it has performed the CAS, while a reconciler may inherit a row whose
 * lease expired or was marked failed because Redis temporarily pointed at a
 * newer ghost publication.  The caller must invoke this only after the CAS
 * has succeeded against the expected Redis manifest.
 */
export async function markDataPublicationOutboxReconciled(input: {
  publicationId: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(dataPublicationOutboxInOps)
      .set({
        status: 'delivered',
        deliveredAt: sql`coalesce(${dataPublicationOutboxInOps.deliveredAt}, clock_timestamp())`,
        redisActivatedAt: sql`coalesce(${dataPublicationOutboxInOps.redisActivatedAt}, clock_timestamp())`,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(dataPublicationOutboxInOps.publicationId, input.publicationId),
          isNull(dataPublicationOutboxInOps.deliveredAt),
          inArray(dataPublicationOutboxInOps.status, [
            'pending',
            'staged',
            'db_activated',
            'redis_activated',
            'failed',
          ]),
        ),
      )
      .returning({
        publicationId: dataPublicationOutboxInOps.publicationId,
        sourceRunId: dataPublicationOutboxInOps.sourceRunId,
      });
    const row = updated[0];
    if (!row) return false;
    if (row.sourceRunId) {
      await tx
        .update(syncRunsInOps)
        .set({
          status: 'published',
          publicationId: row.publicationId,
          completedAt: sql`coalesce(${syncRunsInOps.completedAt}, clock_timestamp())`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(syncRunsInOps.runId, row.sourceRunId),
            inArray(syncRunsInOps.status, ['ready_to_publish', 'published']),
          ),
        );
    }
    return true;
  });
}

async function markDataPublicationOutboxStage(input: {
  outboxId: string;
  owner: string;
  status: 'staged' | 'redis_activated';
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(dataPublicationOutboxInOps)
    .set(
      input.status === 'staged'
        ? {
            status: 'staged',
            stagedAt: sql`coalesce(${dataPublicationOutboxInOps.stagedAt}, clock_timestamp())`,
            updatedAt: sql`clock_timestamp()`,
          }
        : {
            status: 'redis_activated',
            redisActivatedAt: sql`coalesce(${dataPublicationOutboxInOps.redisActivatedAt}, clock_timestamp())`,
            updatedAt: sql`clock_timestamp()`,
          },
    )
    .where(
      and(
        eq(dataPublicationOutboxInOps.outboxId, input.outboxId),
        eq(dataPublicationOutboxInOps.leaseOwner, input.owner),
        isNull(dataPublicationOutboxInOps.deliveredAt),
      ),
    )
    .returning({ outboxId: dataPublicationOutboxInOps.outboxId });
  return updated.length === 1;
}

export async function releaseDataPublicationOutbox(input: {
  outboxId: string;
  owner: string;
  error: unknown;
  retryDelayMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const retryDelayMs = Math.max(0, Math.floor(input.retryDelayMs ?? 60_000));
  const updated = await db
    .update(dataPublicationOutboxInOps)
    .set({
      status: 'pending',
      availableAt: sql`clock_timestamp() + ${retryDelayMs} * interval '1 millisecond'`,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: message.slice(0, 4_000),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataPublicationOutboxInOps.outboxId, input.outboxId),
        eq(dataPublicationOutboxInOps.leaseOwner, input.owner),
        isNull(dataPublicationOutboxInOps.deliveredAt),
      ),
    )
    .returning({ outboxId: dataPublicationOutboxInOps.outboxId });
  return updated.length === 1;
}

async function failDataPublicationOutbox(input: {
  outboxId: string;
  owner: string;
  error: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  const updated = await db
    .update(dataPublicationOutboxInOps)
    .set({
      status: 'failed',
      leaseOwner: null,
      leaseExpiresAt: null,
      lastError: message.slice(0, 4_000),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataPublicationOutboxInOps.outboxId, input.outboxId),
        eq(dataPublicationOutboxInOps.leaseOwner, input.owner),
        isNull(dataPublicationOutboxInOps.deliveredAt),
      ),
    )
    .returning({ outboxId: dataPublicationOutboxInOps.outboxId });
  return updated.length === 1;
}

export async function dispatchDataPublicationOutbox(
  input: {
    limit?: number;
    publicationId?: string;
    db?: DbHandle;
  } = {},
): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimed = await claimDataPublicationOutbox(input);
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    claimed.map(async (row) => {
      try {
        // Canonical DB activation happened before this dispatcher was called.
        // Redis is staged and CAS-activated only after the proof is complete.
        await stageDataPublication({ manifest: row.manifest, items: row.items });
        if (
          !(await markDataPublicationOutboxStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'staged',
          }))
        ) {
          throw new Error(`Outbox lease lost while staging ${row.outboxId}`);
        }
        const activation = await activateDataPublicationPointer(row.manifest);
        if (activation.status === 'stale') {
          throw new Error(
            `Redis publication is newer than canonical publication ${row.publicationId}; reconciliation required`,
          );
        }
        if (
          !(await markDataPublicationOutboxStage({
            outboxId: row.outboxId,
            owner: row.owner,
            status: 'redis_activated',
          }))
        ) {
          throw new Error(`Outbox lease lost while activating ${row.outboxId}`);
        }
        if (await markDataPublicationOutboxDelivered(row)) delivered += 1;
      } catch (error) {
        failed += 1;
        logError('Data publication outbox delivery failed', error, {
          outboxId: row.outboxId,
          publicationId: row.publicationId,
        });
        if (error instanceof Error && error.message.includes('Redis publication is newer')) {
          // The DB publication is superseded; retrying this immutable outbox
          // row forever would create a stuck/overdue obligation and can never
          // legitimately move the pointer backwards.
          await failDataPublicationOutbox({ outboxId: row.outboxId, owner: row.owner, error });
        } else {
          await releaseDataPublicationOutbox({ outboxId: row.outboxId, owner: row.owner, error });
        }
      }
    }),
  );
  return { claimed: claimed.length, delivered, failed };
}
