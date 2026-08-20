import { createHash, randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';

import { getDb } from '../../db/singleton';
import {
  contentAcquisitionBudgets,
  contentAcquisitionCheckpoints,
  contentAcquisitionCosts,
  contentAcquisitionRuns,
  contentAcquisitionRunXTraces,
  contentSourceReceipts,
} from '../../db/schemas/content.schema';
import { isValidGrokReceipt, type GrokRunResult } from './grok-runner';
import type { SourceSnapshotItem } from './source-registry';

export type AcquisitionRunInput = Readonly<{
  runId: string;
  groupId: string;
  partitionKey: string;
  mode: 'poll' | 'enrich' | 'compose';
  windowStart: string;
  windowEnd: string;
  idempotencyKey: string;
  sourceSnapshotRevision: string;
  sourceSnapshot: readonly SourceSnapshotItem[];
  skillSha?: string | null;
}>;

export type AcquisitionRunState =
  | 'pending'
  | 'running'
  | 'empty'
  | 'partial'
  | 'failed'
  | 'completed';

export const ACQUISITION_RUN_STALE_AFTER_MS = 5 * 60_000;

export function isAcquisitionRunStale(input: {
  startedAt?: Date | null;
  createdAt: Date;
  now?: Date;
  staleAfterMs?: number;
}): boolean {
  const now = (input.now ?? new Date()).getTime();
  const anchor = (input.startedAt ?? input.createdAt).getTime();
  const staleAfterMs = input.staleAfterMs ?? ACQUISITION_RUN_STALE_AFTER_MS;
  return Number.isFinite(anchor) && now >= anchor && now - anchor >= staleAfterMs;
}

export async function reclaimStaleAcquisitionRuns(input: {
  groupId: string;
  partitionKey: string;
  mode: 'poll' | 'enrich' | 'compose';
  now?: Date;
  staleAfterMs?: number;
}): Promise<number> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - (input.staleAfterMs ?? ACQUISITION_RUN_STALE_AFTER_MS));
  const db = await getDb();
  const reclaimed = await db
    .update(contentAcquisitionRuns)
    .set({
      status: 'failed',
      traceVerified: false,
      checkpointAdvanced: false,
      errorSummary: 'Acquisition run lease expired; reclaimed by scheduler',
      completedAt: now,
    })
    .where(
      and(
        eq(contentAcquisitionRuns.groupId, input.groupId),
        eq(contentAcquisitionRuns.partitionKey, input.partitionKey),
        eq(contentAcquisitionRuns.mode, input.mode),
        inArray(contentAcquisitionRuns.status, ['pending', 'running']),
        or(
          lt(contentAcquisitionRuns.startedAt, cutoff),
          and(
            isNull(contentAcquisitionRuns.startedAt),
            lt(contentAcquisitionRuns.createdAt, cutoff),
          ),
        ),
      ),
    )
    .returning({ runId: contentAcquisitionRuns.runId });
  return reclaimed.length;
}

const asJsonObject = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

function resultState(result: GrokRunResult): AcquisitionRunState {
  if (result.status === 'EMPTY') return 'empty';
  if (result.status === 'PARTIAL') return 'partial';
  if (result.status === 'COMPLETED') return 'completed';
  return 'failed';
}

export async function beginAcquisitionRun(input: AcquisitionRunInput): Promise<{
  runId: string;
  reused: boolean;
  status: AcquisitionRunState;
}> {
  const db = await getDb();
  const inserted = await db
    .insert(contentAcquisitionRuns)
    .values({
      runId: input.runId,
      groupId: input.groupId,
      mode: input.mode,
      partitionKey: input.partitionKey,
      windowStart: new Date(input.windowStart),
      windowEnd: new Date(input.windowEnd),
      idempotencyKey: input.idempotencyKey,
      status: 'running',
      sourceSnapshot: input.sourceSnapshot,
      sourceSnapshotRevision: input.sourceSnapshotRevision,
      skillSha: input.skillSha ?? null,
      startedAt: new Date(),
    })
    .onConflictDoNothing({ target: contentAcquisitionRuns.idempotencyKey })
    .returning({ runId: contentAcquisitionRuns.runId, status: contentAcquisitionRuns.status });
  if (inserted[0])
    return { ...inserted[0], status: inserted[0].status as AcquisitionRunState, reused: false };

  const existing = await db
    .select({ runId: contentAcquisitionRuns.runId, status: contentAcquisitionRuns.status })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.idempotencyKey, input.idempotencyKey))
    .limit(1);
  const row = existing[0];
  if (!row) throw new Error('Acquisition run disappeared after idempotency conflict');
  return { ...row, status: row.status as AcquisitionRunState, reused: true };
}

