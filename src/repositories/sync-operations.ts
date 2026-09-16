import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  datasetPublicationItemsInOps,
  datasetPublicationsInOps,
  dataPublicationOutboxInOps,
  syncItemsInOps,
  syncRunsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  isDataPublicationId,
  parseDataPublicationManifest,
  type DataPublicationDataset,
  type DataPublicationManifest,
} from '../cache/data-publication';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';

export type SyncRunStatus =
  | 'pending'
  | 'running'
  | 'failed'
  | 'completed'
  | 'ready_to_publish'
  | 'published'
  | 'skipped';

export type SyncItemStatus = 'pending' | 'running' | 'failed' | 'completed' | 'skipped';

export interface StartSyncRunInput {
  readonly runId?: string;
  readonly provider: string;
  readonly lane: string;
  readonly scope: string;
  readonly season?: FplSeasonRef;
  readonly eventId?: number;
  readonly mode: string;
  readonly trigger: string;
  readonly expectedItems?: number;
  readonly metadata?: Record<string, unknown>;
  readonly startedAt?: Date;
}

export interface SyncItemInput {
  readonly resourceType: string;
  readonly resourceId: string;
  readonly status: SyncItemStatus;
  readonly attempts?: number;
  readonly sourceHash?: string | null;
  readonly normalizedPayload?: Record<string, unknown> | null;
  readonly lastError?: string | null;
  readonly completedAt?: Date | null;
}

export interface RecordSyncBatchCostInput {
  /** Stable idempotency key for one delivered execution attempt. */
  readonly attemptKey: string;
  readonly batchId: string;
  readonly parentRunId?: string | null;
  readonly releaseSha: string;
  readonly attempt: number;
  readonly complete: boolean;
  readonly payload: Record<string, unknown>;
}

export interface RecordSyncBatchCostStartInput {
  /** Stable idempotency key for one delivered execution attempt. */
  readonly attemptKey: string;
  readonly batchId: string;
  readonly parentRunId?: string | null;
  readonly releaseSha: string;
  readonly attempt: number;
  readonly payload: Record<string, unknown>;
}

export interface PreparePublicationInput {
  readonly publicationId?: string;
  readonly dataset: DataPublicationDataset;
  readonly season: FplSeasonRef;
  readonly eventId?: number;
  readonly sourceRunId: string;
  readonly manifest?: Record<string, unknown>;
}

export interface PreparedDatasetPublication {
  readonly publicationId: string;
  readonly revision: number;
  readonly status: string;
}

export interface DatasetPublicationItemInput {
  readonly name:
    | 'context'
    | 'events'
    | 'teams'
    | 'players'
    | 'phases'
    | 'fixtures'
    | 'currentEventId'
    | 'selectionRules'
    | 'eventLive';
  readonly payload: unknown;
  readonly count: number;
  readonly checksum: string;
}

const NON_TERMINAL_RUN_STATUSES: readonly SyncRunStatus[] = [
  'pending',
  'running',
  'ready_to_publish',
];
const EXPIRED_PUBLICATION_CLEANUP_BATCH_SIZE = 100;
const SYNC_BATCH_COST_RESOURCE_TYPE = 'batch-cost';

function nullableValue<T>(value: T | undefined): T | null {
  return value ?? null;
}

function assertPublicationManifest(
  manifest: DataPublicationManifest,
  input: {
    publicationId: string;
    dataset: DataPublicationDataset;
    season: FplSeasonRef;
    eventId?: number;
    revision: number;
  },
): void {
  if (
    manifest.publicationId !== input.publicationId ||
    manifest.dataset !== input.dataset ||
    manifest.seasonCode !== input.season.seasonCode ||
    manifest.eventId !== (input.eventId ?? null) ||
    manifest.revision !== input.revision
  ) {
    throw new DatabaseError(
      'Publication manifest does not match its database scope',
      'DATASET_PUBLICATION_MANIFEST_MISMATCH',
    );
  }
}

