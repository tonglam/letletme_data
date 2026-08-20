import { randomUUID } from 'node:crypto';

import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
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

export type ExpiredBugReportScreenshot = {
  id: string;
  screenshotObjectKey: string;
  createdAt: Date;
};

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

  const listExpired = async (now: Date, limit: number) => {
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
      .where(lte(bugReportsInOps.expiresAt, now))
      .orderBy(asc(bugReportsInOps.expiresAt))
      .limit(Math.min(Math.max(limit, 1), 100));
    return rows as StoredBugReport[];
  };

  const listWithScreenshots = async (limit: number) => {
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
      .where(isNotNull(bugReportsInOps.screenshotUrl))
      .orderBy(asc(bugReportsInOps.createdAt))
      .limit(Math.min(Math.max(limit, 1), 100));
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

  const listPendingStorageDeletes = async (limit: number) =>
    (await (
      await getDbInstance()
    )
      .select({
        publicId: bugReportStorageMigrationsInOps.publicId,
        sourceLocator: bugReportStorageMigrationsInOps.sourceLocator,
        targetLocator: bugReportStorageMigrationsInOps.targetLocator,
      })
      .from(bugReportStorageMigrationsInOps)
      .where(isNull(bugReportStorageMigrationsInOps.deletedAt))
      .orderBy(asc(bugReportStorageMigrationsInOps.migratedAt))
      .limit(Math.min(Math.max(limit, 1), 100))) as Array<{
      publicId: string;
      sourceLocator: string;
      targetLocator: string;
    }>;

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

  const backupAndDelete = async (report: StoredBugReport) => {
    const db = await getDbInstance();
    await db
      .insert(bugReportRetentionBackupsInOps)
      .values({
        id: randomUUID(),
        publicId: report.publicId,
        snapshot: report,
      })
      .onConflictDoNothing({ target: bugReportRetentionBackupsInOps.publicId });
    await db.delete(bugReportsInOps).where(eq(bugReportsInOps.id, report.id));
  };

  return {
    insert,
    findByPublicId,
    updateStatus,
    listExpired,
    listWithScreenshots,
    updateScreenshotUrl,
    recordStorageMigration,
    listPendingStorageDeletes,
    markStorageDeleted,
    backupAndDelete,
  };
};

export const bugReportRepository = createBugReportRepository();
