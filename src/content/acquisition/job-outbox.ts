import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  contentAcquisitionJobOutbox,
  contentAcquisitionRuns,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle } from '../../db/singleton';
import { acquisitionJobV1Schema, type AcquisitionJobV1 } from './formal-run-contract';

export type ClaimedAcquisitionJobOutbox = Readonly<{
  outboxId: string;
  owner: string;
  runId: string;
  queueName: 'content-x-scan' | 'content-http-acquisition' | 'content-media-transcript';
  jobId: string;
  priority: number;
  job: AcquisitionJobV1;
}>;

export type AcquisitionQueueName = ClaimedAcquisitionJobOutbox['queueName'];

function dbDate(value: Date | string | undefined): Date {
  const result = value instanceof Date ? value : new Date(value ?? Number.NaN);
  if (!Number.isFinite(result.getTime())) throw new Error('Database clock is invalid');
  return result;
}

function runLeaseMs(adapterKind: string | null): number {
  if (adapterKind === 'X_ACCOUNT' || adapterKind === 'X_SEMANTIC') return 6 * 60_000;
  if (adapterKind === 'HERMES_TRANSCRIPT') return 30 * 60_000;
  return 2 * 60_000;
}

export async function claimAcquisitionJobOutbox(input: {
  limit: number;
  enabledQueueNames?: readonly AcquisitionQueueName[];
  leaseMs?: number;
  db?: DbHandle;
}): Promise<readonly ClaimedAcquisitionJobOutbox[]> {
  if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    throw new Error('Acquisition job outbox claim limit must be an integer from 1 to 100');
  }
  if (input.enabledQueueNames?.length === 0) return [];
  const db = input.db ?? (await getDb());
  const owner = randomUUID();
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dbDate(clockRows[0]?.dbNow);
    const leaseExpiresAt = new Date(dbNow.getTime() + (input.leaseMs ?? 60_000));
    const rows = await tx
      .select({
        outboxId: contentAcquisitionJobOutbox.outboxId,
        runId: contentAcquisitionJobOutbox.runId,
        queueName: contentAcquisitionJobOutbox.queueName,
        jobId: contentAcquisitionJobOutbox.jobId,
        priority: contentAcquisitionJobOutbox.priority,
      })
      .from(contentAcquisitionJobOutbox)
      .where(
        and(
          isNull(contentAcquisitionJobOutbox.deliveredAt),
          input.enabledQueueNames
            ? inArray(contentAcquisitionJobOutbox.queueName, input.enabledQueueNames)
            : undefined,
          lte(contentAcquisitionJobOutbox.availableAt, dbNow),
          or(
            isNull(contentAcquisitionJobOutbox.leaseExpiresAt),
            lte(contentAcquisitionJobOutbox.leaseExpiresAt, dbNow),
          ),
        ),
      )
      .orderBy(
        asc(contentAcquisitionJobOutbox.priority),
        asc(contentAcquisitionJobOutbox.createdAt),
      )
      .limit(input.limit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedAcquisitionJobOutbox[] = [];
    for (const row of rows) {
      const runRows = await tx
        .select({
          status: contentAcquisitionRuns.status,
          adapterKind: contentAcquisitionRuns.adapterKind,
        })
        .from(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.runId, row.runId))
        .for('update')
        .limit(1);
      const run = runRows[0];
      if (!run || run.status !== 'PENDING') {
        await tx
          .update(contentAcquisitionJobOutbox)
          .set({ deliveredAt: dbNow, leaseOwner: null, leaseExpiresAt: null, updatedAt: dbNow })
          .where(eq(contentAcquisitionJobOutbox.outboxId, row.outboxId));
        continue;
      }
      await tx
        .update(contentAcquisitionJobOutbox)
        .set({
          leaseOwner: owner,
          leaseExpiresAt,
          attempts: sql`${contentAcquisitionJobOutbox.attempts} + 1`,
          updatedAt: dbNow,
        })
        .where(eq(contentAcquisitionJobOutbox.outboxId, row.outboxId));
      await tx
        .update(contentAcquisitionRuns)
        .set({ leaseExpiresAt: new Date(dbNow.getTime() + runLeaseMs(run.adapterKind)) })
        .where(eq(contentAcquisitionRuns.runId, row.runId));
      claimed.push({
        outboxId: row.outboxId,
        owner,
        runId: row.runId,
        queueName: row.queueName as ClaimedAcquisitionJobOutbox['queueName'],
        jobId: row.jobId,
        priority: row.priority,
        job: acquisitionJobV1Schema.parse({ schemaVersion: 1, runId: row.runId }),
      });
    }
    return claimed;
  });
}

