import { randomUUID } from 'node:crypto';

import { and, asc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
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

class ReportNoLongerExpiredError extends Error {
  constructor() {
    super('Bug report is no longer expired');
    this.name = 'ReportNoLongerExpiredError';
  }
}

export const createBugReportRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const insert = async (report: BugReportInsert): Promise<StoredBugReport> => {
    try {
      const db = await getDbInstance();
      const [row] = await db
        .insert(bugReportsInOps)
        .values({
          id: report.id,
          publicId: report.publicId,
          source: report.source,
          userId: report.userId,
          entryId: report.entryId,
          body: report.body,
          submissionId: report.submissionId,
          screenshotObjectKey: report.screenshotObjectKey,
          screenshotUrl: report.screenshotUrl,
          clientMeta: report.clientMeta,
          status: 'open',
          closedAt: report.closedAt,
          expiresAt: report.expiresAt,
        })
        .onConflictDoNothing({ target: bugReportsInOps.submissionId })
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
    const current = await findByPublicId(publicId);
    if (!current) return null;
    const closedAt = status === 'closed' ? (current.closedAt ?? now) : null;
    const expiresAt = retentionDeadline(current.createdAt, status, closedAt);
    const [row] = await (await getDbInstance())
      .update(bugReportsInOps)
      .set({ status, closedAt, expiresAt })
      .where(eq(bugReportsInOps.publicId, publicId))
      .returning({
        publicId: bugReportsInOps.publicId,
        status: bugReportsInOps.status,
        closedAt: bugReportsInOps.closedAt,
        expiresAt: bugReportsInOps.expiresAt,
      });
    return row ?? null;
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

  const backupAndDelete = async (
    report: StoredBugReport,
    now = new Date(),
    beforeDelete?: (current: StoredBugReport) => Promise<void>,
  ) => {
    const db = await getDbInstance();
    try {
      await db.transaction(async (tx) => {
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

        if (!current) throw new ReportNoLongerExpiredError();
        const currentReport = current as StoredBugReport;
        await beforeDelete?.(currentReport);
        await tx
          .insert(bugReportRetentionBackupsInOps)
          .values({
            id: currentReport.id,
            publicId: currentReport.publicId,
            snapshot: currentReport,
          })
          .onConflictDoNothing();

        const deleted = await tx
          .delete(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, currentReport.id), lte(bugReportsInOps.expiresAt, now)))
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
    recordStorageMigration,
    listPendingStorageDeletes,
    markStorageDeleted,
    backupAndDelete,
  };
};

export const bugReportRepository = createBugReportRepository();

export type BugReportRepository = ReturnType<typeof createBugReportRepository>;
