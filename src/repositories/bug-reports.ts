import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  bugReportRetentionBackupsInOps,
  bugReportStorageMigrationsInOps,
  bugReportsInOps,
} from '../db/schemas/platform.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import {
  retentionDeadline,
  type BugReportInsert,
  type BugReportStatus,
} from '../domain/bug-report';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

export type StoredBugReport = {
  id: string;
  publicId: string;
  createdAt: Date;
  status: BugReportStatus;
  closedAt: Date | null;
  expiresAt: Date;
  screenshotUrl: string | null;
  body: string;
  clientMeta: Record<string, unknown>;
  source: string;
  userId: string | null;
  entryId: number | null;
};

export type BugReportExpiryCursor = Pick<StoredBugReport, 'expiresAt' | 'id'>;
export type BugReportScreenshotCursor = Pick<StoredBugReport, 'createdAt' | 'id'>;
export type BugReportStorageDeletionCursor = { migratedAt: Date; id: string };
export type BugReportDeletionClaim = {
  report: StoredBugReport;
  screenshotUrl: string | null;
};

class ReportNoLongerExpiredError extends Error {
  constructor() {
    super('Bug report is no longer expired');
    this.name = 'ReportNoLongerExpiredError';
  }
}

export const createBugReportRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const screenshotUrlFromSnapshot = (snapshot: unknown): string | null => {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = (snapshot as Record<string, unknown>).screenshotUrl;
    return typeof value === 'string' ? value : null;
  };

  const insert = async (report: BugReportInsert): Promise<StoredBugReport> => {
    try {
      const db = await getDbInstance();
      const insertRow = async (connection: DbOrTransaction) => {
        if (report.screenshotUrl) {
          await connection.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${report.screenshotUrl}))`,
          );

          // A retention claim is a durable tombstone for its original object
          // locator. Checking it after the advisory lock means an insert that
          // started while cleanup was deleting the object cannot resurrect the
          // now-missing locator after the delete commits.
          const [retiredByRetention] = await connection
            .select({ id: bugReportRetentionBackupsInOps.id })
            .from(bugReportRetentionBackupsInOps)
            .where(
              and(
                sql`${bugReportRetentionBackupsInOps.snapshot}->>'screenshotUrl' = ${report.screenshotUrl}`,
                isNotNull(bugReportRetentionBackupsInOps.screenshotDeletedAt),
              ),
            )
            .limit(1);
          if (retiredByRetention) {
            throw new DatabaseError(
              'Screenshot locator has already been retired',
              'BUG_REPORT_SCREENSHOT_LOCATOR_RETIRED',
            );
          }

          const [retiredByMigration] = await connection
            .select({ id: bugReportStorageMigrationsInOps.id })
            .from(bugReportStorageMigrationsInOps)
            .where(
              and(
                eq(bugReportStorageMigrationsInOps.sourceLocator, report.screenshotUrl),
                isNotNull(bugReportStorageMigrationsInOps.deletedAt),
              ),
            )
            .limit(1);
          if (retiredByMigration) {
            throw new DatabaseError(
              'Screenshot locator has already been migrated and deleted',
              'BUG_REPORT_SCREENSHOT_LOCATOR_RETIRED',
            );
          }
        }
        const [row] = await connection
          .insert(bugReportsInOps)
          .values({
            id: report.id,
            publicId: report.publicId,
            source: report.source,
            userId: report.userId,
            entryId: report.entryId,
            body: report.body,
            screenshotUrl: report.screenshotUrl,
            clientMeta: report.clientMeta,
            status: 'open',
            closedAt: report.closedAt,
            expiresAt: report.expiresAt,
          })
          .returning({
            id: bugReportsInOps.id,
            publicId: bugReportsInOps.publicId,
            createdAt: bugReportsInOps.createdAt,
            status: bugReportsInOps.status,
            closedAt: bugReportsInOps.closedAt,
            expiresAt: bugReportsInOps.expiresAt,
            screenshotUrl: bugReportsInOps.screenshotUrl,
            body: bugReportsInOps.body,
            clientMeta: bugReportsInOps.clientMeta,
            source: bugReportsInOps.source,
            userId: bugReportsInOps.userId,
            entryId: bugReportsInOps.entryId,
          });
        return row;
      };
      const row = report.screenshotUrl ? await db.transaction(insertRow) : await insertRow(db);

      if (!row) {
        if (!report.submissionId) throw new DatabaseError('Bug report insert returned no row');
        const [existing] = await db
          .select({
            id: bugReportsInOps.id,
            publicId: bugReportsInOps.publicId,
            createdAt: bugReportsInOps.createdAt,
          })
          .from(bugReportsInOps)
          .where(eq(bugReportsInOps.submissionId, report.submissionId))
          .limit(1);
        if (!existing) throw new DatabaseError('Bug report insert returned no row');
        return existing;
      }
      return row as StoredBugReport;
    } catch (error) {
      logError('Failed to insert bug report', error);
      if (error instanceof DatabaseError) throw error;
      const databaseError = error as {
        code?: unknown;
        constraint?: unknown;
        constraint_name?: unknown;
      };
      const constraint = databaseError.constraint ?? databaseError.constraint_name;
      throw new DatabaseError(
        'Failed to store bug report',
        typeof databaseError.code === 'string' ? databaseError.code : undefined,
        error instanceof Error ? error : undefined,
        typeof constraint === 'string' ? constraint : undefined,
      );
    }
  };

  const findByPublicId = async (publicId: string) => {
    const db = await getDbInstance();
    const [row] = await db
      .select({
        id: bugReportsInOps.id,
        publicId: bugReportsInOps.publicId,
        createdAt: bugReportsInOps.createdAt,
        status: bugReportsInOps.status,
        closedAt: bugReportsInOps.closedAt,
        expiresAt: bugReportsInOps.expiresAt,
        screenshotUrl: bugReportsInOps.screenshotUrl,
        body: bugReportsInOps.body,
        clientMeta: bugReportsInOps.clientMeta,
        source: bugReportsInOps.source,
        userId: bugReportsInOps.userId,
        entryId: bugReportsInOps.entryId,
      })
      .from(bugReportsInOps)
      .where(eq(bugReportsInOps.publicId, publicId))
      .limit(1);
    return row as StoredBugReport | undefined;
  };

  const updateStatus = async (publicId: string, status: BugReportStatus, now: Date) => {
    const db = await getDbInstance();
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
          status: bugReportsInOps.status,
          closedAt: bugReportsInOps.closedAt,
          expiresAt: bugReportsInOps.expiresAt,
          screenshotUrl: bugReportsInOps.screenshotUrl,
          body: bugReportsInOps.body,
          clientMeta: bugReportsInOps.clientMeta,
          source: bugReportsInOps.source,
          userId: bugReportsInOps.userId,
          entryId: bugReportsInOps.entryId,
        })
        .from(bugReportsInOps)
        .where(eq(bugReportsInOps.publicId, publicId))
        .for('update')
        .limit(1);
      if (!current) return null;

      const [claim] = await tx
        .select({
          snapshot: bugReportRetentionBackupsInOps.snapshot,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, current.id))
        .limit(1);
      const screenshotUrl =
        claim && !claim.screenshotDeletedAt
          ? screenshotUrlFromSnapshot(claim.snapshot)
          : current.screenshotUrl;
      if (claim && !claim.screenshotDeletedAt) {
        await tx
          .delete(bugReportRetentionBackupsInOps)
          .where(eq(bugReportRetentionBackupsInOps.id, current.id));
      }

      const closedAt =
        status === 'closed'
          ? current.status === 'closed'
            ? (current.closedAt ?? now)
            : now
          : null;
      const expiresAt = retentionDeadline(current.createdAt, status, closedAt);
      const [row] = await tx
        .update(bugReportsInOps)
        .set({ status, closedAt, expiresAt, screenshotUrl })
        .where(eq(bugReportsInOps.id, current.id))
        .returning({
          publicId: bugReportsInOps.publicId,
          status: bugReportsInOps.status,
          closedAt: bugReportsInOps.closedAt,
          expiresAt: bugReportsInOps.expiresAt,
        });
      return row ?? null;
    });
  };

  const listExpired = async (now: Date, limit: number, after?: BugReportExpiryCursor) => {
    const cursor = after
      ? or(
          gt(bugReportsInOps.expiresAt, after.expiresAt),
          and(eq(bugReportsInOps.expiresAt, after.expiresAt), gt(bugReportsInOps.id, after.id)),
        )
      : undefined;
    const rows = await (
      await getDbInstance()
    )
      .select({
        id: bugReportsInOps.id,
        publicId: bugReportsInOps.publicId,
        createdAt: bugReportsInOps.createdAt,
        status: bugReportsInOps.status,
        closedAt: bugReportsInOps.closedAt,
        expiresAt: bugReportsInOps.expiresAt,
        screenshotUrl: bugReportsInOps.screenshotUrl,
        body: bugReportsInOps.body,
        clientMeta: bugReportsInOps.clientMeta,
        source: bugReportsInOps.source,
        userId: bugReportsInOps.userId,
        entryId: bugReportsInOps.entryId,
      })
      .from(bugReportsInOps)
      .where(
        cursor
          ? and(lte(bugReportsInOps.expiresAt, now), cursor)
          : lte(bugReportsInOps.expiresAt, now),
      )
      .orderBy(asc(bugReportsInOps.expiresAt), asc(bugReportsInOps.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows as StoredBugReport[];
  };

  const listWithScreenshots = async (limit: number, after?: BugReportScreenshotCursor) => {
    const cursor = after
      ? or(
          gt(bugReportsInOps.createdAt, after.createdAt),
          and(eq(bugReportsInOps.createdAt, after.createdAt), gt(bugReportsInOps.id, after.id)),
        )
      : undefined;
    const rows = await (
      await getDbInstance()
    )
      .select({
        id: bugReportsInOps.id,
        publicId: bugReportsInOps.publicId,
        createdAt: bugReportsInOps.createdAt,
        status: bugReportsInOps.status,
        closedAt: bugReportsInOps.closedAt,
        expiresAt: bugReportsInOps.expiresAt,
        screenshotUrl: bugReportsInOps.screenshotUrl,
        body: bugReportsInOps.body,
        clientMeta: bugReportsInOps.clientMeta,
        source: bugReportsInOps.source,
        userId: bugReportsInOps.userId,
        entryId: bugReportsInOps.entryId,
      })
      .from(bugReportsInOps)
      .where(
        cursor
          ? and(isNotNull(bugReportsInOps.screenshotUrl), cursor)
          : isNotNull(bugReportsInOps.screenshotUrl),
      )
      .orderBy(asc(bugReportsInOps.createdAt), asc(bugReportsInOps.id))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows as StoredBugReport[];
  };

  const listByScreenshotUrl = async (sourceLocator: string) => {
    const rows = await (
      await getDbInstance()
    )
      .select({
        id: bugReportsInOps.id,
        publicId: bugReportsInOps.publicId,
        createdAt: bugReportsInOps.createdAt,
        status: bugReportsInOps.status,
        closedAt: bugReportsInOps.closedAt,
        expiresAt: bugReportsInOps.expiresAt,
        screenshotUrl: bugReportsInOps.screenshotUrl,
        body: bugReportsInOps.body,
        clientMeta: bugReportsInOps.clientMeta,
        source: bugReportsInOps.source,
        userId: bugReportsInOps.userId,
        entryId: bugReportsInOps.entryId,
      })
      .from(bugReportsInOps)
      .where(eq(bugReportsInOps.screenshotUrl, sourceLocator));
    return rows as StoredBugReport[];
  };

  const updateScreenshotUrl = async (
    publicId: string,
    sourceLocator: string,
    targetLocator: string,
  ) => {
    const [row] = await (
      await getDbInstance()
    )
      .update(bugReportsInOps)
      .set({ screenshotUrl: targetLocator })
      .where(
        and(
          eq(bugReportsInOps.publicId, publicId),
          eq(bugReportsInOps.screenshotUrl, sourceLocator),
        ),
      )
      .returning({
        publicId: bugReportsInOps.publicId,
        screenshotUrl: bugReportsInOps.screenshotUrl,
      });
    return row ?? null;
  };

  const updateScreenshotUrls = async (sourceLocator: string, targetLocator: string) => {
    const rows = await (await getDbInstance())
      .update(bugReportsInOps)
      .set({ screenshotUrl: targetLocator })
      .where(eq(bugReportsInOps.screenshotUrl, sourceLocator))
      .returning({
        publicId: bugReportsInOps.publicId,
        screenshotUrl: bugReportsInOps.screenshotUrl,
      });
    return rows;
  };

  const migrateAndDeleteStorageLocator = async (
    sourceLocator: string,
    targetLocator: string,
    deleteSource: () => Promise<void>,
    now = new Date(),
  ): Promise<void> => {
    const db = await getDbInstance();
    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sourceLocator}))`);
      const [migration] = await tx
        .select({
          id: bugReportStorageMigrationsInOps.id,
          targetLocator: bugReportStorageMigrationsInOps.targetLocator,
          deletedAt: bugReportStorageMigrationsInOps.deletedAt,
        })
        .from(bugReportStorageMigrationsInOps)
        .where(eq(bugReportStorageMigrationsInOps.sourceLocator, sourceLocator))
        .for('update')
        .limit(1);
      if (!migration) throw new DatabaseError('Storage migration record is missing');
      if (migration.targetLocator !== targetLocator) {
        throw new DatabaseError('Storage migration target locator conflict');
      }
      if (migration.deletedAt) return;

      await tx
        .update(bugReportsInOps)
        .set({ screenshotUrl: targetLocator })
        .where(eq(bugReportsInOps.screenshotUrl, sourceLocator));
      const remaining = await tx
        .select({ id: bugReportsInOps.id })
        .from(bugReportsInOps)
        .where(eq(bugReportsInOps.screenshotUrl, sourceLocator))
        .limit(1);
      if (remaining.length > 0) {
        throw new DatabaseError('Storage migration compare-and-swap lost');
      }

      // Keep the locator lock until remote deletion and the durable completion
      // marker commit. Inserts either happen first (and are migrated above) or
      // see deleted_at and reject the retired locator after this transaction.
      await deleteSource();
      const [marked] = await tx
        .update(bugReportStorageMigrationsInOps)
        .set({ deletedAt: now })
        .where(
          and(
            eq(bugReportStorageMigrationsInOps.id, migration.id),
            isNull(bugReportStorageMigrationsInOps.deletedAt),
          ),
        )
        .returning({ id: bugReportStorageMigrationsInOps.id });
      if (!marked) throw new DatabaseError('Storage migration completion marker was lost');
    });
  };

  const recordStorageMigration = async (
    publicId: string,
    sourceLocator: string,
    targetLocator: string,
  ) => {
    const [row] = await (
      await getDbInstance()
    )
      .insert(bugReportStorageMigrationsInOps)
      .values({
        id: randomUUID(),
        publicId,
        sourceLocator,
        targetLocator,
      })
      .onConflictDoNothing({ target: bugReportStorageMigrationsInOps.sourceLocator })
      .returning({
        publicId: bugReportStorageMigrationsInOps.publicId,
        sourceLocator: bugReportStorageMigrationsInOps.sourceLocator,
        targetLocator: bugReportStorageMigrationsInOps.targetLocator,
        deletedAt: bugReportStorageMigrationsInOps.deletedAt,
      });
    if (row) return row;
    const [existing] = await (
      await getDbInstance()
    )
      .select({
        publicId: bugReportStorageMigrationsInOps.publicId,
        sourceLocator: bugReportStorageMigrationsInOps.sourceLocator,
        targetLocator: bugReportStorageMigrationsInOps.targetLocator,
        deletedAt: bugReportStorageMigrationsInOps.deletedAt,
      })
      .from(bugReportStorageMigrationsInOps)
      .where(eq(bugReportStorageMigrationsInOps.sourceLocator, sourceLocator))
      .limit(1);
    return existing ?? null;
  };

  const listPendingStorageDeletes = async (
    limit: number,
    after?: BugReportStorageDeletionCursor,
  ) => {
    const cursor = after
      ? or(
          gt(bugReportStorageMigrationsInOps.migratedAt, after.migratedAt),
          and(
            eq(bugReportStorageMigrationsInOps.migratedAt, after.migratedAt),
            gt(bugReportStorageMigrationsInOps.id, after.id),
          ),
        )
      : undefined;
    return (await (
      await getDbInstance()
    )
      .select({
        id: bugReportStorageMigrationsInOps.id,
        publicId: bugReportStorageMigrationsInOps.publicId,
        sourceLocator: bugReportStorageMigrationsInOps.sourceLocator,
        targetLocator: bugReportStorageMigrationsInOps.targetLocator,
        migratedAt: bugReportStorageMigrationsInOps.migratedAt,
      })
      .from(bugReportStorageMigrationsInOps)
      .where(
        cursor
          ? and(isNull(bugReportStorageMigrationsInOps.deletedAt), cursor)
          : isNull(bugReportStorageMigrationsInOps.deletedAt),
      )
      .orderBy(
        asc(bugReportStorageMigrationsInOps.migratedAt),
        asc(bugReportStorageMigrationsInOps.id),
      )
      .limit(Math.min(Math.max(limit, 1), 100))) as Array<{
      id: string;
      publicId: string;
      sourceLocator: string;
      targetLocator: string;
      migratedAt: Date;
    }>;
  };

  const markStorageDeleted = async (sourceLocator: string, now = new Date()) => {
    await (
      await getDbInstance()
    )
      .update(bugReportStorageMigrationsInOps)
      .set({ deletedAt: now })
      .where(
        and(
          eq(bugReportStorageMigrationsInOps.sourceLocator, sourceLocator),
          isNull(bugReportStorageMigrationsInOps.deletedAt),
        ),
      );
  };

  const claimForDeletion = async (
    report: StoredBugReport,
    now = new Date(),
  ): Promise<BugReportDeletionClaim | null> => {
    const db = await getDbInstance();
    return db.transaction(async (tx) => {
      const [current] = await tx
        .select({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
          status: bugReportsInOps.status,
          closedAt: bugReportsInOps.closedAt,
          expiresAt: bugReportsInOps.expiresAt,
          screenshotUrl: bugReportsInOps.screenshotUrl,
          body: bugReportsInOps.body,
          clientMeta: bugReportsInOps.clientMeta,
          source: bugReportsInOps.source,
          userId: bugReportsInOps.userId,
          entryId: bugReportsInOps.entryId,
        })
        .from(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, report.id), lte(bugReportsInOps.expiresAt, now)))
        .for('update')
        .limit(1);
      if (!current) return null;

      const [existingClaim] = await tx
        .select({
          snapshot: bugReportRetentionBackupsInOps.snapshot,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, current.id))
        .limit(1);
      const screenshotUrl =
        existingClaim && !existingClaim.screenshotDeletedAt
          ? screenshotUrlFromSnapshot(existingClaim.snapshot)
          : current.screenshotUrl;
      if (!existingClaim) {
        await tx
          .insert(bugReportRetentionBackupsInOps)
          .values({
            id: current.id,
            publicId: current.publicId,
            snapshot: current,
          })
          .onConflictDoNothing();
      }
      if (current.screenshotUrl !== null) {
        await tx
          .update(bugReportsInOps)
          .set({ screenshotUrl: null })
          .where(eq(bugReportsInOps.id, current.id));
      }
      return {
        report: { ...(current as StoredBugReport), screenshotUrl: null },
        screenshotUrl,
      };
    });
  };

  const finalizeClaimedDeletion = async (
    reportId: string,
    now = new Date(),
    beforeDelete?: () => Promise<boolean>,
  ): Promise<boolean> => {
    const db = await getDbInstance();
    try {
      await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: bugReportsInOps.id })
          .from(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
          .for('update')
          .limit(1);
        if (!current) throw new ReportNoLongerExpiredError();
        const [claim] = await tx
          .select({
            id: bugReportRetentionBackupsInOps.id,
            snapshot: bugReportRetentionBackupsInOps.snapshot,
            screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
          })
          .from(bugReportRetentionBackupsInOps)
          .where(eq(bugReportRetentionBackupsInOps.id, reportId))
          .limit(1);
        if (!claim) throw new ReportNoLongerExpiredError();
        const screenshotUrl = screenshotUrlFromSnapshot(claim.snapshot);
        if (screenshotUrl) {
          await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${screenshotUrl}))`);
        }
        const screenshotDeleted = claim.screenshotDeletedAt
          ? true
          : screenshotUrl
            ? (await beforeDelete?.()) === true
            : false;
        if (screenshotDeleted && screenshotUrl && !claim.screenshotDeletedAt) {
          await tx
            .update(bugReportRetentionBackupsInOps)
            .set({ screenshotDeletedAt: now })
            .where(eq(bugReportRetentionBackupsInOps.id, reportId));
        }
        const deleted = await tx
          .delete(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
          .returning({ id: bugReportsInOps.id });
        if (!deleted[0]) throw new ReportNoLongerExpiredError();
      });
      return true;
    } catch (error) {
      if (error instanceof ReportNoLongerExpiredError) return false;
      throw error;
    }
  };

  return {
    insert,
    findByPublicId,
    updateStatus,
    listExpired,
    listWithScreenshots,
    listByScreenshotUrl,
    updateScreenshotUrl,
    updateScreenshotUrls,
    migrateAndDeleteStorageLocator,
    recordStorageMigration,
    listPendingStorageDeletes,
    markStorageDeleted,
    claimForDeletion,
    finalizeClaimedDeletion,
  };
};

export const bugReportRepository = createBugReportRepository();

export type BugReportRepository = ReturnType<typeof createBugReportRepository>;