export async function confirmAcquisitionJobOutbox(input: {
  outboxId: string;
  owner: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dbDate(clockRows[0]?.dbNow);
    const updated = await tx
      .update(contentAcquisitionJobOutbox)
      .set({
        deliveredAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorHash: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentAcquisitionJobOutbox.outboxId, input.outboxId),
          eq(contentAcquisitionJobOutbox.leaseOwner, input.owner),
          isNull(contentAcquisitionJobOutbox.deliveredAt),
        ),
      )
      .returning({ runId: contentAcquisitionJobOutbox.runId });
    const row = updated[0];
    if (!row) return false;
    await tx
      .update(contentAcquisitionRuns)
      .set({ enqueueConfirmedAt: dbNow })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, row.runId),
          or(
            eq(contentAcquisitionRuns.status, 'PENDING'),
            eq(contentAcquisitionRuns.status, 'RUNNING'),
          ),
        ),
      );
    return true;
  });
}

export async function releaseAcquisitionJobOutbox(input: {
  outboxId: string;
  owner: string;
  errorSummary: string;
  retryDelayMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dbDate(clockRows[0]?.dbNow);
    const updated = await tx
      .update(contentAcquisitionJobOutbox)
      .set({
        leaseOwner: null,
        leaseExpiresAt: null,
        availableAt: new Date(dbNow.getTime() + (input.retryDelayMs ?? 60_000)),
        lastErrorHash: createHash('sha256').update(input.errorSummary, 'utf8').digest('hex'),
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(contentAcquisitionJobOutbox.outboxId, input.outboxId),
          eq(contentAcquisitionJobOutbox.leaseOwner, input.owner),
          isNull(contentAcquisitionJobOutbox.deliveredAt),
        ),
      )
      .returning({ runId: contentAcquisitionJobOutbox.runId });
    const row = updated[0];
    if (!row) return false;
    await tx
      .update(contentAcquisitionRuns)
      .set({ leaseExpiresAt: null })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, row.runId),
          eq(contentAcquisitionRuns.status, 'PENDING'),
        ),
      );
    return true;
  });
}

export async function dispatchAcquisitionJobOutbox(input: {
  enqueue: (job: ClaimedAcquisitionJobOutbox) => Promise<unknown>;
  enabledQueueNames?: readonly AcquisitionQueueName[];
  limit?: number;
  db?: DbHandle;
}): Promise<{ claimed: number; delivered: number; failed: number }> {
  const claimed = await claimAcquisitionJobOutbox({
    limit: input.limit ?? 20,
    enabledQueueNames: input.enabledQueueNames,
    db: input.db,
  });
  let delivered = 0;
  let failed = 0;
  await Promise.all(
    claimed.map(async (job) => {
      try {
        await input.enqueue(job);
        if (
          await confirmAcquisitionJobOutbox({
            outboxId: job.outboxId,
            owner: job.owner,
            db: input.db,
          })
        ) {
          delivered += 1;
        }
      } catch (error) {
        failed += 1;
        await releaseAcquisitionJobOutbox({
          outboxId: job.outboxId,
          owner: job.owner,
          errorSummary: error instanceof Error ? error.message : 'Acquisition enqueue failed',
          db: input.db,
        });
      }
    }),
  );
  return { claimed: claimed.length, delivered, failed };
}