export async function reserveXCallBudget(input: {
  groupId: string;
  windowStart: string;
  dailyBudget: number;
  requestedXCalls: number;
  budgetScope?: 'daily' | 'final90';
  phaseBudget?: number | null;
}): Promise<boolean> {
  const budgetScope = input.budgetScope ?? 'daily';
  const budgetLimit = budgetScope === 'final90' ? (input.phaseBudget ?? 0) : input.dailyBudget;
  if (
    !Number.isSafeInteger(budgetLimit) ||
    budgetLimit < 1 ||
    !Number.isSafeInteger(input.requestedXCalls) ||
    input.requestedXCalls < 1 ||
    input.requestedXCalls > budgetLimit
  )
    return false;
  const db = await getDb();
  // Budget consumption belongs to the database's current UTC day, not the
  // historical acquisition window.  Retries/catch-up runs must not spend a
  // different day's allowance merely because their windowStart is old.
  const clockRows = await db.execute<{ utc_date: string }>(
    sql`SELECT (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date::text AS utc_date`,
  );
  const clock = clockRows[0];
  const budgetDate = clock?.utc_date;
  if (!budgetDate) throw new Error('Database UTC date is unavailable');
  await db
    .insert(contentAcquisitionBudgets)
    .values({
      budgetId: randomUUID(),
      groupId: input.groupId,
      budgetDate,
      budgetScope,
      maxXCalls: budgetLimit,
      usedXCalls: 0,
    })
    .onConflictDoUpdate({
      target: [
        contentAcquisitionBudgets.groupId,
        contentAcquisitionBudgets.budgetDate,
        contentAcquisitionBudgets.budgetScope,
      ],
      set: { maxXCalls: budgetLimit, updatedAt: new Date() },
    });
  const updated = await db
    .update(contentAcquisitionBudgets)
    .set({
      usedXCalls: sql`${contentAcquisitionBudgets.usedXCalls} + ${input.requestedXCalls}`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(contentAcquisitionBudgets.groupId, input.groupId),
        eq(contentAcquisitionBudgets.budgetDate, budgetDate),
        eq(contentAcquisitionBudgets.budgetScope, budgetScope),
        sql`${contentAcquisitionBudgets.usedXCalls} + ${input.requestedXCalls} <= ${contentAcquisitionBudgets.maxXCalls}`,
      ),
    )
    .returning({ budgetId: contentAcquisitionBudgets.budgetId });
  return updated.length === 1;
}

