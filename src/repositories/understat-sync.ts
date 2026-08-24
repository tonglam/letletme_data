import { and, asc, desc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';

import {
  syncItemsInOps as understatSyncItems,
  syncRunsInOps as understatSyncRuns,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type {
  UnderstatLane,
  UnderstatSyncItem,
  UnderstatSyncMode,
  UnderstatSyncRun,
  UnderstatSyncTrigger,
} from '../domain/understat';

async function getDatabase(dbInstance?: DbOrTransaction): Promise<DbOrTransaction> {
  return dbInstance ?? (await getDb());
}

const ACTIVE_RUN_STATUSES = ['pending', 'running', 'ready_to_publish'] as const;

function runIsActive(runId: string) {
  return sql<boolean>`exists (
    select 1
    from ${understatSyncRuns}
    where ${understatSyncRuns.runId} = ${runId}
      and ${understatSyncRuns.status} in ('pending', 'running', 'ready_to_publish')
  )`;
}

function mapRun(row: typeof understatSyncRuns.$inferSelect): UnderstatSyncRun {
  if (row.provider !== 'understat') {
    throw new Error(`Expected Understat sync run, received provider ${row.provider}`);
  }
  if (row.lane !== 'team' && row.lane !== 'player') {
    throw new Error(`Invalid Understat lane: ${row.lane}`);
  }
  if (!row.seasonCode) throw new Error(`Understat sync run ${row.runId} has no season code`);
  if (!['incremental', 'full', 'reconcile'].includes(row.mode)) {
    throw new Error(`Invalid Understat sync mode: ${row.mode}`);
  }
  if (!['cron', 'manual', 'api'].includes(row.trigger)) {
    throw new Error(`Invalid Understat sync trigger: ${row.trigger}`);
  }
  if (
    ![
      'pending',
      'running',
      'failed',
      'completed',
      'ready_to_publish',
      'published',
      'skipped',
    ].includes(row.status)
  ) {
    throw new Error(`Invalid Understat sync status: ${row.status}`);
  }
  return {
    runId: row.runId,
    lane: row.lane,
    season: row.seasonCode,
    mode: row.mode as UnderstatSyncMode,
    trigger: row.trigger as UnderstatSyncTrigger,
    status: row.status as UnderstatSyncRun['status'],
    expectedItems: row.expectedItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    dataChanged: row.dataChanged,
    publicationId: row.publicationId,
    metadata: row.metadata as Record<string, unknown>,
    errorSummary: row.errorSummary,
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    completedAt: row.completedAt,
  };
}

function mapItem(row: typeof understatSyncItems.$inferSelect): UnderstatSyncItem {
  if (!['pending', 'running', 'failed', 'completed', 'skipped'].includes(row.status)) {
    throw new Error(`Invalid Understat sync item status: ${row.status}`);
  }
  return {
    runId: row.runId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    status: row.status as UnderstatSyncItem['status'],
    attempts: row.attempts,
    sourceHash: row.sourceHash,
    normalizedPayload: row.normalizedPayload as Record<string, unknown> | null,
    lastError: row.lastError,
    completedAt: row.completedAt,
  };
}

export interface CreateUnderstatRunInput {
  runId: string;
  lane: UnderstatLane;
  season: string;
  mode: UnderstatSyncMode;
  trigger: UnderstatSyncTrigger;
  dataChanged?: boolean;
  obligationId?: string;
  obligationGeneration?: number;
}

export interface CreateUnderstatItemInput {
  resourceType: string;
  resourceId: string;
}

export const createUnderstatSyncRepository = (dbInstance?: DbOrTransaction) => ({
  async createRun(input: CreateUnderstatRunInput): Promise<UnderstatSyncRun> {
    const db = await getDatabase(dbInstance);
    await db
      .insert(understatSyncRuns)
      .values({
        runId: input.runId,
        provider: 'understat',
        lane: input.lane,
        scope: `understat.${input.lane}`,
        seasonCode: input.season,
        mode: input.mode,
        trigger: input.trigger,
        status: 'running',
        dataChanged: input.dataChanged ?? false,
        metadata: {
          ...(input.obligationId
            ? {
                obligationId: input.obligationId,
                ...(input.obligationGeneration === undefined
                  ? {}
                  : { obligationGeneration: input.obligationGeneration }),
              }
            : {}),
        },
        startedAt: sql`clock_timestamp()`,
      })
      .onConflictDoNothing({ target: understatSyncRuns.runId });
    const [row] = await db
      .select()
      .from(understatSyncRuns)
      .where(eq(understatSyncRuns.runId, input.runId))
      .limit(1);
    if (!row) throw new Error(`Failed to create Understat sync run ${input.runId}`);
    if (
      row.provider !== 'understat' ||
      row.lane !== input.lane ||
      row.scope !== `understat.${input.lane}` ||
      row.seasonId !== null ||
      row.seasonCode !== input.season ||
      row.eventId !== null ||
      row.mode !== input.mode ||
      row.trigger !== input.trigger
    ) {
      throw new Error(`Understat sync run identity conflict: ${input.runId}`);
    }
    return mapRun(row);
  },

  async addItems(runId: string, items: CreateUnderstatItemInput[]): Promise<number> {
    const unique = [
      ...new Map(items.map((item) => [`${item.resourceType}:${item.resourceId}`, item])).values(),
    ];
    const db = await getDatabase(dbInstance);
    const [run] = await db
      .select({ status: understatSyncRuns.status })
      .from(understatSyncRuns)
      .where(eq(understatSyncRuns.runId, runId))
      .limit(1);
    if (!run) throw new Error(`Understat sync run not found: ${runId}`);
    if (!ACTIVE_RUN_STATUSES.includes(run.status as (typeof ACTIVE_RUN_STATUSES)[number])) {
      const [countRow] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(understatSyncItems)
        .where(eq(understatSyncItems.runId, runId));
      return countRow?.count ?? 0;
    }
    if (unique.length > 0) {
      await db
        .insert(understatSyncItems)
        .values(unique.map((item) => ({ runId, ...item, status: 'pending' as const })))
        .onConflictDoNothing();
    }
    const [countRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(understatSyncItems)
      .where(eq(understatSyncItems.runId, runId));
    const expectedItems = countRow?.count ?? 0;
    await db
      .update(understatSyncRuns)
      .set({ expectedItems, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
    return expectedItems;
  },

  async markItemRunning(runId: string, resourceType: string, resourceId: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncItems)
      .set({
        status: 'running',
        attempts: sql`${understatSyncItems.attempts} + 1`,
        lastError: null,
      })
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
          notInArray(understatSyncItems.status, ['completed', 'skipped']),
          runIsActive(runId),
        ),
      );
  },

  async completeItem(
    runId: string,
    resourceType: string,
    resourceId: string,
    sourceHash: string,
    normalizedPayload: Record<string, unknown>,
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const updated = await db
      .update(understatSyncItems)
      .set({
        status: 'completed',
        sourceHash,
        normalizedPayload,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
          notInArray(understatSyncItems.status, ['completed', 'skipped']),
          runIsActive(runId),
        ),
      )
      .returning({ runId: understatSyncItems.runId });
    if (updated.length === 0) return false;
    return this.refreshRun(runId);
  },

  async failItem(
    runId: string,
    resourceType: string,
    resourceId: string,
    error: string,
  ): Promise<void> {
    const db = await getDatabase(dbInstance);
    const updatedItem = await db
      .update(understatSyncItems)
      .set({ status: 'failed', lastError: error, completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
          notInArray(understatSyncItems.status, ['completed', 'skipped']),
          runIsActive(runId),
        ),
      )
      .returning({ runId: understatSyncItems.runId });
    if (updatedItem.length === 0) return;
    await db
      .update(understatSyncRuns)
      .set({ errorSummary: error, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
    await this.refreshRun(runId);
  },

  async refreshRun(runId: string): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select({ status: understatSyncItems.status, count: sql<number>`count(*)::int` })
      .from(understatSyncItems)
      .where(eq(understatSyncItems.runId, runId))
      .groupBy(understatSyncItems.status);
    const counts = new Map(rows.map((row) => [row.status, row.count]));
    const completedItems = counts.get('completed') ?? 0;
    const skippedItems = counts.get('skipped') ?? 0;
    const failedItems = counts.get('failed') ?? 0;
    const pendingItems = (counts.get('pending') ?? 0) + (counts.get('running') ?? 0);
    const settled = pendingItems === 0;
    const ready = pendingItems === 0 && failedItems === 0;
    const updated = await db
      .update(understatSyncRuns)
      .set({
        completedItems,
        skippedItems,
        failedItems,
        status: !settled ? 'running' : failedItems > 0 ? 'failed' : 'ready_to_publish',
        completedAt: settled ? sql`clock_timestamp()` : null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      )
      .returning({ runId: understatSyncRuns.runId });
    return updated.length > 0 && ready;
  },

  async markRunFailed(runId: string, error: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'failed',
        errorSummary: error,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
  },

  /**
   * Mark a run failed only after every staged item has settled. A terminal
   * BullMQ attempt may arrive while sibling detail jobs are still active;
   * leaving the run active in that window prevents the scheduler from
   * starting a replacement generation against the same season.
   */
  async markRunFailedIfSettled(runId: string, error: string): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const updated = await db
      .update(understatSyncRuns)
      .set({
        status: 'failed',
        errorSummary: error,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
          sql`not exists (
            select 1
            from ${understatSyncItems} as active_item
            where active_item.run_id = ${understatSyncRuns.runId}
              and active_item.status in ('pending', 'running')
          )`,
        ),
      )
      .returning({ runId: understatSyncRuns.runId });
    return updated.length === 1;
  },

  async markRunCompleted(
    runId: string,
    metadata: Record<string, unknown> = {},
    dataChanged?: boolean,
  ): Promise<void> {
    const db = await getDatabase(dbInstance);
    const [current] = await db
      .select({ metadata: understatSyncRuns.metadata })
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      )
      .limit(1);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'completed',
        metadata: { ...((current?.metadata ?? {}) as Record<string, unknown>), ...metadata },
        ...(dataChanged === undefined
          ? {}
          : { dataChanged: sql`${understatSyncRuns.dataChanged} OR ${dataChanged}` }),
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
  },

  async markRunDataChanged(runId: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({ dataChanged: true, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
  },

  async markRunSkipped(
    runId: string,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const db = await getDatabase(dbInstance);
    const [current] = await db
      .select({ metadata: understatSyncRuns.metadata })
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      )
      .limit(1);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'skipped',
        metadata: {
          ...((current?.metadata ?? {}) as Record<string, unknown>),
          finalized: false,
          reason,
          ...metadata,
        },
        dataChanged: false,
        completedAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(understatSyncRuns.runId, runId),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
        ),
      );
  },

  async findRun(runId: string): Promise<UnderstatSyncRun | null> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .select()
      .from(understatSyncRuns)
      .where(eq(understatSyncRuns.runId, runId))
      .limit(1);
    return row ? mapRun(row) : null;
  },

  async findActiveRun(
    season: string,
    lane: UnderstatLane,
    excludeRunId?: string,
  ): Promise<UnderstatSyncRun | null> {
    const db = await getDatabase(dbInstance);
    const conditions = [
      eq(understatSyncRuns.provider, 'understat'),
      eq(understatSyncRuns.seasonCode, season),
      eq(understatSyncRuns.lane, lane),
      inArray(understatSyncRuns.status, ['pending', 'running', 'ready_to_publish']),
    ];
    if (excludeRunId) conditions.push(sql`${understatSyncRuns.runId} <> ${excludeRunId}`);
    const [row] = await db
      .select()
      .from(understatSyncRuns)
      .where(and(...conditions))
      .orderBy(desc(understatSyncRuns.startedAt))
      .limit(1);
    return row ? mapRun(row) : null;
  },

  async findOrphanedRuns(cutoff: Date): Promise<UnderstatSyncRun[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.provider, 'understat'),
          inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
          lte(understatSyncRuns.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(understatSyncRuns.updatedAt));
    return rows.map(mapRun);
  },

  async markOrphanedRun(input: {
    runId: string;
    error: string;
    recoveredAt?: Date;
  }): Promise<{ run: UnderstatSyncRun; failedItems: number } | null> {
    const db = await getDatabase(dbInstance);
    return db.transaction(async (tx) => {
      const [run] = await tx
        .select()
        .from(understatSyncRuns)
        .where(
          and(
            eq(understatSyncRuns.runId, input.runId),
            inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
          ),
        )
        .for('update')
        .limit(1);
      if (!run) return null;

      const failedRows = await tx
        .update(understatSyncItems)
        .set({
          status: 'failed',
          lastError: input.error,
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(understatSyncItems.runId, input.runId),
            inArray(understatSyncItems.status, ['pending', 'running']),
          ),
        )
        .returning({ runId: understatSyncItems.runId });
      const counts = await tx
        .select({ status: understatSyncItems.status, count: sql<number>`count(*)::int` })
        .from(understatSyncItems)
        .where(eq(understatSyncItems.runId, input.runId))
        .groupBy(understatSyncItems.status);
      const countByStatus = new Map(counts.map((row) => [row.status, row.count]));
      const recovery = {
        state: 'orphaned',
        failedAt: (input.recoveredAt ?? new Date()).toISOString(),
        failedItems: failedRows.length,
      };
      const [updated] = await tx
        .update(understatSyncRuns)
        .set({
          completedItems: countByStatus.get('completed') ?? 0,
          skippedItems: countByStatus.get('skipped') ?? 0,
          failedItems: countByStatus.get('failed') ?? 0,
          status: 'failed',
          errorSummary: input.error,
          metadata: {
            ...((run.metadata ?? {}) as Record<string, unknown>),
            recovery,
          },
          completedAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(understatSyncRuns.runId, input.runId),
            inArray(understatSyncRuns.status, ACTIVE_RUN_STATUSES),
          ),
        )
        .returning();
      if (!updated) return null;
      return { run: mapRun(updated), failedItems: failedRows.length };
    });
  },

  async findItems(runId: string): Promise<UnderstatSyncItem[]> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatSyncItems)
      .where(eq(understatSyncItems.runId, runId));
    return rows.map(mapItem);
  },

  async findItem(
    runId: string,
    resourceType: string,
    resourceId: string,
  ): Promise<UnderstatSyncItem | null> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .select()
      .from(understatSyncItems)
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
        ),
      )
      .limit(1);
    return row ? mapItem(row) : null;
  },

  async findLatestRuns(season: string): Promise<Record<UnderstatLane, UnderstatSyncRun | null>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.provider, 'understat'),
          eq(understatSyncRuns.seasonCode, season),
          inArray(understatSyncRuns.lane, ['team', 'player']),
        ),
      )
      .orderBy(desc(understatSyncRuns.startedAt));
    return {
      team: rows.find((row) => row.lane === 'team')
        ? mapRun(rows.find((row) => row.lane === 'team')!)
        : null,
      player: rows.find((row) => row.lane === 'player')
        ? mapRun(rows.find((row) => row.lane === 'player')!)
        : null,
    };
  },
});

export const understatSyncRepository = createUnderstatSyncRepository();
