import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';

import { understatSyncItems, understatSyncRuns } from '../db/schemas/index.schema';
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

function mapRun(row: typeof understatSyncRuns.$inferSelect): UnderstatSyncRun {
  return {
    runId: row.runId,
    lane: row.lane,
    season: row.season,
    mode: row.mode,
    trigger: row.trigger,
    status: row.status,
    expectedItems: row.expectedItems,
    completedItems: row.completedItems,
    failedItems: row.failedItems,
    skippedItems: row.skippedItems,
    dataChanged: row.dataChanged,
    cacheRevision: row.cacheRevision,
    publicationSkipReason: row.publicationSkipReason,
    errorSummary: row.errorSummary,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  };
}

function mapItem(row: typeof understatSyncItems.$inferSelect): UnderstatSyncItem {
  return {
    runId: row.runId,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    status: row.status,
    attempts: row.attempts,
    sourceHash: row.sourceHash,
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
        ...input,
        status: 'running',
        dataChanged: input.dataChanged ?? false,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: understatSyncRuns.runId });
    const [row] = await db
      .select()
      .from(understatSyncRuns)
      .where(eq(understatSyncRuns.runId, input.runId))
      .limit(1);
    if (!row) throw new Error(`Failed to create Understat sync run ${input.runId}`);
    if (row.lane !== input.lane || row.season !== input.season) {
      throw new Error(`Understat sync run identity conflict: ${input.runId}`);
    }
    return mapRun(row);
  },

  async addItems(runId: string, items: CreateUnderstatItemInput[]): Promise<number> {
    const unique = [
      ...new Map(items.map((item) => [`${item.resourceType}:${item.resourceId}`, item])).values(),
    ];
    const db = await getDatabase(dbInstance);
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
      .set({ expectedItems, updatedAt: new Date() })
      .where(eq(understatSyncRuns.runId, runId));
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
        ),
      );
  },

  async completeItem(
    runId: string,
    resourceType: string,
    resourceId: string,
    sourceHash: string | null,
    changed: boolean,
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncItems)
      .set({ status: changed ? 'completed' : 'skipped', sourceHash, completedAt: new Date() })
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
        ),
      );
    if (changed) {
      await db
        .update(understatSyncRuns)
        .set({ dataChanged: true, updatedAt: new Date() })
        .where(eq(understatSyncRuns.runId, runId));
    }
    return this.refreshRun(runId);
  },

  async failItem(
    runId: string,
    resourceType: string,
    resourceId: string,
    error: string,
  ): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncItems)
      .set({ status: 'failed', lastError: error, completedAt: new Date() })
      .where(
        and(
          eq(understatSyncItems.runId, runId),
          eq(understatSyncItems.resourceType, resourceType),
          eq(understatSyncItems.resourceId, resourceId),
        ),
      );
    await db
      .update(understatSyncRuns)
      .set({ errorSummary: error, updatedAt: new Date() })
      .where(eq(understatSyncRuns.runId, runId));
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
    await db
      .update(understatSyncRuns)
      .set({
        completedItems,
        skippedItems,
        failedItems,
        status: !settled ? 'running' : failedItems > 0 ? 'failed' : 'ready_to_publish',
        completedAt: settled ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(eq(understatSyncRuns.runId, runId));
    return ready;
  },

  async markRunFailed(runId: string, error: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'failed',
        errorSummary: error,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(understatSyncRuns.runId, runId));
  },

  async markCompletedWithoutPublish(runId: string, reason: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'completed',
        publicationSkipReason: reason,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(understatSyncRuns.runId, runId));
  },

  async markDataChanged(runId: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({ dataChanged: true, updatedAt: new Date() })
      .where(eq(understatSyncRuns.runId, runId));
  },

  async markPublished(runId: string, revision: string): Promise<void> {
    const db = await getDatabase(dbInstance);
    await db
      .update(understatSyncRuns)
      .set({
        status: 'published',
        cacheRevision: revision,
        publicationSkipReason: null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(understatSyncRuns.runId, runId));
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
      eq(understatSyncRuns.season, season),
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
          eq(understatSyncRuns.season, season),
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

  async findLatestPublishedRuns(
    season: string,
  ): Promise<Record<UnderstatLane, UnderstatSyncRun | null>> {
    const db = await getDatabase(dbInstance);
    const rows = await db
      .select()
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.season, season),
          eq(understatSyncRuns.status, 'published'),
          inArray(understatSyncRuns.lane, ['team', 'player']),
        ),
      )
      .orderBy(desc(understatSyncRuns.completedAt));
    const team = rows.find((row) => row.lane === 'team');
    const player = rows.find((row) => row.lane === 'player');
    return { team: team ? mapRun(team) : null, player: player ? mapRun(player) : null };
  },

  async hasDataChangesSince(
    season: string,
    lane: UnderstatLane,
    publishedAt: Date,
  ): Promise<boolean> {
    const db = await getDatabase(dbInstance);
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(understatSyncRuns)
      .where(
        and(
          eq(understatSyncRuns.season, season),
          eq(understatSyncRuns.lane, lane),
          eq(understatSyncRuns.dataChanged, true),
          gt(understatSyncRuns.startedAt, publishedAt),
        ),
      );
    return (row?.count ?? 0) > 0;
  },
});

export const understatSyncRepository = createUnderstatSyncRepository();
