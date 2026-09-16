import { randomUUID } from 'node:crypto';

import { alias } from 'drizzle-orm/pg-core';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  like,
  lte,
  lt,
  not,
  or,
  sql,
} from 'drizzle-orm';

import {
  datasetPublicationItemsInOps,
  datasetPublicationsInOps,
  dataPublicationOutboxInOps,
  eventsInFpl,
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
  /** Delivery attempt used to reopen a failed batch-cost ledger. */
  readonly attempt?: number;
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

export interface StartSyncBatchCostRunInput {
  /** The immutable run identity and optional retry fence. */
  readonly run: StartSyncRunInput;
  /** The running marker that must be committed with the run row. */
  readonly marker: RecordSyncBatchCostStartInput;
}

export type EntrySyncAuditStatus = Readonly<{
  schemaVersion: 'entry-sync-audit-v1';
  seasonId: number;
  eventId: number;
  entryId: number;
  available: boolean;
  reasonCodes: readonly string[];
  coverageStartAt: string | null;
  observedAt: string;
  executions: number;
  providerRequests: Readonly<{
    eventLive: number;
    picks: number;
    transfers: number;
    unknown: number;
  }>;
  factCommits: number;
  finalCompletions: number;
  reusedSkips: number;
  failedItems: number;
  evidenceComplete: boolean;
  triggers: readonly string[];
  recent: readonly Readonly<{
    runId: string;
    trigger: string;
    component: string;
    status: SyncItemStatus;
    attempts: number;
    sourceRevision: string | null;
    reuseReason: string | null;
    factCommit: string | null;
    finalCompletion: boolean;
    unknownRequests: number;
    observedAt: string;
  }>[];
  truncated: boolean;
}>;

export interface MarkSyncBatchCostSettlementFailureInput {
  /** Stable idempotency key for the running execution marker. */
  readonly attemptKey: string;
  readonly attempt: number;
  readonly error: unknown;
}

export interface ReconcileSyncBatchCostTerminalFailureInput {
  /** Stable Bull batch identity shared by every attempt of one job. */
  readonly batchId: string;
  /** The delivery attempt that Bull has exhausted or marked terminal. */
  readonly attempt: number;
  readonly error: unknown;
}

export interface ReconcileStaleSyncBatchCostMarkersInput {
  /** Exact lane used by the direct execution path. */
  readonly lane: string;
  /** Exact job scope used by the direct execution path. */
  readonly scope: string;
  /** Minimum age of an untouched running marker before it is considered orphaned. */
  readonly olderThanMs: number;
  /** Bound one maintenance pass so a large historical backlog cannot monopolize it. */
  readonly limit?: number;
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
          metadata: syncRunsInOps.metadata,
        })
        .from(syncRunsInOps)
        .where(eq(syncRunsInOps.runId, runId))
        .limit(1);
      const row = existing[0];
      const eventMatches =
        input.mode === 'batch-cost'
          ? input.eventId === undefined || row?.eventId === null || row?.eventId === input.eventId
          : row?.eventId === nullableValue(input.eventId);
      if (
        !row ||
        row.provider !== input.provider ||
        row.lane !== input.lane ||
        row.scope !== input.scope ||
        row.seasonId !== nullableValue(input.season?.seasonId) ||
        row.seasonCode !== nullableValue(input.season?.seasonCode) ||
        !eventMatches ||
        row.mode !== input.mode ||
        row.trigger !== input.trigger
      ) {
        throw new DatabaseError(
          'Sync run ID is already bound to another immutable identity',
          'SYNC_RUN_ID_CONFLICT',
        );
      }
      // A recovery may know the event after an earlier unscoped marker was
      // created. Bind that first positive event to the durable ledger while
      // the immutable identity is still unscoped; a concurrent recovery for
      // another event will observe the binding and fail closed below.
      if (input.mode === 'batch-cost' && input.eventId !== undefined && row.eventId === null) {
        const bound = await db
          .update(syncRunsInOps)
          .set({ eventId: input.eventId, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(syncRunsInOps.runId, runId), isNull(syncRunsInOps.eventId)))
          .returning({ eventId: syncRunsInOps.eventId });
        if (bound.length === 0) {
          const current = await db
            .select({ eventId: syncRunsInOps.eventId })
            .from(syncRunsInOps)
            .where(eq(syncRunsInOps.runId, runId))
            .limit(1);
          if (current[0]?.eventId !== input.eventId) {
            throw new DatabaseError(
              'Sync run ID is already bound to another immutable event scope',
              'SYNC_RUN_ID_CONFLICT',
            );
          }
        }
      }
      // Scheduler retries intentionally reuse the durable obligation/run
      // correlation so publication evidence can still join the exact window.
      // A failed run is the one terminal state that may be fenced back to
      // running: without this transition the later attempt can fetch and
      // stage data but finishRun is forbidden from activating its publication.
      // Batch-cost ledgers use the delivery attempt as an explicit fence. A
      // stale settlement must never reopen a terminal ledger, while a newer
      // attempt must reopen it before its running marker is written.
      const currentMetadata = isRecord(row.metadata) ? row.metadata : {};
      const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
      const latestAttempt =
        typeof currentCost.latestAttempt === 'number' &&
        Number.isSafeInteger(currentCost.latestAttempt) &&
        currentCost.latestAttempt >= 1
          ? currentCost.latestAttempt
          : 0;
      const terminalAttempt =
        typeof currentCost.terminalAttempt === 'number' &&
        Number.isSafeInteger(currentCost.terminalAttempt) &&
        currentCost.terminalAttempt >= 1
          ? currentCost.terminalAttempt
          : 0;
      const requestedAttempt =
        typeof input.attempt === 'number' && Number.isFinite(input.attempt)
          ? Math.max(1, Math.floor(input.attempt))
          : 0;
      const batchCostRetryIsNewer =
        row.mode === 'batch-cost' && requestedAttempt > Math.max(latestAttempt, terminalAttempt);
      if (row.status === 'failed' && (row.mode !== 'batch-cost' || batchCostRetryIsNewer)) {
        const nextMetadata =
          input.mode === 'batch-cost' && input.metadata !== undefined
            ? {
                ...currentMetadata,
                ...input.metadata,
                // Keep the immutable accounting history while allowing the
                // caller to refresh source/run context for the new attempt.
                batchCost: currentCost,
              }
            : input.metadata;
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
            ...(nextMetadata === undefined ? {} : { metadata: nextMetadata }),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(and(eq(syncRunsInOps.runId, runId), eq(syncRunsInOps.status, 'failed')))
          .returning({ runId: syncRunsInOps.runId });
        if (reactivated.length === 1) return runId;
      }
      return runId;
    },

    /**
     * Create or resume a batch-cost run and persist its running marker in one
     * database transaction. The marker is the evidence used by queue and
     * stale-run reconciliation; committing the run without it would leave an
     * itemless running ledger that no reconciler can identify precisely.
     */
    startBatchCostRun: async (
      input: StartSyncBatchCostRunInput,
    ): Promise<'recorded' | 'duplicate'> => {
      const db = await getDbInstance();
      return db.transaction(async (tx) => {
        const repository = createSyncOperationsRepository(tx);
        const runId = await repository.startRun(input.run);
        const recorded = await repository.recordBatchCostStart(runId, input.marker);
        if (recorded === 'missing') {
          throw new DatabaseError(
            `Batch cost ledger run ${runId} disappeared during atomic start`,
            'SYNC_BATCH_COST_RUN_MISSING',
          );
        }
        return recorded;
      });
    },

    upsertItems: async (runId: string, items: readonly SyncItemInput[]): Promise<void> => {
      if (items.length === 0) return;
      const db = await getDbInstance();
      for (let offset = 0; offset < items.length; offset += 500) {
        const chunk = items.slice(offset, offset + 500);
        const preserveExistingItem = sql`
          excluded.attempts < ${syncItemsInOps.attempts}
          OR (
            excluded.attempts = ${syncItemsInOps.attempts}
            AND (
              ${syncItemsInOps.status} IN ('completed', 'skipped')
              OR (
                ${syncItemsInOps.status} = 'failed'
                AND excluded.status NOT IN ('completed', 'skipped')
              )
            )
          )
        `;
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
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.status}
                  ELSE excluded.status
                END
              `,
              attempts: sql`greatest(${syncItemsInOps.attempts}, excluded.attempts)`,
              sourceHash: sql`
                CASE
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.sourceHash}
                  ELSE excluded.source_hash
                END
              `,
              normalizedPayload: sql`
                CASE
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.normalizedPayload}
                  ELSE excluded.normalized_payload
                END
              `,
              lastError: sql`
                CASE
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.lastError}
                  ELSE excluded.last_error
                END
              `,
              completedAt: sql`
                CASE
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.completedAt}
                  ELSE excluded.completed_at
                END
              `,
              updatedAt: sql`
                CASE
                  WHEN ${preserveExistingItem} THEN ${syncItemsInOps.updatedAt}
                  ELSE clock_timestamp()
                END
              `,
            },
          });
      }
    },

    failPendingItems: async (
      runId: string,
      error: unknown,
      resourceIds?: readonly string[],
    ): Promise<void> => {
      const db = await getDbInstance();
      const summary = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
      const resourceScope =
        resourceIds === undefined
          ? undefined
          : resourceIds.length > 0
            ? inArray(syncItemsInOps.resourceId, [...new Set(resourceIds)])
            : sql`false`;
      await db
        .update(syncItemsInOps)
        .set({
          status: 'failed',
          normalizedPayload: sql`
            coalesce(${syncItemsInOps.normalizedPayload}, '{}'::jsonb)
            || jsonb_build_object(
              'setupFailure', true,
              'unknownRequests',
              CASE
                WHEN (${syncItemsInOps.normalizedPayload}->>'unknownRequests') ~ '^[0-9]+$'
                THEN (${syncItemsInOps.normalizedPayload}->>'unknownRequests')::integer
                ELSE 0
              END
            )
          `,
          lastError: summary,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(syncItemsInOps.runId, runId),
            inArray(syncItemsInOps.status, ['pending', 'running']),
            ...(resourceScope === undefined ? [] : [resourceScope]),
          ),
        );
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

        const existingEventId =
          typeof existingPayload?.eventId === 'number' &&
          Number.isSafeInteger(existingPayload.eventId) &&
          existingPayload.eventId > 0
            ? existingPayload.eventId
            : undefined;
        const incomingEventId = input.payload.eventId;

        const settledPayload = {
          schemaVersion: 1,
          phase: 'settled',
          batchId: input.batchId,
          parentRunId: input.parentRunId ?? null,
          releaseSha: input.releaseSha,
          complete: input.complete,
          ...input.payload,
          // An unscoped attempt can discover its event before a later scope
          // conflict aborts the runner. Preserve that durable event binding
          // when the failure report has no replacement event identity.
          ...(incomingEventId == null && existingEventId !== undefined
            ? { eventId: existingEventId }
            : {}),
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
        const terminalCandidate = input.complete
          ? terminalAllowed
            ? ('completed' as const)
            : undefined
          : terminalAllowed
            ? ('failed' as const)
            : undefined;
        let terminalStatus = terminalCandidate;
        if (terminalStatus) {
          // A stalled Bull redelivery can run beside the original physical
          // delivery and has a distinct attempt key. Keep the shared ledger
          // open until every marker at this or a newer logical attempt has
          // settled; otherwise quiescence can pass while a sibling still has
          // provider or canonical-write work in flight.
          const runningSiblingRows = await tx
            .select({ one: sql`1` })
            .from(syncItemsInOps)
            .where(
              and(
                eq(syncItemsInOps.runId, runId),
                eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
                eq(syncItemsInOps.status, 'running'),
                sql`${syncItemsInOps.attempts} >= ${attempt}`,
                sql`${syncItemsInOps.normalizedPayload}->>'phase' = 'started'`,
              ),
            )
            .limit(1);
          if (runningSiblingRows.length > 0) terminalStatus = undefined;
        }
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
            ...currentCost,
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
                    completedItems: 0,
                    failedItems: 1,
                    skippedItems: 0,
                    dataChanged: false,
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

    entrySyncAudit: async (input: {
      seasonId: number;
      eventId: number;
      entryId: number;
      limit?: number;
    }): Promise<EntrySyncAuditStatus> => {
      const db = await getDbInstance();
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 200), 1), 500);
      const resourcePrefix = `${input.seasonId}:${input.eventId}:${input.entryId}:`;
      const auditWhere = and(
        eq(syncRunsInOps.seasonId, input.seasonId),
        eq(syncRunsInOps.eventId, input.eventId),
        eq(syncItemsInOps.resourceType, 'entry-event'),
        like(syncItemsInOps.resourceId, `${resourcePrefix}%`),
      );
      const newerAuditItems = alias(syncItemsInOps, 'entry_audit_newer_items');
      const newerAuditRuns = alias(syncRunsInOps, 'entry_audit_newer_runs');
      const supersededByLaterAttempt = exists(
        db
          .select({ one: sql`1` })
          .from(newerAuditItems)
          .innerJoin(newerAuditRuns, eq(newerAuditRuns.runId, newerAuditItems.runId))
          .where(
            and(
              eq(newerAuditRuns.seasonId, syncRunsInOps.seasonId),
              eq(newerAuditRuns.eventId, syncRunsInOps.eventId),
              eq(newerAuditItems.resourceType, syncItemsInOps.resourceType),
              eq(newerAuditItems.resourceId, syncItemsInOps.resourceId),
              or(
                gt(newerAuditRuns.createdAt, syncRunsInOps.createdAt),
                and(
                  eq(newerAuditRuns.createdAt, syncRunsInOps.createdAt),
                  gt(newerAuditRuns.runId, syncRunsInOps.runId),
                ),
              ),
            ),
          ),
      );
      const selectAuditRows = () =>
        db
          .select({
            runId: syncItemsInOps.runId,
            resourceId: syncItemsInOps.resourceId,
            trigger: syncRunsInOps.trigger,
            itemStatus: syncItemsInOps.status,
            attempts: syncItemsInOps.attempts,
            normalizedPayload: syncItemsInOps.normalizedPayload,
            itemCreatedAt: syncItemsInOps.createdAt,
            itemUpdatedAt: syncItemsInOps.updatedAt,
            runCreatedAt: syncRunsInOps.createdAt,
          })
          .from(syncItemsInOps)
          .innerJoin(syncRunsInOps, eq(syncRunsInOps.runId, syncItemsInOps.runId))
          .where(auditWhere);
      const eventRows = await db
        .select({
          finished: eventsInFpl.finished,
          dataChecked: eventsInFpl.dataChecked,
          dataCheckedAt: eventsInFpl.dataCheckedAt,
        })
        .from(eventsInFpl)
        .where(
          and(eq(eventsInFpl.seasonId, input.seasonId), eq(eventsInFpl.eventId, input.eventId)),
        )
        .limit(1);
      const eventFinalized = eventRows[0]?.finished === true && eventRows[0]?.dataChecked === true;
      const currentFinalizationRevision = eventRows[0]?.dataCheckedAt?.toISOString() ?? null;
      const finalResourceId = `${resourcePrefix}final`;
      const resultResourceId = `${resourcePrefix}results`;
      const transferResourceId = `${resourcePrefix}transfers`;
      const sourceRevisionAt = sql`
        CASE
          WHEN (${syncItemsInOps.normalizedPayload}->>'sourceRevision') ~
            '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
          THEN (${syncItemsInOps.normalizedPayload}->>'sourceRevision')::timestamptz
          ELSE NULL
        END
      `;
      const finalEvidencePredicate = sql`
        ${syncItemsInOps.resourceId} = ${finalResourceId}
        AND ${syncItemsInOps.status} IN ('completed', 'skipped')
        AND (${syncItemsInOps.normalizedPayload}->>'finalCompletion') = 'true'
        AND ${
          !eventFinalized
            ? sql`true`
            : currentFinalizationRevision === null
              ? sql`false`
              : sql`${sourceRevisionAt} >= ${currentFinalizationRevision}::timestamptz`
        }
      `;
      const resultEvidencePredicate = sql`
        ${syncItemsInOps.resourceId} = ${resultResourceId}
        AND ${syncItemsInOps.status} IN ('completed', 'skipped')
        AND (
          (${syncItemsInOps.normalizedPayload}->>'factCommit') IN ('committed', 'reused')
          OR (${syncItemsInOps.normalizedPayload}->>'reused') = 'true'
        )
      `;
      const resultEvidenceComplete = sql<boolean>`coalesce(
        bool_or(${resultEvidencePredicate}),
        false
      )`;
      const transferEvidencePredicate = sql`
        ${syncItemsInOps.resourceId} = ${transferResourceId}
        AND ${syncItemsInOps.status} IN ('completed', 'skipped')
        AND (
          (${syncItemsInOps.normalizedPayload}->>'factCommit') IN ('committed', 'reused')
          OR (${syncItemsInOps.normalizedPayload}->>'reused') = 'true'
        )
      `;
      const transferComponentPresent = sql<boolean>`coalesce(
        bool_or(${syncItemsInOps.resourceId} = ${transferResourceId}),
        false
      )`;
      const transferEvidenceComplete = sql<boolean>`coalesce(
        bool_or(${transferEvidencePredicate}),
        false
      )`;
      const finalEvidenceComplete = !eventFinalized
        ? sql<boolean>`true`
        : currentFinalizationRevision === null
          ? sql<boolean>`false`
          : sql<boolean>`coalesce(bool_or(${finalEvidencePredicate}), false)`;
      const [aggregateRows, recentRows] = await Promise.all([
        db
          .select({
            totalRows: sql<number>`count(*)::int`,
            executions: sql<number>`count(distinct ${syncRunsInOps.runId})::int`,
            eventLiveRequests: sql<number>`coalesce(sum(
              CASE
                WHEN (${syncItemsInOps.normalizedPayload}->>'eventLiveRequests') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (${syncItemsInOps.normalizedPayload}->>'eventLiveRequests')::double precision
                ELSE 0
              END
            ), 0)::double precision`,
            picksRequests: sql<number>`coalesce(sum(
              CASE
                WHEN (${syncItemsInOps.normalizedPayload}->>'picksRequests') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (${syncItemsInOps.normalizedPayload}->>'picksRequests')::double precision
                ELSE 0
              END
            ), 0)::double precision`,
            transfers: sql<number>`coalesce(sum(
              CASE
                WHEN (${syncItemsInOps.normalizedPayload}->>'transferRequests') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (${syncItemsInOps.normalizedPayload}->>'transferRequests')::double precision
                ELSE 0
              END
            ), 0)::double precision`,
            unknownRequests: sql<number>`coalesce(sum(
              CASE
                WHEN (${syncItemsInOps.normalizedPayload}->>'unknownRequests') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (${syncItemsInOps.normalizedPayload}->>'unknownRequests')::double precision
                ELSE 0
              END
            ), 0)::double precision`,
            factCommits: sql<number>`count(*) FILTER (
              WHERE (${syncItemsInOps.normalizedPayload}->>'factCommit') = 'committed'
            )::int`,
            finalCompletions: sql<number>`count(*) FILTER (WHERE ${finalEvidencePredicate})::int`,
            resultEvidenceComplete,
            reusedSkips: sql<number>`count(*) FILTER (
              WHERE ${syncItemsInOps.status} = 'skipped'
                OR (${syncItemsInOps.normalizedPayload}->>'reused') = 'true'
            )::int`,
            failedItems: sql<number>`count(*) FILTER (
              WHERE ${syncItemsInOps.status} = 'failed'
            )::int`,
            unaccountedItems: sql<number>`count(*) FILTER (
              WHERE NOT (
                ${syncItemsInOps.status} IN ('completed', 'skipped')
                OR (${syncItemsInOps.normalizedPayload}->>'unknownRequests') ~ '^-?[0-9]+([.][0-9]+)?$'
                OR ${supersededByLaterAttempt}
              )
            )::int`,
            finalEvidenceComplete,
            transferComponentPresent,
            transferEvidenceComplete,
            coverageStartAt: sql<string | Date | null>`min(
              coalesce(${syncItemsInOps.createdAt}, ${syncRunsInOps.createdAt})
            )`,
            triggers: sql<string[]>`coalesce(
              array_agg(distinct ${syncRunsInOps.trigger}) FILTER (WHERE ${syncRunsInOps.trigger} IS NOT NULL),
              ARRAY[]::text[]
            )`,
          })
          .from(syncItemsInOps)
          .innerJoin(syncRunsInOps, eq(syncRunsInOps.runId, syncItemsInOps.runId))
          .where(auditWhere),
        selectAuditRows()
          .orderBy(desc(syncItemsInOps.updatedAt), desc(syncItemsInOps.runId))
          .limit(limit + 1),
      ]);
      const truncated = recentRows.length > limit;
      const observedRows = recentRows.slice(0, limit);
      const payloadFor = (value: unknown): Record<string, unknown> =>
        isRecord(value) ? value : {};
      const numberValue = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      const stringValue = (value: unknown): string | null =>
        typeof value === 'string' && value.length > 0 ? value : null;
      const boolValue = (value: unknown): boolean => value === true;
      const componentFor = (resourceId: string): string =>
        resourceId.startsWith(resourcePrefix) ? resourceId.slice(resourcePrefix.length) : 'unknown';
      const recent = observedRows.map((row) => {
        const payload = payloadFor(row.normalizedPayload);
        return {
          runId: row.runId,
          trigger: row.trigger,
          component: componentFor(row.resourceId),
          status: row.itemStatus as SyncItemStatus,
          attempts: row.attempts,
          sourceRevision: stringValue(payload.sourceRevision),
          reuseReason: stringValue(payload.reuseReason),
          factCommit: stringValue(payload.factCommit),
          finalCompletion: boolValue(payload.finalCompletion),
          unknownRequests: numberValue(payload.unknownRequests),
          observedAt: (row.itemUpdatedAt ?? row.itemCreatedAt ?? row.runCreatedAt).toISOString(),
        };
      });
      const aggregate = aggregateRows[0];
      const totalRows = Number(aggregate?.totalRows ?? 0);
      const coverageStartAtValue = aggregate?.coverageStartAt;
      const coverageStartAt =
        coverageStartAtValue instanceof Date
          ? coverageStartAtValue.toISOString()
          : typeof coverageStartAtValue === 'string' &&
              !Number.isNaN(Date.parse(coverageStartAtValue))
            ? new Date(coverageStartAtValue).toISOString()
            : null;
      const evidenceComplete =
        totalRows > 0 &&
        aggregate?.resultEvidenceComplete === true &&
        aggregate?.finalEvidenceComplete === true &&
        (aggregate?.transferComponentPresent !== true ||
          aggregate?.transferEvidenceComplete === true) &&
        Number(aggregate?.unaccountedItems ?? 0) === 0;
      const reasonCodes =
        totalRows === 0
          ? ['SYNC_AUDIT_EVIDENCE_MISSING']
          : [
              ...(aggregate?.resultEvidenceComplete === true
                ? []
                : ['SYNC_AUDIT_RESULT_EVIDENCE_MISSING']),
              ...(aggregate?.finalEvidenceComplete === true
                ? []
                : ['SYNC_AUDIT_FINAL_EVIDENCE_MISSING']),
              ...(aggregate?.transferComponentPresent !== true ||
              aggregate?.transferEvidenceComplete === true
                ? []
                : ['SYNC_AUDIT_TRANSFER_EVIDENCE_MISSING']),
              ...(Number(aggregate?.unaccountedItems ?? 0) === 0
                ? []
                : ['SYNC_AUDIT_ITEMS_UNACCOUNTED']),
            ];
      return {
        schemaVersion: 'entry-sync-audit-v1',
        seasonId: input.seasonId,
        eventId: input.eventId,
        entryId: input.entryId,
        coverageStartAt,
        observedAt: new Date().toISOString(),
        available: totalRows > 0,
        reasonCodes,
        executions: Number(aggregate?.executions ?? 0),
        providerRequests: {
          eventLive: Number(aggregate?.eventLiveRequests ?? 0),
          picks: Number(aggregate?.picksRequests ?? 0),
          transfers: Number(aggregate?.transfers ?? 0),
          unknown: Number(aggregate?.unknownRequests ?? 0),
        },
        factCommits: Number(aggregate?.factCommits ?? 0),
        finalCompletions: Number(aggregate?.finalCompletions ?? 0),
        reusedSkips: Number(aggregate?.reusedSkips ?? 0),
        failedItems: Number(aggregate?.failedItems ?? 0),
        evidenceComplete,
        triggers: aggregate?.triggers ?? [],
        recent,
        truncated,
      };
    },

    /**
     * Close a running batch-cost marker when settlement cannot be persisted.
     * This is deliberately fenced by the marker's phase and attempt number:
     * an uncertain response after a committed settlement is left intact, and
     * a newer attempt cannot be reopened or hidden by an older failure.
     */
    markBatchCostSettlementFailure: async (
      runId: string,
      input: MarkSyncBatchCostSettlementFailureInput,
    ): Promise<boolean> => {
      if (!input.attemptKey.trim() || input.attemptKey.length > 240) {
        throw new DatabaseError('Batch cost attempt key is invalid', 'SYNC_BATCH_COST_KEY_INVALID');
      }
      const db = await getDbInstance();
      const summary = (
        input.error instanceof Error ? input.error.message : String(input.error)
      ).slice(0, 4_000);
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({ status: syncRunsInOps.status, metadata: syncRunsInOps.metadata })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const run = runRows[0];
        if (!run) return false;

        const itemRows = await tx
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
        const item = itemRows[0];
        const payload = isRecord(item?.normalizedPayload) ? item.normalizedPayload : null;
        if (!item || item.status !== 'running' || payload?.phase !== 'started') return false;

        const failurePayload = {
          ...payload,
          schemaVersion: 1,
          phase: 'settlement_failed',
          complete: false,
          incompleteReason: 'batch_cost_persistence_failed',
          settlementError: summary,
        };
        await tx
          .update(syncItemsInOps)
          .set({
            status: 'failed',
            lastError: summary,
            normalizedPayload: failurePayload,
            completedAt: sql`clock_timestamp()`,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
              eq(syncItemsInOps.resourceId, input.attemptKey),
              eq(syncItemsInOps.status, 'running'),
            ),
          );

        const currentMetadata = isRecord(run.metadata) ? run.metadata : {};
        const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
        const currentAttempts = isRecord(currentCost.attempts) ? currentCost.attempts : {};
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
        const terminalAllowed =
          attempt >= latestAttempt &&
          (currentTerminalAttempt === 0 || attempt >= currentTerminalAttempt);
        let closeRun =
          terminalAllowed && NON_TERMINAL_RUN_STATUSES.includes(run.status as SyncRunStatus);
        if (closeRun) {
          // A settlement failure has the same shared-run lifetime as a normal
          // settlement. Do not let one stalled redelivery terminalize the run
          // while a same-or-newer sibling marker is still executing.
          const runningSiblingRows = await tx
            .select({ one: sql`1` })
            .from(syncItemsInOps)
            .where(
              and(
                eq(syncItemsInOps.runId, runId),
                eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
                eq(syncItemsInOps.status, 'running'),
                sql`${syncItemsInOps.attempts} >= ${attempt}`,
                sql`${syncItemsInOps.normalizedPayload}->>'phase' = 'started'`,
              ),
            )
            .limit(1);
          if (runningSiblingRows.length > 0) closeRun = false;
        }
        const failedAttempt = {
          ...payload,
          schemaVersion: 1,
          attemptKey: input.attemptKey,
          attempt,
          phase: 'settlement_failed',
          complete: false,
          incompleteAccounting: true,
          incompleteReason: 'batch_cost_persistence_failed',
          settlementError: summary,
        };
        const nextMetadata = {
          ...currentMetadata,
          batchCost: {
            schemaVersion: 1,
            ...currentCost,
            attempts: { ...currentAttempts, [input.attemptKey]: failedAttempt },
            latestAttempt,
            ...(closeRun ? { terminalAttempt: attempt } : {}),
            incompleteAccounting: true,
            incompleteReason:
              typeof currentCost.incompleteReason === 'string'
                ? currentCost.incompleteReason
                : 'batch_cost_persistence_failed',
            lastSettlementFailureAt: new Date().toISOString(),
            lastSettlementFailure: {
              batchId: payload.batchId ?? null,
              attempt,
              error: summary,
            },
          },
        };
        await tx
          .update(syncRunsInOps)
          .set({
            metadata: nextMetadata,
            ...(closeRun
              ? {
                  status: 'failed',
                  failedItems: 1,
                  errorSummary: 'Data sync batch-cost settlement could not be persisted',
                  completedAt: sql`clock_timestamp()`,
                }
              : {}),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(syncRunsInOps.runId, runId));
        return true;
      });
    },

    /**
     * Reconcile a batch-cost marker when Bull has exhausted a job after the
     * business work committed but before runDataSyncAttempt reached its
     * settlement finally block. The marker is selected by the stable Bull
     * batch identity and attempt, so a later attempt can remain authoritative
     * without allowing this terminal callback to close its run.
     */
    reconcileBatchCostTerminalFailure: async (
      runId: string,
      input: ReconcileSyncBatchCostTerminalFailureInput,
    ): Promise<boolean> => {
      if (!input.batchId.trim() || input.batchId.length > 240) {
        throw new DatabaseError('Batch cost batch ID is invalid', 'SYNC_BATCH_COST_BATCH_INVALID');
      }
      const db = await getDbInstance();
      const summary = (
        input.error instanceof Error ? input.error.message : String(input.error)
      ).slice(0, 4_000);
      const attempt = Math.max(1, Math.floor(input.attempt));
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({ status: syncRunsInOps.status, metadata: syncRunsInOps.metadata })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const run = runRows[0];
        if (!run) return false;

        const itemRows = await tx
          .select({
            resourceId: syncItemsInOps.resourceId,
            attempts: syncItemsInOps.attempts,
            normalizedPayload: syncItemsInOps.normalizedPayload,
          })
          .from(syncItemsInOps)
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
              eq(syncItemsInOps.status, 'running'),
              eq(syncItemsInOps.attempts, attempt),
              sql`${syncItemsInOps.normalizedPayload}->>'batchId' = ${input.batchId}`,
              sql`${syncItemsInOps.normalizedPayload}->>'phase' = 'started'`,
            ),
          )
          .for('update');
        if (itemRows.length === 0) return false;

        const completedAt = sql`clock_timestamp()`;
        for (const item of itemRows) {
          const payload = isRecord(item.normalizedPayload) ? item.normalizedPayload : {};
          await tx
            .update(syncItemsInOps)
            .set({
              status: 'failed',
              lastError: summary,
              normalizedPayload: {
                ...payload,
                schemaVersion: 1,
                phase: 'settlement_failed',
                complete: false,
                incompleteReason: 'worker_terminal_failure',
                settlementError: summary,
                terminalFailureAttempt: attempt,
                terminalFailedAt: new Date().toISOString(),
              },
              completedAt,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                eq(syncItemsInOps.runId, runId),
                eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
                eq(syncItemsInOps.resourceId, item.resourceId),
                eq(syncItemsInOps.status, 'running'),
              ),
            );
        }

        const currentMetadata = isRecord(run.metadata) ? run.metadata : {};
        const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
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
        const latestAttempt = Math.max(currentLatestAttempt, attempt);
        const terminalAllowed =
          attempt >= latestAttempt &&
          (currentTerminalAttempt === 0 || attempt >= currentTerminalAttempt);
        const closeRun =
          terminalAllowed && NON_TERMINAL_RUN_STATUSES.includes(run.status as SyncRunStatus);
        const nextMetadata = {
          ...currentMetadata,
          batchCost: {
            schemaVersion: 1,
            ...currentCost,
            latestAttempt,
            ...(closeRun ? { terminalAttempt: attempt } : {}),
            incompleteAccounting: true,
            incompleteReason: 'worker_terminal_failure',
            lastTerminalFailureAt: new Date().toISOString(),
            lastTerminalFailure: {
              batchId: input.batchId,
              attempt,
              error: summary,
              markerCount: itemRows.length,
            },
          },
        };
        await tx
          .update(syncRunsInOps)
          .set({
            metadata: nextMetadata,
            ...(closeRun
              ? {
                  status: 'failed',
                  completedItems: 0,
                  failedItems: 1,
                  skippedItems: 0,
                  dataChanged: false,
                  errorSummary: 'Data sync batch-cost worker ended before settlement',
                  completedAt,
                }
              : {}),
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(syncRunsInOps.runId, runId));
        return true;
      });
    },

    /**
     * Close a legacy itemless batch-cost run left by a process that crashed
     * between creating the run row and its first marker. New executions use
     * startBatchCostRun, but this bounded repair keeps older rows from
     * blocking queue-quiescence forever.
     */
    reconcileBatchCostRunWithoutMarker: async (runId: string, error: unknown): Promise<boolean> => {
      const db = await getDbInstance();
      const summary = (error instanceof Error ? error.message : String(error)).slice(0, 4_000);
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({
            status: syncRunsInOps.status,
            mode: syncRunsInOps.mode,
            metadata: syncRunsInOps.metadata,
          })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const run = runRows[0];
        if (
          !run ||
          run.mode !== 'batch-cost' ||
          !NON_TERMINAL_RUN_STATUSES.includes(run.status as SyncRunStatus)
        ) {
          return false;
        }
        const markerRows = await tx
          .select({ one: sql`1` })
          .from(syncItemsInOps)
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
            ),
          )
          .limit(1);
        if (markerRows.length > 0) return false;

        const currentMetadata = isRecord(run.metadata) ? run.metadata : {};
        const currentCost = isRecord(currentMetadata.batchCost) ? currentMetadata.batchCost : {};
        const latestAttempt =
          typeof currentCost.latestAttempt === 'number' &&
          Number.isSafeInteger(currentCost.latestAttempt) &&
          currentCost.latestAttempt >= 1
            ? Math.floor(currentCost.latestAttempt)
            : 0;
        const completedAt = sql`clock_timestamp()`;
        await tx
          .update(syncRunsInOps)
          .set({
            status: 'failed',
            completedItems: 0,
            failedItems: 1,
            skippedItems: 0,
            dataChanged: false,
            errorSummary: 'Data sync batch-cost marker was never persisted',
            completedAt,
            metadata: {
              ...currentMetadata,
              batchCost: {
                schemaVersion: 1,
                ...currentCost,
                incompleteAccounting: true,
                incompleteReason: 'batch_cost_marker_missing',
                ...(latestAttempt > 0 ? { terminalAttempt: latestAttempt } : {}),
                lastTerminalFailureAt: new Date().toISOString(),
                lastTerminalFailure: {
                  error: summary,
                  markerCount: 0,
                  reason: 'batch_cost_marker_missing',
                },
              },
            },
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(syncRunsInOps.runId, runId),
              inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES]),
            ),
          );
        return true;
      });
    },

    /**
     * Reconcile direct-cron markers that outlived the API process. Direct cron
     * has no Bull `failed` event, so the next bounded tick adopts only old
     * launch-monitor markers from the exact lane/scope and closes them through
     * the same attempt fence used by queue workers.
     */
    reconcileStaleBatchCostMarkers: async (
      input: ReconcileStaleSyncBatchCostMarkersInput,
    ): Promise<number> => {
      if (!input.lane.trim() || !input.scope.trim()) {
        throw new DatabaseError(
          'Batch cost stale-marker scope is invalid',
          'SYNC_BATCH_COST_SCOPE_INVALID',
        );
      }
      if (!Number.isFinite(input.olderThanMs) || input.olderThanMs <= 0) {
        throw new DatabaseError(
          'Batch cost stale-marker age is invalid',
          'SYNC_BATCH_COST_AGE_INVALID',
        );
      }
      const limit = Math.min(Math.max(Math.floor(input.limit ?? 20), 1), 100);
      const db = await getDbInstance();
      const rows = await db
        .select({
          runId: syncItemsInOps.runId,
          attempts: syncItemsInOps.attempts,
          normalizedPayload: syncItemsInOps.normalizedPayload,
        })
        .from(syncItemsInOps)
        .innerJoin(syncRunsInOps, eq(syncRunsInOps.runId, syncItemsInOps.runId))
        .where(
          and(
            eq(syncRunsInOps.mode, 'batch-cost'),
            eq(syncRunsInOps.lane, input.lane),
            eq(syncRunsInOps.scope, input.scope),
            eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
            eq(syncItemsInOps.status, 'running'),
            lt(
              syncItemsInOps.updatedAt,
              sql`clock_timestamp() - (${Math.floor(input.olderThanMs)} * interval '1 millisecond')`,
            ),
          ),
        )
        .orderBy(asc(syncItemsInOps.updatedAt))
        .limit(limit);

      let reconciled = 0;
      for (const row of rows) {
        const payload = isRecord(row.normalizedPayload) ? row.normalizedPayload : {};
        const batchId = typeof payload.batchId === 'string' ? payload.batchId.trim() : '';
        if (!batchId) continue;
        const attempt =
          typeof payload.attempt === 'number' && Number.isFinite(payload.attempt)
            ? Math.max(1, Math.floor(payload.attempt))
            : Math.max(1, row.attempts);
        if (
          await syncOperationsRepository.reconcileBatchCostTerminalFailure(row.runId, {
            batchId,
            attempt,
            error: new Error('Direct cron process ended before batch-cost settlement'),
          })
        ) {
          reconciled += 1;
        }
      }

      // A legacy process could commit the run row and die before inserting
      // its first marker. Select only exact lane/scope rows with no marker and
      // use the remaining bounded budget so this maintenance pass cannot grow
      // with the historical backlog.
      const remaining = Math.max(0, limit - rows.length);
      if (remaining > 0) {
        const itemlessAlias = alias(syncItemsInOps, 'batch_cost_itemless_markers');
        const itemlessRuns = await db
          .select({ runId: syncRunsInOps.runId })
          .from(syncRunsInOps)
          .where(
            and(
              eq(syncRunsInOps.mode, 'batch-cost'),
              eq(syncRunsInOps.lane, input.lane),
              eq(syncRunsInOps.scope, input.scope),
              inArray(syncRunsInOps.status, [...NON_TERMINAL_RUN_STATUSES]),
              lt(
                syncRunsInOps.updatedAt,
                sql`clock_timestamp() - (${Math.floor(input.olderThanMs)} * interval '1 millisecond')`,
              ),
              not(
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(itemlessAlias)
                    .where(
                      and(
                        eq(itemlessAlias.runId, syncRunsInOps.runId),
                        eq(itemlessAlias.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
                      ),
                    ),
                ),
              ),
            ),
          )
          .orderBy(asc(syncRunsInOps.updatedAt))
          .limit(remaining);
        for (const row of itemlessRuns) {
          if (
            await syncOperationsRepository.reconcileBatchCostRunWithoutMarker(
              row.runId,
              new Error('Direct cron process ended before batch-cost marker creation'),
            )
          ) {
            reconciled += 1;
          }
        }
      }
      return reconciled;
    },

    /**
     * Attach a target event to the running marker after an unscoped worker has
     * resolved the canonical event. This is deliberately a small, locked
     * update so a crash after resolution still leaves an auditable scope even
     * when settlement never runs.
     */
    updateBatchCostTargetEvent: async (
      runId: string,
      attemptKey: string,
      eventId: number,
    ): Promise<boolean> => {
      if (
        !attemptKey.trim() ||
        attemptKey.length > 240 ||
        !Number.isSafeInteger(eventId) ||
        eventId <= 0
      ) {
        throw new DatabaseError(
          'Batch cost target event is invalid',
          'SYNC_BATCH_COST_EVENT_INVALID',
        );
      }
      const db = await getDbInstance();
      return db.transaction(async (tx) => {
        const runRows = await tx
          .select({ eventId: syncRunsInOps.eventId })
          .from(syncRunsInOps)
          .where(eq(syncRunsInOps.runId, runId))
          .for('update');
        const run = runRows[0];
        if (!run) return false;
        if (run.eventId !== null && run.eventId !== eventId) return false;
        const rows = await tx
          .select({
            status: syncItemsInOps.status,
            normalizedPayload: syncItemsInOps.normalizedPayload,
          })
          .from(syncItemsInOps)
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
              eq(syncItemsInOps.resourceId, attemptKey),
            ),
          )
          .for('update');
        const row = rows[0];
        const payload = isRecord(row?.normalizedPayload) ? row.normalizedPayload : null;
        if (!row || !payload || payload.phase !== 'started') return false;
        await tx
          .update(syncItemsInOps)
          .set({
            normalizedPayload: { ...payload, eventId },
            updatedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(syncItemsInOps.runId, runId),
              eq(syncItemsInOps.resourceType, SYNC_BATCH_COST_RESOURCE_TYPE),
              eq(syncItemsInOps.resourceId, attemptKey),
            ),
          );
        if (run.eventId === null) {
          await tx
            .update(syncRunsInOps)
            .set({ eventId, updatedAt: sql`clock_timestamp()` })
            .where(and(eq(syncRunsInOps.runId, runId), isNull(syncRunsInOps.eventId)));
        }
        return true;
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
            ...(input.metadata ? { metadata: input.metadata } : {}),
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
