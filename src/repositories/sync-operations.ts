import { createHash, randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import {
  datasetPublicationItemsInOps,
  datasetPublicationsInOps,
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
import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  contentHash,
  postgresJsonbContentHash,
  postgresJsonbCanonicalJson,
} from '../utils/content-hash';
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

export interface DatasetPublicationItemInput {
  readonly name: 'eventLive' | 'fixtures';
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

function hasFixtureBreakdownEvidence(value: unknown): value is EventLive {
  if (!isRecord(value) || !Array.isArray(value.fixtureBreakdown)) return false;
  const fixtureIds = new Set<number>();
  return value.fixtureBreakdown.every((fixture) => {
    if (
      !isRecord(fixture) ||
      !Number.isInteger(fixture.fixtureId) ||
      Number(fixture.fixtureId) <= 0 ||
      fixtureIds.has(Number(fixture.fixtureId)) ||
      !Array.isArray(fixture.stats)
    ) {
      return false;
    }
    fixtureIds.add(Number(fixture.fixtureId));
    const identifiers = new Set<string>();
    return fixture.stats.every((stat) => {
      if (
        !isRecord(stat) ||
        typeof stat.identifier !== 'string' ||
        stat.identifier.length === 0 ||
        identifiers.has(stat.identifier) ||
        typeof stat.value !== 'number' ||
        !Number.isFinite(stat.value) ||
        typeof stat.points !== 'number' ||
        !Number.isFinite(stat.points) ||
        (stat.pointsModification !== null &&
          (typeof stat.pointsModification !== 'number' ||
            !Number.isFinite(stat.pointsModification)))
      ) {
        return false;
      }
      identifiers.add(stat.identifier);
      return true;
    });
  });
}

function publicationItemCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return value === null || value === undefined ? 0 : 1;
}

function publicationPayloadChecksums(value: unknown): readonly string[] {
  try {
    const canonical = postgresJsonbCanonicalJson(value);
    const legacy = JSON.stringify(value);
    const checksums = [postgresJsonbContentHash(value), contentHash(value)];
    if (legacy !== canonical) {
      checksums.push(createHash('sha256').update(legacy, 'utf8').digest('hex'));
    }
    return checksums;
  } catch {
    return [];
  }
}

export const createSyncOperationsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const findActiveLivePublicationEvidence = async (
    season: FplSeasonRef,
    eventId: number,
  ): Promise<{
    manifest: DataPublicationManifest;
    eventLives: readonly EventLive[];
  } | null> => {
    const db = await getDbInstance();
    const rows = await db
      .select({
        publicationId: datasetPublicationsInOps.publicationId,
        revision: datasetPublicationsInOps.revision,
        manifest: datasetPublicationsInOps.manifest,
        itemName: datasetPublicationItemsInOps.itemName,
        itemCount: datasetPublicationItemsInOps.itemCount,
        checksum: datasetPublicationItemsInOps.checksum,
        payload: datasetPublicationItemsInOps.payload,
      })
      .from(datasetPublicationsInOps)
      .innerJoin(
        datasetPublicationItemsInOps,
        eq(datasetPublicationItemsInOps.publicationId, datasetPublicationsInOps.publicationId),
      )
      .where(
        and(
          publicationScope('fpl:live', season, eventId),
          eq(datasetPublicationsInOps.status, 'active'),
        ),
      );
    if (rows.length !== 2) return null;

    const first = rows[0];
    if (!first || !isDataPublicationId(first.publicationId)) return null;
    const manifest = parseDataPublicationManifest(
      typeof first.manifest === 'string' ? first.manifest : JSON.stringify(first.manifest),
    );
    if (
      !manifest ||
      manifest.dataset !== 'fpl:live' ||
      manifest.seasonCode !== season.seasonCode ||
      manifest.eventId !== eventId ||
      manifest.revision !== first.revision ||
      manifest.publicationId !== first.publicationId ||
      !['scheduled', 'live', 'settled'].includes(String(manifest.state)) ||
      !Array.isArray(manifest.items) ||
      manifest.items.length !== 2
    ) {
      return null;
    }

    for (const row of rows) {
      const manifestItem = manifest.items.find(
        (candidate) => isRecord(candidate) && candidate.name === row.itemName,
      );
      if (
        !manifestItem ||
        manifestItem.count !== row.itemCount ||
        manifestItem.sha256 !== row.checksum ||
        !publicationPayloadChecksums(row.payload).includes(row.checksum) ||
        publicationItemCount(row.payload) !== row.itemCount
      ) {
        return null;
      }
    }

    const eventLivePayload = rows.find((row) => row.itemName === 'eventLive')?.payload;
    const fixturesPayload = rows.find((row) => row.itemName === 'fixtures')?.payload;
    if (!Array.isArray(eventLivePayload) || !Array.isArray(fixturesPayload)) return null;
    // Every live revision after the fixture-grain rollout carries an
    // immutable per-fixture explanation on every player row. A retired
    // revision may still have a valid checksum after migration 0017, but
    // it is not safe to serve its legacy payload after a cache miss.
    if (!eventLivePayload.every(hasFixtureBreakdownEvidence)) return null;
    return { manifest, eventLives: eventLivePayload as EventLive[] };
  };

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
        const now = new Date();
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
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, ${now.toISOString()})`,
            updatedAt: now,
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
      const now = new Date();
      await db.transaction(async (tx) => {
        const expired = await tx
          .select({ publicationId: datasetPublicationsInOps.publicationId })
          .from(datasetPublicationsInOps)
          .where(
            and(
              lte(datasetPublicationsInOps.expiresAt, now),
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
          .set({ publicationId: null, updatedAt: now })
          .where(inArray(syncRunsInOps.publicationId, expiredIds));
        await tx
          .delete(datasetPublicationsInOps)
          .where(
            and(
              inArray(datasetPublicationsInOps.publicationId, expiredIds),
              lte(datasetPublicationsInOps.expiresAt, now),
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

    stagePublicationItems: async (
      publicationId: string,
      items: readonly DatasetPublicationItemInput[],
    ): Promise<void> => {
      if (items.length !== 2 || new Set(items.map((item) => item.name)).size !== 2) {
        throw new DatabaseError(
          'Live publication must stage exactly eventLive and fixtures',
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
          `Publication ${publicationId} does not contain a complete live item set`,
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

        if (input.dataset === 'fpl:live') {
          const itemRows = await tx
            .select({
              itemName: datasetPublicationItemsInOps.itemName,
              itemCount: datasetPublicationItemsInOps.itemCount,
              checksum: datasetPublicationItemsInOps.checksum,
            })
            .from(datasetPublicationItemsInOps)
            .where(eq(datasetPublicationItemsInOps.publicationId, input.publicationId));
          const manifestItems = input.manifest.items;
          if (
            itemRows.length !== 2 ||
            manifestItems.length !== 2 ||
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
              'Live publication item proof is incomplete',
              'DATASET_PUBLICATION_ITEMS_INCOMPLETE',
            );
          }
        }

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
            completedAt: sql`coalesce(${syncRunsInOps.completedAt}, ${now.toISOString()})`,
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

    findActivePublicationManifest: async (
      dataset: DataPublicationDataset,
      season: FplSeasonRef,
      eventId?: number,
    ): Promise<DataPublicationManifest | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({ manifest: datasetPublicationsInOps.manifest })
        .from(datasetPublicationsInOps)
        .where(
          and(
            publicationScope(dataset, season, eventId),
            eq(datasetPublicationsInOps.status, 'active'),
          ),
        )
        .limit(1);
      const raw = rows[0]?.manifest;
      if (!raw) return null;
      const manifest = parseDataPublicationManifest(
        typeof raw === 'string' ? raw : JSON.stringify(raw),
      );
      if (
        !manifest ||
        manifest.dataset !== dataset ||
        manifest.seasonCode !== season.seasonCode ||
        manifest.eventId !== (eventId ?? null)
      ) {
        return null;
      }
      return manifest;
    },

    findActiveLivePublicationEvidence,

    findActiveLiveEventLives: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<readonly EventLive[] | null> =>
      (await findActiveLivePublicationEvidence(season, eventId))?.eventLives ?? null,

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