export async function finishAcquisitionRun(input: {
  run: AcquisitionRunInput;
  result: GrokRunResult;
  checkpointCursor?: string | null;
}): Promise<{ status: AcquisitionRunState; checkpointAdvanced: boolean; receiptCount: number }> {
  const receiptsSchemaValid = input.result.receipts.every((receipt) => isValidGrokReceipt(receipt));
  const state = receiptsSchemaValid ? resultState(input.result) : 'failed';
  const sourceIds = new Set(input.run.sourceSnapshot.map((source) => source.sourceId));
  const rightsBySourceId = new Map(
    input.run.sourceSnapshot.map((source) => [source.sourceId, source.rightsPolicy ?? {}]),
  );
  const now = new Date();

  const db = await getDb();
  const receiptValues = input.result.receipts.flatMap((value) => {
    if (!receiptsSchemaValid) return [];
    const receipt = asJsonObject(value);
    const sourceId = typeof receipt.sourceId === 'string' ? receipt.sourceId : null;
    const externalId = typeof receipt.externalId === 'string' ? receipt.externalId : null;
    const canonicalUrl = typeof receipt.canonicalUrl === 'string' ? receipt.canonicalUrl : null;
    if (!sourceId || !sourceIds.has(sourceId) || !externalId || !canonicalUrl) return [];
    const capturedAt =
      typeof receipt.capturedAt === 'string' ? Date.parse(receipt.capturedAt) : NaN;
    if (!Number.isFinite(capturedAt)) return [];
    const publishedAt =
      typeof receipt.publishedAt === 'string' ? Date.parse(receipt.publishedAt) : NaN;
    return [
      {
        receiptId: randomUUID(),
        runId: input.run.runId,
        sourceId,
        externalId,
        canonicalUrl,
        capturedAt: new Date(capturedAt),
        publishedAt: Number.isFinite(publishedAt) ? new Date(publishedAt) : null,
        payload: asJsonObject(receipt.payload),
        canonicalHash: typeof receipt.canonicalHash === 'string' ? receipt.canonicalHash : '',
        rightsPolicy: rightsBySourceId.get(sourceId) ?? {},
      },
    ];
  });
  const checkpointAdvanced =
    receiptsSchemaValid &&
    input.result.traceVerified === true &&
    ((input.result.status === 'EMPTY' && input.result.receipts.length === 0) ||
      (input.result.status === 'COMPLETED' &&
        receiptValues.length === input.result.receipts.length &&
        receiptValues.length > 0) ||
      (input.result.status === 'PARTIAL' &&
        asJsonObject(input.result.traceMetadata).completePartition === true &&
        receiptValues.length === input.result.receipts.length &&
        receiptValues.length > 0));

  const finished = await db.transaction(async (tx) => {
    const claimed = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: state,
        xCallCount: input.result.xCallCount,
        traceVerified: input.result.traceVerified && receiptsSchemaValid,
        skillSha: input.result.skillSha || null,
        adapterVersion: input.result.adapterVersion ?? null,
        errorSummary:
          input.result.error ?? (receiptsSchemaValid ? null : 'Invalid Grok receipt schema'),
        checkpointAdvanced,
        completedAt: now,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.run.runId),
          inArray(contentAcquisitionRuns.status, ['pending', 'running']),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    if (claimed.length === 0)
      return { status: 'failed' as const, checkpointAdvanced: false, receiptCount: 0 };

    if (receiptValues.length > 0) {
      await tx
        .insert(contentSourceReceipts)
        .values(receiptValues)
        .onConflictDoNothing({
          target: [contentSourceReceipts.sourceId, contentSourceReceipts.externalId],
        });
    }
    await tx
      .insert(contentAcquisitionRunXTraces)
      .values({
        runId: input.run.runId,
        toolName: input.result.toolName ?? 'unknown',
        skillSha: input.result.skillSha || 'unknown',
        adapterVersion: input.result.adapterVersion ?? 'unknown',
        requestHash: input.result.requestHash ?? sha256(input.run.idempotencyKey),
        responseHash: input.result.responseHash ?? null,
        callCount: input.result.xCallCount,
        traceMetadata: input.result.traceMetadata ?? {},
        verified: input.result.traceVerified === true,
      })
      .onConflictDoUpdate({
        target: contentAcquisitionRunXTraces.runId,
        set: {
          toolName: input.result.toolName ?? 'unknown',
          skillSha: input.result.skillSha || 'unknown',
          adapterVersion: input.result.adapterVersion ?? 'unknown',
          requestHash: input.result.requestHash ?? sha256(input.run.idempotencyKey),
          responseHash: input.result.responseHash ?? null,
          callCount: input.result.xCallCount,
          traceMetadata: input.result.traceMetadata ?? {},
          verified: input.result.traceVerified === true,
          capturedAt: now,
        },
      });
    if (input.result.costMicros !== undefined || input.result.costUnits !== undefined) {
      await tx.insert(contentAcquisitionCosts).values({
        costId: randomUUID(),
        runId: input.run.runId,
        provider: input.result.toolName ?? 'grok',
        amountMicros: input.result.costMicros ?? 0,
        currency: input.result.costCurrency ?? 'USD',
        units: input.result.costUnits ?? input.result.xCallCount,
        metadata: { skillSha: input.result.skillSha || null },
      });
    }
    if (checkpointAdvanced) {
      await tx
        .insert(contentAcquisitionCheckpoints)
        .values({
          groupId: input.run.groupId,
          partitionKey: input.run.partitionKey,
          cursor: input.checkpointCursor ?? null,
          sourceSnapshotRevision: input.run.sourceSnapshotRevision,
          windowEnd: new Date(input.run.windowEnd),
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            contentAcquisitionCheckpoints.groupId,
            contentAcquisitionCheckpoints.partitionKey,
          ],
          set: {
            cursor: input.checkpointCursor ?? null,
            sourceSnapshotRevision: input.run.sourceSnapshotRevision,
            windowEnd: new Date(input.run.windowEnd),
            updatedAt: now,
          },
          // A late/overlapping run must never move a checkpoint backwards.
          where: sql`${contentAcquisitionCheckpoints.windowEnd} < EXCLUDED.window_end`,
        });
    }
    return { status: state, checkpointAdvanced, receiptCount: receiptValues.length };
  });

  return finished;
}
