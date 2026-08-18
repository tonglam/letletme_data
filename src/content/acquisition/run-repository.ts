import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';

import { getDb } from '../../db/singleton';
import {
  contentAcquisitionBudgets,
  contentAcquisitionCheckpoints,
  contentAcquisitionCosts,
  contentAcquisitionRuns,
  contentAcquisitionRunXTraces,
  contentSourceReceipts,
} from '../../db/schemas/content.schema';
import type { GrokRunResult } from './grok-runner';
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

const dateOnly = (value: string): string => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`Invalid acquisition date: ${value}`);
  return new Date(time).toISOString().slice(0, 10);
};

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
}): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.dailyBudget) ||
    input.dailyBudget < 1 ||
    !Number.isSafeInteger(input.requestedXCalls) ||
    input.requestedXCalls < 1 ||
    input.requestedXCalls > input.dailyBudget
  )
    return false;
  const db = await getDb();
  const budgetDate = dateOnly(input.windowStart);
  await db
    .insert(contentAcquisitionBudgets)
    .values({
      budgetId: randomUUID(),
      groupId: input.groupId,
      budgetDate,
      maxXCalls: input.dailyBudget,
      usedXCalls: 0,
    })
    .onConflictDoNothing({
      target: [contentAcquisitionBudgets.groupId, contentAcquisitionBudgets.budgetDate],
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
  const state = resultState(input.result);
  const checkpointAdvanced =
    input.result.traceVerified === true &&
    (input.result.status === 'EMPTY' || input.result.status === 'COMPLETED');
  const sourceIds = new Set(input.run.sourceSnapshot.map((source) => source.sourceId));
  const now = new Date();

  const db = await getDb();
  const receiptValues = input.result.receipts.flatMap((value) => {
    const receipt = asJsonObject(value);
    const sourceId = typeof receipt.sourceId === 'string' ? receipt.sourceId : null;
    const externalId = typeof receipt.externalId === 'string' ? receipt.externalId : null;
    const canonicalUrl = typeof receipt.canonicalUrl === 'string' ? receipt.canonicalUrl : null;
    if (!sourceId || !sourceIds.has(sourceId) || !externalId || !canonicalUrl) return [];
    const capturedAt =
      typeof receipt.capturedAt === 'string' ? Date.parse(receipt.capturedAt) : NaN;
    const publishedAt =
      typeof receipt.publishedAt === 'string' ? Date.parse(receipt.publishedAt) : NaN;
    return [
      {
        receiptId: randomUUID(),
        runId: input.run.runId,
        sourceId,
        externalId,
        canonicalUrl,
        capturedAt: Number.isFinite(capturedAt) ? new Date(capturedAt) : now,
        publishedAt: Number.isFinite(publishedAt) ? new Date(publishedAt) : null,
        payload: asJsonObject(receipt.payload),
        canonicalHash: typeof receipt.canonicalHash === 'string' ? receipt.canonicalHash : '',
        rightsPolicy: asJsonObject(receipt.rightsPolicy),
      },
    ];
  });

  await db.transaction(async (tx) => {
    if (receiptValues.length > 0) {
      await tx
        .insert(contentSourceReceipts)
        .values(receiptValues)
        .onConflictDoNothing({
          target: [contentSourceReceipts.sourceId, contentSourceReceipts.externalId],
        });
    }
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: state,
        xCallCount: input.result.xCallCount,
        traceVerified: input.result.traceVerified,
        skillSha: input.result.skillSha || null,
        adapterVersion: input.result.adapterVersion ?? null,
        errorSummary: input.result.error ?? null,
        checkpointAdvanced,
        completedAt: now,
      })
      .where(eq(contentAcquisitionRuns.runId, input.run.runId));
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
        });
    }
  });

  return { status: state, checkpointAdvanced, receiptCount: receiptValues.length };
}
