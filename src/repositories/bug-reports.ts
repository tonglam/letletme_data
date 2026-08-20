import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { bugReportsInOps } from '../db/schemas/platform.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { BugReportInsert } from '../domain/bug-report';
import { DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

export type StoredBugReport = {
  id: string;
  publicId: string;
  createdAt: Date;
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
        })
        .onConflictDoNothing({ target: bugReportsInOps.submissionId })
        .returning({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
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
      return row;
    } catch (error) {
      logError('Failed to insert bug report', error);
      if (error instanceof DatabaseError) throw error;
      const databaseError = error as { code?: unknown; constraint?: unknown };
      throw new DatabaseError(
        'Failed to store bug report',
        typeof databaseError.code === 'string' ? databaseError.code : undefined,
        error instanceof Error ? error : undefined,
      );
    }
  };

  const listExpiredScreenshots = async (
    cutoff: Date,
    limit: number,
    offset = 0,
  ): Promise<ExpiredBugReportScreenshot[]> => {
    const db = await getDbInstance();
    return db
      .select({
        id: bugReportsInOps.id,
        screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
        createdAt: bugReportsInOps.createdAt,
      })
      .from(bugReportsInOps)
      .where(
        and(
          lte(bugReportsInOps.createdAt, cutoff),
          isNotNull(bugReportsInOps.screenshotObjectKey),
          sql`${bugReportsInOps.screenshotDeletedAt} IS NULL`,
        ),
      )
      .orderBy(asc(bugReportsInOps.createdAt))
      .limit(limit)
      .offset(offset) as Promise<ExpiredBugReportScreenshot[]>;
  };

  const listActiveScreenshotKeys = async (limit: number, offset = 0): Promise<string[]> => {
    const db = await getDbInstance();
    const rows = await db
      .select({ screenshotObjectKey: bugReportsInOps.screenshotObjectKey })
      .from(bugReportsInOps)
      .where(
        and(
          isNotNull(bugReportsInOps.screenshotObjectKey),
          sql`${bugReportsInOps.screenshotDeletedAt} IS NULL`,
        ),
      )
      .orderBy(asc(bugReportsInOps.createdAt))
      .limit(limit)
      .offset(offset);
    return rows.flatMap((row) => (row.screenshotObjectKey ? [row.screenshotObjectKey] : []));
  };

  const markScreenshotDeleted = async (id: string, deletedAt: Date): Promise<void> => {
    const db = await getDbInstance();
    await db
      .update(bugReportsInOps)
      .set({ screenshotObjectKey: null, screenshotDeletedAt: deletedAt })
      .where(eq(bugReportsInOps.id, id));
  };

  return { insert, listExpiredScreenshots, listActiveScreenshotKeys, markScreenshotDeleted };
};

export const bugReportRepository = createBugReportRepository();