function publicationScope(dataset: DataPublicationDataset, season: FplSeasonRef, eventId?: number) {
  return and(
    eq(datasetPublicationsInOps.dataset, dataset),
    eq(datasetPublicationsInOps.seasonId, season.seasonId),
    eventId === undefined
      ? isNull(datasetPublicationsInOps.eventId)
      : eq(datasetPublicationsInOps.eventId, eventId),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceCheckedAtFromManifest(value: unknown): Date | null {
  if (!isRecord(value) || typeof value.sourceCheckedAt !== 'string') return null;
  const timestamp = new Date(value.sourceCheckedAt);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

export const createSyncOperationsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    startRun: async (input: StartSyncRunInput): Promise<string> => {
      const db = await getDbInstance();
      const runId = input.runId ?? randomUUID();
      const startedAt = input.startedAt;
      const inserted = await db
        .insert(syncRunsInOps)
        .values({
          runId,
          provider: input.provider,
          lane: input.lane,
          scope: input.scope,
          seasonId: input.season?.seasonId,
          seasonCode: input.season?.seasonCode,
          eventId: input.eventId,
          mode: input.mode,
          trigger: input.trigger,
          status: 'running',
          expectedItems: input.expectedItems ?? 0,
          metadata: input.metadata ?? {},
          startedAt: startedAt ?? sql`clock_timestamp()`,
        })
        .onConflictDoNothing({ target: syncRunsInOps.runId })
        .returning({ runId: syncRunsInOps.runId });
      if (inserted.length === 1) return runId;

      const existing = await db
        .select({
          provider: syncRunsInOps.provider,
          lane: syncRunsInOps.lane,
          scope: syncRunsInOps.scope,
          seasonId: syncRunsInOps.seasonId,
          seasonCode: syncRunsInOps.seasonCode,
          eventId: syncRunsInOps.eventId,
          mode: syncRunsInOps.mode,
          trigger: syncRunsInOps.trigger,
          status: syncRunsInOps.status,
        })
        .from(syncRunsInOps)
        .where(eq(syncRunsInOps.runId, runId))
        .limit(1);
      const row = existing[0];
      if (
        !row ||
        row.provider !== input.provider ||
        row.lane !== input.lane ||
        row.scope !== input.scope ||
        row.seasonId !== nullableValue(input.season?.seasonId) ||
        row.seasonCode !== nullableValue(input.season?.seasonCode) ||
        row.eventId !== nullableValue(input.eventId) ||
        row.mode !== input.mode ||
        row.trigger !== input.trigger
      ) {
        throw new DatabaseError(
          'Sync run ID is already bound to another immutable identity',
          'SYNC_RUN_ID_CONFLICT',
        );
      }
      // Scheduler retries intentionally reuse the durable obligation/run
      // correlation so publication evidence can still join the exact window.
      // A failed run is the one terminal state that may be fenced back to
      // running: without this transition the later attempt can fetch and
      // stage data but finishRun is forbidden from activating its publication.
      if (row.status === 'failed') {
        const reactivated = await db
          .update(syncRunsInOps)
          .set({
            status: 'running',
            completedItems: 0,
            failedItems: 0,
            skippedItems: 0,
            dataChanged: false,
            publicationId: null,
            errorSummary: null,
            completedAt: null,
            startedAt: startedAt ?? sql`clock_timestamp()`,
            ...(input.expectedItems === undefined ? {} : { expectedItems: input.expectedItems }),
            ...(input.metadata === undefined
              ? {}
              : {
                  // A retried run keeps its prior batch-cost attempts. The
                  // new trigger metadata only overlays the run's immutable
                  // context and must not erase evidence from earlier tries.
                  metadata: sql`${syncRunsInOps.metadata} || ${JSON.stringify(input.metadata)}::jsonb`,
                }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(syncRunsInOps.runId, runId), eq(syncRunsInOps.status, 'failed')))
          .returning({ runId: syncRunsInOps.runId });
        if (reactivated.length === 1) return runId;
      }
      return runId;
    },

    upsertItems: async (runId: string, items: readonly SyncItemInput[]): Promise<void> => {
      if (items.length === 0) return;
      const db = await getDbInstance();
      for (let offset = 0; offset < items.length; offset += 500) {
        const chunk = items.slice(offset, offset + 500);
        await db
          .insert(syncItemsInOps)
          .values(
            chunk.map((item) => ({
              runId,
              resourceType: item.resourceType,
              resourceId: item.resourceId,
              status: item.status,
              attempts: item.attempts ?? 0,
              sourceHash: item.sourceHash,
              normalizedPayload: item.normalizedPayload,
              lastError: item.lastError,
              completedAt: item.completedAt,
            })),
          )
          .onConflictDoUpdate({
            target: [syncItemsInOps.runId, syncItemsInOps.resourceType, syncItemsInOps.resourceId],
            set: {
              status: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.status}
                  ELSE excluded.status
                END
              `,
              attempts: sql`greatest(${syncItemsInOps.attempts}, excluded.attempts)`,
              sourceHash: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.sourceHash}
                  ELSE excluded.source_hash
                END
              `,
              normalizedPayload: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.normalizedPayload}
                  ELSE excluded.normalized_payload
                END
              `,
              lastError: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.lastError}
                  ELSE excluded.last_error
                END
              `,
              completedAt: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.completedAt}
                  ELSE excluded.completed_at
                END
              `,
              updatedAt: sql`
                CASE
                  WHEN excluded.attempts < ${syncItemsInOps.attempts}
                    OR (
                      excluded.attempts = ${syncItemsInOps.attempts}
                      AND ${syncItemsInOps.status} IN ('completed', 'skipped')
                    )
                  THEN ${syncItemsInOps.updatedAt}
                  ELSE clock_timestamp()
                END
              `,
            },
          });
      }
    },

    /**
     * Persist one batch-level cost record in the existing sync run/item
     * ledger. The sync item primary key makes duplicate delivery idempotent;
     * a real retry uses a different attempt key and therefore contributes a
     * separate cost record.
     */
    recordBatchCost: async (
      runId: string,
      input: RecordSyncBatchCostInput,
    ): Promise<'recorded' | 'duplicate' | 'missing'> => {
      if (!input.attemptKey.trim() || input.attemptKey.length > 240) {
        throw new DatabaseError('Batch cost attempt key is invalid', 'SYNC_BATCH_COST_KEY_INVALID');
      }
      const db = await getDbInstance();
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({ metadata: syncRunsInOps.metadata })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const run = runRows[0];
        if (!run) return 'missing';

        const existingRows = await tx
          .select({
            status: syncItemsInOps.status,
            normalizedPayload: syncItemsInOps.normalizedPayload,
          })
          .from(syncItemsInOps)
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
              eq(syncItemsInOps.resourceId, input.attemptKey),
            ),
          )
          .for('update');
        const existing = existingRows[0];
        const existingPayload = isRecord(existing?.normalizedPayload)
          ? existing.normalizedPayload
          : null;
        if (existing && existingPayload?.phase !== 'started') return 'duplicate';

        const settledPayload = {
          schemaVersion: 1,
          phase: 'settled',
          batchId: input.batchId,
          parentRunId: input.parentRunId ?? null,
          releaseSha: input.releaseSha,
          complete: input.complete,
          ...input.payload,
        };
        if (existing) {
          await tx
            .update(syncItemsInOps)
            .set({
              status: input.complete ? 'completed' : 'failed',
              attempts: Math.max(1, Math.floor(input.attempt)),
              normalizedPayload: settledPayload,
              completedAt: input.complete ? sql`clock_timestamp()` : null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(syncItemsInOps.runId, runId),
                eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
                eq(syncItemsInOps.resourceId, input.attemptKey),
              ),
            );
        } else {
          await tx.insert(syncItemsInOps).values({
            runId,
            resourceType: SYNC_BATCH_COST_RESOURCE_TYPE,
            resourceId: input.attemptKey,
            status: input.complete ? 'completed' : 'failed',
            attempts: Math.max(1, Math.floor(input.attempt)),
            normalizedPayload: settledPayload,
            completedAt: input.complete ? sql`clock_timestamp()` : null,
          });
        }

        const currentMetadata = isRecord(run.metadata) ? run.metadata : {};
        const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
        const currentAttempts = isRecord(currentCost.attempts) ? currentCost.attempts : {};
        const currentTotals = isRecord(currentCost.totals) ? currentCost.totals : {};
        const currentLatestAttempt =
          typeof currentCost.latestAttempt === 'number' &&
          Number.isSafeInteger(currentCost.latestAttempt) &&
          currentCost.latestAttempt >= 1
            ? currentCost.latestAttempt
            : 0;
        const currentTerminalAttempt =
          typeof currentCost.terminalAttempt === 'number' &&
          Number.isSafeInteger(currentCost.terminalAttempt) &&
          currentCost.terminalAttempt >= 1
            ? currentCost.terminalAttempt
            : 0;
        const attempt = Math.max(1, Math.floor(input.attempt));
        const latestAttempt = Math.max(currentLatestAttempt, attempt);
        // A terminal transition is owned by the newest attempt that has
        // reached the ledger. A late failure therefore cannot turn a newer
        // running/successful attempt back into failed; a newer success can
        // still reopen and complete a run that an older failure closed first.
        const terminalAllowed =
          attempt >= latestAttempt &&
          (currentTerminalAttempt === 0 || attempt >= currentTerminalAttempt);
        const terminalStatus = input.complete
          ? terminalAllowed
            ? ('completed' as const)
            : undefined
          : terminalAllowed
            ? ('failed' as const)
            : undefined;
        const nextAttempt = {
          batchId: input.batchId,
          parentRunId: input.parentRunId ?? null,
          releaseSha: input.releaseSha,
          attempt,
          complete: input.complete,
          ...input.payload,
        };
        const additiveKeys = [
          'logicalRequests',
          'httpAttempts',
          'httpRetries',
          'admissionWaitMs',
          'admissionWaitSamples',
          'admissionGrants',
          'admissionRejected',
          'admissionStoreUnavailable',
          'admissionCancelled',
          'providerResponseSamples',
          'providerResponse429',
          'providerResponse5xx',
          'providerNetworkErrors',
          'providerDurationMs',
          'providerDurationSamples',
          'insertedRows',
          'updatedRows',
          'deletedRows',
          'submittedRows',
          'requiredUnits',
          'reusedUnits',
          'succeededUnits',
          'failedUnits',
          'publicationsCreated',
          'publicationsReused',
        ] as const;
        const nextTotals: Record<string, unknown> = { ...currentTotals };
        for (const key of additiveKeys) {
          const value = input.payload[key];
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          const previous = typeof nextTotals[key] === 'number' ? nextTotals[key] : 0;
          nextTotals[key] = previous + value;
        }
        const endpointRequests = isRecord(input.payload.endpointRequests)
          ? input.payload.endpointRequests
          : {};
        const previousEndpoints = isRecord(currentTotals.endpointRequests)
          ? currentTotals.endpointRequests
          : {};
        const mergedEndpoints: Record<string, number> = {};
        for (const [endpoint, value] of Object.entries(previousEndpoints)) {
          if (typeof value === 'number' && Number.isFinite(value))
            mergedEndpoints[endpoint] = value;
        }
        for (const [endpoint, value] of Object.entries(endpointRequests)) {
          if (typeof value !== 'number' || !Number.isFinite(value)) continue;
          mergedEndpoints[endpoint] = (mergedEndpoints[endpoint] ?? 0) + value;
        }
        nextTotals.endpointRequests = mergedEndpoints;
        nextTotals.unitAccounting =
          currentTotals.unitAccounting === undefined
            ? input.payload.unitAccounting === 'exact'
              ? 'exact'
              : 'per_attempt'
            : currentTotals.unitAccounting === 'exact' && input.payload.unitAccounting === 'exact'
              ? 'exact'
              : 'per_attempt';
        nextTotals.unitAccountingQuality =
          currentTotals.unitAccountingQuality === undefined
            ? input.payload.unitAccountingQuality === 'reported'
              ? 'reported'
              : 'unknown'
            : currentTotals.unitAccountingQuality === 'reported' &&
                input.payload.unitAccountingQuality === 'reported'
              ? 'reported'
              : 'unknown';
        nextTotals.writeAccounting =
          currentTotals.writeAccounting === undefined
            ? input.payload.writeAccounting === 'reported'
              ? 'reported'
              : 'unknown'
            : currentTotals.writeAccounting === 'reported' &&
                input.payload.writeAccounting === 'reported'
              ? 'reported'
              : 'unknown';

        const nextMetadata = {
          ...currentMetadata,
          batchCost: {
            schemaVersion: 1,
            attempts: { ...currentAttempts, [input.attemptKey]: nextAttempt },
            totals: nextTotals,
            latestAttempt,
            ...(terminalStatus ? { terminalAttempt: attempt } : {}),
            lastSettledAt: new Date().toISOString(),
          },
        };
        // Keep the aggregate update unconditional. A run may already be
        // terminal because another attempt settled first, but this attempt is
        // still real cost and must remain visible in the immutable item/totals.
        await tx
          .update(syncRunsInOps)
          .set({ metadata: nextMetadata, updatedAt: sql`clock_timestamp()` })
          .where(eq(syncRunsInOps.runId, runId));
        if (terminalStatus) {
          await tx
            .update(syncRunsInOps)
            .set({
              status: terminalStatus,
              ...(terminalStatus === 'completed'
                ? {
                    completedItems: 1,
                    failedItems: 0,
                    skippedItems: 0,
                    dataChanged: false,
                    errorSummary: null,
                  }
                : {
                    errorSummary: 'Data sync attempt did not settle successfully',
                  }),
              completedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(syncRunsInOps.runId, runId),
                terminalStatus === 'completed'
                  ? inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES, 'failed'])
                  : inArray(syncRunsInOps.status, NON_TERMINAL_RUN_STATUSES),
              ),
            );
        }
        return 'recorded';
      });
    },

    /**
     * Leave a durable running marker before provider work starts. If the
     * process exits before settlement, the running sync item is explicit
     * evidence of an incomplete batch rather than an invented zero-cost row.
     */
    recordBatchCostStart: async (
      runId: string,
      input: RecordSyncBatchCostStartInput,
    ): Promise<'recorded' | 'duplicate' | 'missing'> => {
      if (!input.attemptKey.trim() || input.attemptKey.length > 240) {
        throw new DatabaseError('Batch cost attempt key is invalid', 'SYNC_BATCH_COST_KEY_INVALID');
      }
      const db = await getDbInstance();
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({ runId: syncRunsInOps.runId, metadata: syncRunsInOps.metadata })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        if (!runRows[0]) return 'missing';
        const inserted = await tx
          .insert(syncItemsInOps)
          .values({
            runId,
            resourceType: SYNC_BATCH_COST_RESOURCE_TYPE,
            resourceId: input.attemptKey,
            status: 'running',
            attempts: Math.max(1, Math.floor(input.attempt)),
            normalizedPayload: {
              schemaVersion: 1,
              phase: 'started',
              batchId: input.batchId,
              parentRunId: input.parentRunId ?? null,
              releaseSha: input.releaseSha,
              ...input.payload,
            },
          })
          .onConflictDoNothing({
            target: [syncItemsInOps.runId, syncItemsInOps.resourceType, syncItemsInOps.resourceId],
          })
          .returning({ resourceId: syncItemsInOps.resourceId });
        const currentMetadata = isRecord(runRows[0]?.metadata) ? runRows[0].metadata : {};
        const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
        const latestAttempt =
          typeof currentCost.latestAttempt === 'number' &&
          Number.isSafeInteger(currentCost.latestAttempt) &&
          currentCost.latestAttempt >= 1
            ? Math.max(currentCost.latestAttempt, Math.floor(input.attempt))
            : Math.max(1, Math.floor(input.attempt));
        await tx
          .update(syncRunsInOps)
          .set({
            metadata: {
              ...currentMetadata,
              batchCost: {
                schemaVersion: 1,
                ...currentCost,
                latestAttempt,
              },
            },
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(syncRunsInOps.runId, runId));
        return inserted.length === 1 ? 'recorded' : 'duplicate';
      });
    },

    finishRun: async (
      runId: string,
      input: {
        status: Extract<SyncRunStatus, 'completed' | 'ready_to_publish' | 'published' | 'skipped'>;
        completedItems: number;
        failedItems?: number;
        skippedItems?: number;
        dataChanged: boolean;
        publicationId?: string | null;
        metadata?: Record<string, unknown>;
      },
    ): Promise<void> => {
      const db = await getDbInstance();
      await db.transaction(async (tx) => {
        const rows = await tx
          .select({ status: syncRunsInOps.status })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const current = rows[0];
        if (!current) {
          throw new DatabaseError('Sync run does not exist', 'SYNC_RUN_NOT_FOUND');
        }
        if (
          current.status !== input.status &&
          !NON_TERMINAL_RUN_STATUSES.includes(current.status as SyncRunStatus)
        ) {
          throw new DatabaseError(
            `Sync run cannot transition from ${current.status} to ${input.status}`,
            'SYNC_RUN_TERMINAL_STATE_CONFLICT',
          );
        }

        await tx
          .update(syncRunsInOps)
          .set({
            status: input.status,
            completedItems: input.completedItems,
            failedItems: input.failedItems ?? 0,
            skippedItems: input.skippedItems ?? 0,
            dataChanged: input.dataChanged,
            ...(input.publicationId !== undefined ? { publicationId: input.publicationId } : {}),
            // Preserve any batch-cost ledger written by the attempt reporter
            // (and existing run metadata) when a business phase adds its own
            // terminal reason. JSONB merge is performed under the row lock.
            ...(input.metadata
              ? {
                  metadata: sql`${syncRunsInOps.metadata} || ${JSON.stringify(input.metadata)}::jsonb`,
                }
              : {}),
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, clock_timestamp())`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(syncRunsInOps.runId, runId));
      });
    },

    failRun: async (runId: string, error: unknown): Promise<void> => {
      const db = await getDbInstance();
      const summary = error instanceof Error ? error.message : String(error);
      await db
        .update(syncRunsInOps)
        .set({
          status: 'failed',
          errorSummary: summary.slice(0, 4_000),
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(syncRunsInOps.runId, runId),
            inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES, 'failed']),
          ),
        );
    },

    preparePublication: async (
      input: PreparePublicationInput,
    ): Promise<PreparedDatasetPublication> => {
      const db = await getDbInstance();
      const publicationId = input.publicationId ?? randomUUID();
      if (!isDataPublicationId(publicationId)) {
        throw new DatabaseError(
          'Publication ID must be an RFC UUID',
          'DATASET_PUBLICATION_ID_INVALID',
        );
      }
      await db.transaction(async (tx) => {
        const expired = await tx
          .select({ publicationId: datasetPublicationsInOps.publicationId })
          .from(datasetPublicationsInOps)
          .where(
            and(
              lte(datasetPublicationsInOps.expiresAt, sql`clock_timestamp()`),
              inArray(datasetPublicationsInOps.status, ['retired', 'failed']),
            ),
          )
          .orderBy(
            asc(datasetPublicationsInOps.expiresAt),
            asc(datasetPublicationsInOps.publicationId),
          )
          .limit(EXPIRED_PUBLICATION_CLEANUP_BATCH_SIZE)
          .for('update', { skipLocked: true });
        if (expired.length === 0) return;
        const expiredIds = expired.map((row) => row.publicationId);
        await tx
          .update(syncRunsInOps)
          .set({ publicationId: null, updatedAt: sql`clock_timestamp()` })
          .where(inArray(syncRunsInOps.publicationId, expiredIds));
        await tx
          .delete(datasetPublicationsInOps)
          .where(
            and(
              inArray(datasetPublicationsInOps.publicationId, expiredIds),
              lte(datasetPublicationsInOps.expiresAt, sql`clock_timestamp()`),
              inArray(datasetPublicationsInOps.status, ['retired', 'failed']),
            ),
          );
      });
      const inserted = await db
        .insert(datasetPublicationsInOps)
        .values({
          publicationId,
          dataset: input.dataset,
          seasonId: input.season.seasonId,
          eventId: input.eventId,
          status: 'staging',
          manifest: input.manifest ?? {},
          sourceRunId: input.sourceRunId,
          expiresAt: sql`clock_timestamp() + interval '15 minutes'`,
        })
        .onConflictDoNothing({ target: datasetPublicationsInOps.publicationId })
        .returning({
          publicationId: datasetPublicationsInOps.publicationId,
          revision: datasetPublicationsInOps.revision,
          status: datasetPublicationsInOps.status,
        });
      if (inserted[0]) return inserted[0];

      const existing = await db
        .select({
          publicationId: datasetPublicationsInOps.publicationId,
          revision: datasetPublicationsInOps.revision,
          status: datasetPublicationsInOps.status,
          dataset: datasetPublicationsInOps.dataset,
          seasonId: datasetPublicationsInOps.seasonId,
          eventId: datasetPublicationsInOps.eventId,
          sourceRunId: datasetPublicationsInOps.sourceRunId,
        })
        .from(datasetPublicationsInOps)
        .where(eq(datasetPublicationsInOps.publicationId, publicationId))
        .limit(1);
      const row = existing[0];
      if (
        !row ||
        row.dataset !== input.dataset ||
        row.seasonId !== input.season.seasonId ||
        row.eventId !== (input.eventId ?? null) ||
        row.sourceRunId !== input.sourceRunId
      ) {
        throw new DatabaseError(
          'Publication ID is already bound to another scope',
          'DATASET_PUBLICATION_ID_CONFLICT',
        );
      }
      return {
        publicationId: row.publicationId,
        revision: row.revision,
        status: row.status,
      };
    },

    stagePublicationItems: async (
      publicationId: string,
      items: readonly DatasetPublicationItemInput[],
    ): Promise<void> => {
      const names = new Set(items.map((item) => item.name));
      const isLiveItems = items.length === 2 && names.has('eventLive') && names.has('fixtures');
      const isMarketItems = items.length === 1 && names.has('context');
      const isPriceChangeItems = items.length === 2 && names.has('context') && names.has('players');
      const coreNames = new Set([
        'events',
        'teams',
        'players',
        'phases',
        'fixtures',
        'currentEventId',
        'selectionRules',
      ]);
      const legacyCoreNames = new Set([
        'events',
        'teams',
        'players',
        'phases',
        'fixtures',
        'currentEventId',
      ]);
      const isCoreItems =
        (items.length === coreNames.size || items.length === legacyCoreNames.size) &&
        [...names].every((name) => coreNames.has(name)) &&
        (items.length === coreNames.size || [...names].every((name) => legacyCoreNames.has(name)));
      if (
        (!isLiveItems && !isMarketItems && !isPriceChangeItems && !isCoreItems) ||
        names.size !== items.length
      ) {
        throw new DatabaseError(
          'Publication item proof is incomplete',
          'DATASET_PUBLICATION_ITEMS_INCOMPLETE',
        );
      }
      const db = await getDbInstance();
      await db
        .insert(datasetPublicationItemsInOps)
        .values(
          items.map((item) => ({
            publicationId,
            itemName: item.name,
            payload: item.payload,
            itemCount: item.count,
            checksum: item.checksum,
          })),
        )
        .onConflictDoUpdate({
          target: [
            datasetPublicationItemsInOps.publicationId,
            datasetPublicationItemsInOps.itemName,
          ],
          set: {
            payload: sql`excluded.payload`,
            itemCount: sql`excluded.item_count`,
            checksum: sql`excluded.checksum`,
          },
        });
    },

    assertPublicationItemsComplete: async (
      publicationId: string,
      expected: readonly DatasetPublicationItemInput[],
    ): Promise<void> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          itemName: datasetPublicationItemsInOps.itemName,
          itemCount: datasetPublicationItemsInOps.itemCount,
          checksum: datasetPublicationItemsInOps.checksum,
        })
        .from(datasetPublicationItemsInOps)
        .where(eq(datasetPublicationItemsInOps.publicationId, publicationId));
      if (
        rows.length !== expected.length ||
        expected.some(
          (item) =>
            !rows.some(
              (row) =>
                row.itemName === item.name &&
                row.itemCount === item.count &&
                row.checksum === item.checksum,
            ),
        )
      ) {
        throw new DatabaseError(
          `Publication ${publicationId} does not contain a complete item set`,
          'DATASET_PUBLICATION_ITEMS_INCOMPLETE',
        );
      }
    },

    activatePublication: async (input: {
      publicationId: string;
      dataset: DataPublicationDataset;
      season: FplSeasonRef;
      eventId?: number;
      sourceRunId: string;
      manifest: DataPublicationManifest;
      outbox?: {
        outboxId: string;
      };
      /** Optional same-transaction fence for a higher-level scheduler lane. */
      beforeActivate?: (tx: DbOrTransaction) => Promise<void>;
    }): Promise<void> => {
      const db = await getDbInstance();
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtext(${input.dataset}),
            hashtext(${`${input.season.seasonId}:${input.eventId ?? 0}`})
          )
        `);
        const target = await tx
          .select({
            status: datasetPublicationsInOps.status,
            dataset: datasetPublicationsInOps.dataset,
            seasonId: datasetPublicationsInOps.seasonId,
            eventId: datasetPublicationsInOps.eventId,
            revision: datasetPublicationsInOps.revision,
            sourceRunId: datasetPublicationsInOps.sourceRunId,
          })
          .from(datasetPublicationsInOps)
          .where(eq(datasetPublicationsInOps.publicationId, input.publicationId))
          .for('update');
        const targetRow = target[0];
        if (!targetRow) {
          throw new DatabaseError(
            'Dataset publication does not exist',
            'DATASET_PUBLICATION_NOT_FOUND',
          );
        }
        if (
          targetRow.dataset !== input.dataset ||
          targetRow.seasonId !== input.season.seasonId ||
          targetRow.eventId !== (input.eventId ?? null) ||
          targetRow.sourceRunId !== input.sourceRunId
        ) {
          throw new DatabaseError(
            'Dataset publication is bound to another scope or source run',
            'DATASET_PUBLICATION_SCOPE_CONFLICT',
          );
        }
        if (targetRow.status !== 'staging' && targetRow.status !== 'active') {
          throw new DatabaseError(
            `Dataset publication cannot be activated from ${targetRow.status}`,
            'DATASET_PUBLICATION_TERMINAL_STATE_CONFLICT',
          );
        }
        assertPublicationManifest(input.manifest, {
          publicationId: input.publicationId,
          dataset: input.dataset,
          season: input.season,
          eventId: input.eventId,
          revision: targetRow.revision,
        });

        const itemRows = await tx
          .select({
            itemName: datasetPublicationItemsInOps.itemName,
            itemCount: datasetPublicationItemsInOps.itemCount,
            checksum: datasetPublicationItemsInOps.checksum,
          })
          .from(datasetPublicationItemsInOps)
          .where(eq(datasetPublicationItemsInOps.publicationId, input.publicationId));
        const manifestItems = input.manifest.items;
        // New production publication paths always provide an outbox receipt;
        // those paths must prove every immutable payload before DB activation.
        // Keep the no-outbox form compatible with legacy repair/import callers
        // while they are migrated to the durable delivery contract.
        if (input.outbox) {
          if (
            itemRows.length !== manifestItems.length ||
            manifestItems.some(
              (item) =>
                !itemRows.some(
                  (row) =>
                    row.itemName === item.name &&
                    row.itemCount === item.count &&
                    row.checksum === item.sha256,
                ),
            )
          ) {
            throw new DatabaseError(
              `${input.dataset} publication item proof is incomplete`,
              'DATASET_PUBLICATION_ITEMS_INCOMPLETE',
            );
          }
        }

        const activeRows = await tx
          .select({
            publicationId: datasetPublicationsInOps.publicationId,
            revision: datasetPublicationsInOps.revision,
            manifest: datasetPublicationsInOps.manifest,
          })
          .from(datasetPublicationsInOps)
          .where(
            and(
              publicationScope(input.dataset, input.season, input.eventId),
              eq(datasetPublicationsInOps.status, 'active'),
            ),
          )
          .for('update');
        // Run caller-specific fences only after the target scope's active row
        // is locked. Source-order checks performed before this point can race
        // a concurrent activation and allow an older replay to retire newer
        // authoritative data.
        await input.beforeActivate?.(tx);
        const newerActive = activeRows.find(
          (row) => row.publicationId !== input.publicationId && row.revision >= targetRow.revision,
        );
        if (newerActive) {
          throw new DatabaseError(
            'A newer dataset publication is already active for this scope',
            'DATASET_PUBLICATION_STALE_ACTIVATION',
          );
        }

        // Revisions are allocation order, not provider source order.  A
        // delayed archived Core repair can therefore have a larger revision
        // than a newer live publication.  Fence Core activation by the source
        // capture time while the active row is locked, so the old snapshot can
        // never retire the newer authoritative publication.
        if (input.dataset === 'fpl:core' && activeRows.length > 0) {
          const candidateSourceCheckedAt = sourceCheckedAtFromManifest(input.manifest);
          if (!candidateSourceCheckedAt) {
            throw new DatabaseError(
              'Core publication source capture timestamp is invalid',
              'CORE_PUBLICATION_SOURCE_INVALID',
            );
          }
          const activeSourceCheckedAt = sourceCheckedAtFromManifest(activeRows[0].manifest);
          if (!activeSourceCheckedAt) {
            throw new DatabaseError(
              'Active Core publication source capture timestamp is unavailable',
              'CORE_PUBLICATION_SOURCE_UNAVAILABLE',
            );
          }
          if (activeSourceCheckedAt.getTime() > candidateSourceCheckedAt.getTime()) {
            throw new DatabaseError(
              'A newer Core source publication is already active',
              'CORE_SNAPSHOT_STALE_SOURCE',
            );
          }
        }

        const runRows = await tx
          .select({
            status: syncRunsInOps.status,
            publicationId: syncRunsInOps.publicationId,
          })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, input.sourceRunId))
          .for('update');
        const run = runRows[0];
        if (!run) {
          throw new DatabaseError('Publication source run does not exist', 'SYNC_RUN_NOT_FOUND');
        }
        if (run.publicationId !== null && run.publicationId !== input.publicationId) {
          throw new DatabaseError(
            'Sync run is already bound to another publication',
            'SYNC_RUN_PUBLICATION_CONFLICT',
          );
        }
        if (
          run.status !== 'published' &&
          !NON_TERMINAL_RUN_STATUSES.includes(run.status as SyncRunStatus)
        ) {
          throw new DatabaseError(
            `Publication source run cannot publish from ${run.status}`,
            'SYNC_RUN_TERMINAL_STATE_CONFLICT',
          );
        }

        await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'retired',
            retiredAt: sql`clock_timestamp()`,
            expiresAt: sql`clock_timestamp() + interval '24 hours'`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              publicationScope(input.dataset, input.season, input.eventId),
              eq(datasetPublicationsInOps.status, 'active'),
              sql`${datasetPublicationsInOps.publicationId} <> ${input.publicationId}::uuid`,
            ),
          );

        await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'active',
            manifest: input.manifest,
            activatedAt: sql`clock_timestamp()`,
            retiredAt: null,
            expiresAt: null,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(datasetPublicationsInOps.publicationId, input.publicationId));

        await tx
          .update(syncRunsInOps)
          .set({
            status: input.outbox ? 'ready_to_publish' : 'published',
            publicationId: input.publicationId,
            dataChanged: true,
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, clock_timestamp())`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(syncRunsInOps.runId, input.sourceRunId));

        if (input.outbox) {
          await tx
            .insert(dataPublicationOutboxInOps)
            .values({
              outboxId: input.outbox.outboxId,
              publicationId: input.publicationId,
              sourceRunId: input.sourceRunId,
              dataset: input.dataset,
              seasonId: input.season.seasonId,
              eventId: input.eventId,
              manifest: input.manifest,
              // The receipt is created in the same transaction that activates
              // the canonical DB publication.  Make that durable phase
              // explicit; the dispatcher will advance it through staged,
              // redis_activated and delivered after commit.
              status: 'db_activated',
              dbActivatedAt: sql`clock_timestamp()`,
            })
            .onConflictDoNothing({ target: dataPublicationOutboxInOps.publicationId });
        }
      });
    },

    failPublication: async (publicationId: string, error: unknown): Promise<void> => {
      const db = await getDbInstance();
      const summary = error instanceof Error ? error.message : String(error);
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'failed',
            expiresAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(datasetPublicationsInOps.publicationId, publicationId),
              eq(datasetPublicationsInOps.status, 'staging'),
            ),
          )
          .returning({ sourceRunId: datasetPublicationsInOps.sourceRunId });
        const runId = rows[0]?.sourceRunId;
        if (runId) {
          await tx
            .update(syncRunsInOps)
            .set({
              status: 'failed',
              errorSummary: summary.slice(0, 4_000),
              completedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(syncRunsInOps.runId, runId),
                inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES, 'failed']),
              ),
            );
          return;
        }

        const existing = await tx
          .select({ status: datasetPublicationsInOps.status })
          .from(datasetPublicationsInOps)
          .where(eq(datasetPublicationsInOps.publicationId, publicationId))
          .limit(1);
        if (!existing[0]) {
          throw new DatabaseError(
            'Dataset publication does not exist',
            'DATASET_PUBLICATION_NOT_FOUND',
          );
        }
        if (existing[0].status !== 'failed') {
          throw new DatabaseError(
            `Dataset publication cannot fail from ${existing[0].status}`,
            'DATASET_PUBLICATION_TERMINAL_STATE_CONFLICT',
          );
        }
      });
    },

    skipPublication: async (publicationId: string, reason: string): Promise<void> => {
      const db = await getDbInstance();
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'retired',
            retiredAt: sql`clock_timestamp()`,
            expiresAt: sql`clock_timestamp() + interval '15 minutes'`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(datasetPublicationsInOps.publicationId, publicationId),
              eq(datasetPublicationsInOps.status, 'staging'),
            ),
          )
          .returning({ sourceRunId: datasetPublicationsInOps.sourceRunId });
        const runId = rows[0]?.sourceRunId;
        if (runId) {
          await tx
            .update(syncRunsInOps)
            .set({
              status: 'skipped',
              dataChanged: false,
              errorSummary: reason.slice(0, 4_000),
              completedAt: sql`clock_timestamp()`,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(syncRunsInOps.runId, runId),
                inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES, 'skipped']),
              ),
            );
          return;
        }

        const existing = await tx
          .select({ status: datasetPublicationsInOps.status })
          .from(datasetPublicationsInOps)
          .where(eq(datasetPublicationsInOps.publicationId, publicationId))
          .limit(1);
        if (!existing[0]) {
          throw new DatabaseError(
            'Dataset publication does not exist',
            'DATASET_PUBLICATION_NOT_FOUND',
          );
        }
        if (existing[0].status !== 'retired') {
          throw new DatabaseError(
            `Dataset publication cannot be skipped from ${existing[0].status}`,
            'DATASET_PUBLICATION_TERMINAL_STATE_CONFLICT',
          );
        }
      });
    },

    findActivePublication: async (
      dataset: DataPublicationDataset,
      season: FplSeasonRef,
      eventId?: number,
    ): Promise<PreparedDatasetPublication | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          publicationId: datasetPublicationsInOps.publicationId,
          revision: datasetPublicationsInOps.revision,
          status: datasetPublicationsInOps.status,
        })
        .from(datasetPublicationsInOps)
        .where(
          and(
            publicationScope(dataset, season, eventId),
            eq(datasetPublicationsInOps.status, 'active'),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    findStagingPublication: async (
      dataset: DataPublicationDataset,
      season: FplSeasonRef,
      eventId?: number,
    ): Promise<{
      publicationId: string;
      revision: number;
      sourceRunId: string;
      manifest: DataPublicationManifest;
      createdAt: Date;
      expiresAt: Date | null;
    } | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          publicationId: datasetPublicationsInOps.publicationId,
          revision: datasetPublicationsInOps.revision,
          sourceRunId: datasetPublicationsInOps.sourceRunId,
          manifest: datasetPublicationsInOps.manifest,
          createdAt: datasetPublicationsInOps.createdAt,
          expiresAt: datasetPublicationsInOps.expiresAt,
        })
        .from(datasetPublicationsInOps)
        .where(
          and(
            publicationScope(dataset, season, eventId),
            eq(datasetPublicationsInOps.status, 'staging'),
          ),
        )
        .orderBy(desc(datasetPublicationsInOps.revision))
        .limit(1);
      const row = rows[0];
      if (!row?.sourceRunId || !isRecord(row.manifest)) return null;
      return {
        publicationId: row.publicationId,
        revision: row.revision,
        sourceRunId: row.sourceRunId,
        manifest: row.manifest as unknown as DataPublicationManifest,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      };
    },

    findActivePublicationManifest: async (
      dataset: DataPublicationDataset,
      season: FplSeasonRef,
      eventId?: number,
    ): Promise<DataPublicationManifest | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          publicationId: datasetPublicationsInOps.publicationId,
          revision: datasetPublicationsInOps.revision,
          manifest: datasetPublicationsInOps.manifest,
        })
        .from(datasetPublicationsInOps)
        .where(
          and(
            publicationScope(dataset, season, eventId),
            eq(datasetPublicationsInOps.status, 'active'),
          ),
        )
        .limit(1);
      const row = rows[0];
      const raw = row?.manifest;
      if (!raw) return null;
      const manifest = parseDataPublicationManifest(
        typeof raw === 'string' ? raw : JSON.stringify(raw),
      );
      if (
        !manifest ||
        manifest.publicationId !== row.publicationId ||
        manifest.revision !== row.revision ||
        manifest.dataset !== dataset ||
        manifest.seasonCode !== season.seasonCode ||
        manifest.eventId !== (eventId ?? null)
      ) {
        return null;
      }
      return manifest;
    },

    findPublicationById: async (
      publicationId: string,
    ): Promise<{
      publicationId: string;
      dataset: string;
      seasonId: number | null;
      eventId: number | null;
      revision: number;
      status: string;
      sourceRunId: string | null;
    } | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          publicationId: datasetPublicationsInOps.publicationId,
          dataset: datasetPublicationsInOps.dataset,
          seasonId: datasetPublicationsInOps.seasonId,
          eventId: datasetPublicationsInOps.eventId,
          revision: datasetPublicationsInOps.revision,
          status: datasetPublicationsInOps.status,
          sourceRunId: datasetPublicationsInOps.sourceRunId,
        })
        .from(datasetPublicationsInOps)
        .where(eq(datasetPublicationsInOps.publicationId, publicationId))
        .limit(1);
      return rows[0] ?? null;
    },
  };
};

export const syncOperationsRepository = createSyncOperationsRepository();
