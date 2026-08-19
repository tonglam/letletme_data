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
          screenshotUrl: report.screenshotUrl,
          clientMeta: report.clientMeta,
          status: 'open',
        })
        .returning({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
        });

      if (!row) {
        throw new DatabaseError('Bug report insert returned no row');
      }
      return row;
    } catch (error) {
      logError('Failed to insert bug report', error);
      throw error instanceof DatabaseError
        ? error
        : new DatabaseError('Failed to store bug report');
    }
  };

  return { insert };
};

export const bugReportRepository = createBugReportRepository();
