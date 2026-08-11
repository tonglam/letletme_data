import { randomUUID } from 'node:crypto';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  datasetPublicationsInOps,
  syncItemsInOps,
  syncRunsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  isDataPublicationId,
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

const NON_TERMINAL_RUN_STATUSES: readonly SyncRunStatus[] = [
  'pending',
  'running',
  'ready_to_publish',
];

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

export const createSyncOperationsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    startRun: async (input: StartSyncRunInput): Promise<string> => {
      const db = await getDbInstance();
      const runId = input.runId ?? randomUUID();
      const startedAt = input.startedAt ?? new Date();
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
          startedAt,
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
                  ELSE now()
                END
              `,
            },
          });
      }
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
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, now())`,
            updatedAt: new Date(),
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
          completedAt: new Date(),
          updatedAt: new Date(),
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
          expiresAt: new Date(Date.now() + 15 * 60 * 1_000),
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

    activatePublication: async (input: {
      publicationId: string;
      dataset: DataPublicationDataset;
      season: FplSeasonRef;
      eventId?: number;
      sourceRunId: string;
      manifest: DataPublicationManifest;
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

        const activeRows = await tx
          .select({
            publicationId: datasetPublicationsInOps.publicationId,
            revision: datasetPublicationsInOps.revision,
          })
          .from(datasetPublicationsInOps)
          .where(
            and(
              publicationScope(input.dataset, input.season, input.eventId),
              eq(datasetPublicationsInOps.status, 'active'),
            ),
          )
          .for('update');
        const newerActive = activeRows.find(
          (row) => row.publicationId !== input.publicationId && row.revision >= targetRow.revision,
        );
        if (newerActive) {
          throw new DatabaseError(
            'A newer dataset publication is already active for this scope',
            'DATASET_PUBLICATION_STALE_ACTIVATION',
          );
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

        const now = new Date();

        await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'retired',
            retiredAt: now,
            expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1_000),
            updatedAt: now,
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
            activatedAt: now,
            retiredAt: null,
            expiresAt: null,
            updatedAt: now,
          })
          .where(eq(datasetPublicationsInOps.publicationId, input.publicationId));

        await tx
          .update(syncRunsInOps)
          .set({
            status: 'published',
            publicationId: input.publicationId,
            dataChanged: true,
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, now())`,
            updatedAt: now,
          })
          .where(eq(syncRunsInOps.runId, input.sourceRunId));
      });
    },

    failPublication: async (publicationId: string, error: unknown): Promise<void> => {
      const db = await getDbInstance();
      const summary = error instanceof Error ? error.message : String(error);
      await db.transaction(async (tx) => {
        const rows = await tx
          .update(datasetPublicationsInOps)
          .set({ status: 'failed', expiresAt: new Date(), updatedAt: new Date() })
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
              completedAt: new Date(),
              updatedAt: new Date(),
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
        const now = new Date();
        const rows = await tx
          .update(datasetPublicationsInOps)
          .set({
            status: 'retired',
            retiredAt: now,
            expiresAt: new Date(now.getTime() + 15 * 60 * 1_000),
            updatedAt: now,
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
              completedAt: now,
              updatedAt: now,
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
