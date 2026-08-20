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
  screenshotObjectKey: string | null;
  screenshotDeletedAt: Date | null;
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
  completed?: boolean;
};

export const createBugReportRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  const screenshotUrlFromSnapshot = (snapshot: unknown): string | null => {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = (snapshot as Record<string, unknown>).screenshotUrl;
    return typeof value === 'string' ? value : null;
  };

  const screenshotObjectKeyFromSnapshot = (snapshot: unknown): string | null => {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = (snapshot as Record<string, unknown>).screenshotObjectKey;
    return typeof value === 'string' ? value : null;
  };

  const screenshotWasDeletedInSnapshot = (snapshot: unknown): boolean => {
    if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
    const value = (snapshot as Record<string, unknown>).screenshotDeletedAt;
    return value !== null && value !== undefined;
  };

  const lockPublicId = async (connection: DbOrTransaction, publicId: string): Promise<void> => {
    await connection.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${publicId}))`);
  };

  const insert = async (report: BugReportInsert): Promise<StoredBugReport> => {
    try {
      const db = await getDbInstance();
      const insertRow = async (connection: DbOrTransaction) => {
        // A retry of a committed submission is idempotent even if its original
        // locator has since been retired or migrated. Resolve it before any
        // new-report locator checks.
        if (report.submissionId) {
          const [existingSubmission] = await connection
            .select({
              id: bugReportsInOps.id,
              publicId: bugReportsInOps.publicId,
              createdAt: bugReportsInOps.createdAt,
            })
            .from(bugReportsInOps)
            .where(eq(bugReportsInOps.submissionId, report.submissionId))
            .limit(1);
          if (existingSubmission) return existingSubmission;
        }

        // Allocation and retirement use the same transaction-scoped lock so
        // a new row cannot pass the registry check while cleanup is creating
        // its durable retired-ID record.
        await lockPublicId(connection, report.publicId);
        // Retention backups are the durable registry for public IDs after the
        // live report row is removed. Reject a generated ID that already
        // belongs to a retired report so the status endpoint can never point
        // an old reference at a newer report.
        const [retiredPublicId] = await connection
          .select({ id: bugReportRetentionBackupsInOps.id })
          .from(bugReportRetentionBackupsInOps)
          .where(eq(bugReportRetentionBackupsInOps.publicId, report.publicId))
          .limit(1);
        if (retiredPublicId) {
          throw new DatabaseError(
            'Bug report public id has already been retired',
            '23505',
            undefined,
            'bug_report_retention_backups_public_id_key',
          );
        }

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
                or(
                  isNotNull(bugReportRetentionBackupsInOps.screenshotDeleteStartedAt),
                  isNotNull(bugReportRetentionBackupsInOps.screenshotDeletedAt),
                ),
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
                or(
                  isNotNull(bugReportStorageMigrationsInOps.deleteStartedAt),
                  isNotNull(bugReportStorageMigrationsInOps.deletedAt),
                ),
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
      const row = 'transaction' in db ? await db.transaction(insertRow) : await insertRow(db);

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
        screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
        screenshotDeletedAt: bugReportsInOps.screenshotDeletedAt,
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
      await lockPublicId(tx, publicId);
      const [current] = await tx
        .select({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
          status: bugReportsInOps.status,
          closedAt: bugReportsInOps.closedAt,
          expiresAt: bugReportsInOps.expiresAt,
          screenshotUrl: bugReportsInOps.screenshotUrl,
          screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
          screenshotDeletedAt: bugReportsInOps.screenshotDeletedAt,
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
          screenshotDeleteStartedAt: bugReportRetentionBackupsInOps.screenshotDeleteStartedAt,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, current.id))
        .limit(1);
      let screenshotUrl = current.screenshotUrl;
      let removeClaim = false;
      const claimedLocator = claim ? screenshotUrlFromSnapshot(claim.snapshot) : null;
      if (claim && claimedLocator) {
        // A status update may race with storage migration. Serialise on the
        // same locator fence, then prefer the migration target when the source
        // has already been deleted; never restore a retired source URL.
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${claimedLocator}))`);
        const [migration] = await tx
          .select({ targetLocator: bugReportStorageMigrationsInOps.targetLocator })
          .from(bugReportStorageMigrationsInOps)
          .where(
            and(
              eq(bugReportStorageMigrationsInOps.sourceLocator, claimedLocator),
              or(
                isNotNull(bugReportStorageMigrationsInOps.deleteStartedAt),
                isNotNull(bugReportStorageMigrationsInOps.deletedAt),
              ),
            ),
          )
          .limit(1);
        if (claim.screenshotDeleteStartedAt && !claim.screenshotDeletedAt) {
          // The remote delete is already fenced. Keep the locator retired and
          // leave the claim for completion/retry; never restore a URL that may
          // be removed after this status transaction commits.
          screenshotUrl = null;
          removeClaim = false;
        } else {
          screenshotUrl =
            migration?.targetLocator ?? (claim.screenshotDeletedAt ? null : claimedLocator);
          removeClaim = !claim.screenshotDeletedAt || Boolean(migration);
        }
      }
      if (claim && removeClaim) {
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
        screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
        screenshotDeletedAt: bugReportsInOps.screenshotDeletedAt,
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
        screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
        screenshotDeletedAt: bugReportsInOps.screenshotDeletedAt,
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
    const prepared = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sourceLocator}))`);
      const [migration] = await tx
        .select({
          id: bugReportStorageMigrationsInOps.id,
          targetLocator: bugReportStorageMigrationsInOps.targetLocator,
          deleteStartedAt: bugReportStorageMigrationsInOps.deleteStartedAt,
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
      if (migration.deletedAt) return false;

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

      // Commit a durable pending-delete fence before the remote call. Inserts
      // reject both this state and the final deleted marker, while a failed or
      // interrupted remote call remains visible to the retry scan.
      await tx
        .update(bugReportStorageMigrationsInOps)
        .set({ deleteStartedAt: migration.deleteStartedAt ?? now })
        .where(eq(bugReportStorageMigrationsInOps.id, migration.id));
      return true;
    });
    if (!prepared) return;

    await deleteSource();

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sourceLocator}))`);
      const [migration] = await tx
        .select({
          id: bugReportStorageMigrationsInOps.id,
          deletedAt: bugReportStorageMigrationsInOps.deletedAt,
        })
        .from(bugReportStorageMigrationsInOps)
        .where(eq(bugReportStorageMigrationsInOps.sourceLocator, sourceLocator))
        .for('update')
        .limit(1);
      if (!migration || migration.deletedAt) return;
      const [marked] = await tx
        .update(bugReportStorageMigrationsInOps)
        .set({ deletedAt: now })
        .where(
          and(
            eq(bugReportStorageMigrationsInOps.id, migration.id),
            isNotNull(bugReportStorageMigrationsInOps.deleteStartedAt),
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
      // Keep the public-ID allocation lock before taking the live-row lock;
      // insert and retirement therefore share one lock order and cannot race
      // a generated ID through the deletion window.
      await lockPublicId(tx, report.publicId);
      const [current] = await tx
        .select({
          id: bugReportsInOps.id,
          publicId: bugReportsInOps.publicId,
          createdAt: bugReportsInOps.createdAt,
          status: bugReportsInOps.status,
          closedAt: bugReportsInOps.closedAt,
          expiresAt: bugReportsInOps.expiresAt,
          screenshotUrl: bugReportsInOps.screenshotUrl,
          screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
          screenshotDeletedAt: bugReportsInOps.screenshotDeletedAt,
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
          screenshotObjectKey: bugReportRetentionBackupsInOps.screenshotObjectKey,
          screenshotCreatedAt: bugReportRetentionBackupsInOps.screenshotCreatedAt,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, current.id))
        .limit(1);

      if (current.screenshotObjectKey && !current.screenshotDeletedAt) {
        // Move the exact private key into a scrubbed durable inventory before
        // deleting the report row. The private screenshot worker can then
        // retry the object independently of report-body retention.
        const inventoryKey = existingClaim?.screenshotObjectKey ?? current.screenshotObjectKey;
        if (
          existingClaim?.screenshotObjectKey &&
          existingClaim.screenshotObjectKey !== inventoryKey
        ) {
          throw new DatabaseError('Bug report screenshot inventory key conflict');
        }
        if (
          existingClaim &&
          (!existingClaim.screenshotObjectKey || !existingClaim.screenshotCreatedAt)
        ) {
          await tx
            .update(bugReportRetentionBackupsInOps)
            .set({
              snapshot: { screenshotObjectKey: inventoryKey },
              screenshotObjectKey: inventoryKey,
              screenshotCreatedAt: current.createdAt,
            })
            .where(eq(bugReportRetentionBackupsInOps.id, current.id));
        } else if (!existingClaim) {
          await tx
            .insert(bugReportRetentionBackupsInOps)
            .values({
              id: current.id,
              publicId: current.publicId,
              snapshot: { screenshotObjectKey: inventoryKey },
              screenshotObjectKey: inventoryKey,
              screenshotCreatedAt: current.createdAt,
            })
            .onConflictDoNothing();
        }
        const [deleted] = await tx
          .delete(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, current.id), lte(bugReportsInOps.expiresAt, now)))
          .returning({ id: bugReportsInOps.id });
        if (!deleted) return null;
        return {
          report: { ...(current as StoredBugReport), screenshotUrl: null },
          screenshotUrl: null,
          completed: true,
        };
      }

      const screenshotUrl = existingClaim
        ? existingClaim.screenshotDeletedAt
          ? null
          : screenshotUrlFromSnapshot(existingClaim.snapshot)
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

  type BugReportDeletionPreparation =
    | { kind: 'pending' }
    | { kind: 'delete'; screenshotUrl: string }
    | { kind: 'complete' };

  const scrubRetentionBackup = async (
    tx: DbOrTransaction,
    reportId: string,
    screenshotUrl: string | null,
  ) => {
    await tx
      .update(bugReportRetentionBackupsInOps)
      .set({ snapshot: screenshotUrl ? { screenshotUrl } : {} })
      .where(eq(bugReportRetentionBackupsInOps.id, reportId));
  };

  const prepareClaimedDeletion = async (
    reportId: string,
    now = new Date(),
  ): Promise<BugReportDeletionPreparation | null> => {
    const db = await getDbInstance();
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ id: bugReportsInOps.id, publicId: bugReportsInOps.publicId })
        .from(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
        .limit(1);
      if (!candidate) return null;
      await lockPublicId(tx, candidate.publicId);

      const [current] = await tx
        .select({ id: bugReportsInOps.id })
        .from(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
        .for('update')
        .limit(1);
      if (!current) return null;
      const [claim] = await tx
        .select({
          id: bugReportRetentionBackupsInOps.id,
          snapshot: bugReportRetentionBackupsInOps.snapshot,
          screenshotDeleteStartedAt: bugReportRetentionBackupsInOps.screenshotDeleteStartedAt,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, reportId))
        .for('update')
        .limit(1);
      if (!claim) return null;

      const privateScreenshotKey = screenshotObjectKeyFromSnapshot(claim.snapshot);
      if (privateScreenshotKey && !screenshotWasDeletedInSnapshot(claim.snapshot)) {
        // The private screenshot retention worker still owns this object. Do
        // not remove the report row or its exact-key inventory yet.
        return { kind: 'pending' };
      }

      const screenshotUrl = screenshotUrlFromSnapshot(claim.snapshot);
      if (screenshotUrl) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${screenshotUrl}))`);
      }

      if (claim.screenshotDeletedAt || !screenshotUrl) {
        const [deleted] = await tx
          .delete(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
          .returning({ id: bugReportsInOps.id });
        if (!deleted) return null;
        await scrubRetentionBackup(tx, reportId, screenshotUrl);
        return { kind: 'complete' };
      }

      if (claim.screenshotDeleteStartedAt) return { kind: 'delete', screenshotUrl };

      const [reference] = await tx
        .select({ id: bugReportsInOps.id })
        .from(bugReportsInOps)
        .where(eq(bugReportsInOps.screenshotUrl, screenshotUrl))
        .limit(1);
      if (reference) {
        const [deleted] = await tx
          .delete(bugReportsInOps)
          .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
          .returning({ id: bugReportsInOps.id });
        if (!deleted) return null;
        // The object remains protected by the other live report; scrub this
        // expired report's backup without creating a deletion tombstone.
        await scrubRetentionBackup(tx, reportId, null);
        return { kind: 'complete' };
      }

      await tx
        .update(bugReportRetentionBackupsInOps)
        .set({ screenshotDeleteStartedAt: now })
        .where(eq(bugReportRetentionBackupsInOps.id, reportId));
      return { kind: 'delete', screenshotUrl };
    });
  };

  const completeClaimedDeletion = async (reportId: string, now = new Date()): Promise<boolean> => {
    const db = await getDbInstance();
    return db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ publicId: bugReportsInOps.publicId })
        .from(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
        .limit(1);
      if (!candidate) return false;
      await lockPublicId(tx, candidate.publicId);

      const [current] = await tx
        .select({ id: bugReportsInOps.id })
        .from(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
        .for('update')
        .limit(1);
      if (!current) return false;
      const [claim] = await tx
        .select({
          id: bugReportRetentionBackupsInOps.id,
          snapshot: bugReportRetentionBackupsInOps.snapshot,
          screenshotDeleteStartedAt: bugReportRetentionBackupsInOps.screenshotDeleteStartedAt,
          screenshotDeletedAt: bugReportRetentionBackupsInOps.screenshotDeletedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(eq(bugReportRetentionBackupsInOps.id, reportId))
        .for('update')
        .limit(1);
      if (!claim) return false;
      const privateScreenshotKey = screenshotObjectKeyFromSnapshot(claim.snapshot);
      if (privateScreenshotKey && !screenshotWasDeletedInSnapshot(claim.snapshot)) return false;
      const screenshotUrl = screenshotUrlFromSnapshot(claim.snapshot);
      if (screenshotUrl) {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${screenshotUrl}))`);
        if (!claim.screenshotDeletedAt && !claim.screenshotDeleteStartedAt) return false;
        if (!claim.screenshotDeletedAt) {
          await tx
            .update(bugReportRetentionBackupsInOps)
            .set({ screenshotDeletedAt: now })
            .where(eq(bugReportRetentionBackupsInOps.id, reportId));
        }
      }
      const [deleted] = await tx
        .delete(bugReportsInOps)
        .where(and(eq(bugReportsInOps.id, reportId), lte(bugReportsInOps.expiresAt, now)))
        .returning({ id: bugReportsInOps.id });
      if (!deleted) return false;
      await scrubRetentionBackup(tx, reportId, screenshotUrl);
      return true;
    });
  };

  const finalizeClaimedDeletion = async (
    reportId: string,
    now = new Date(),
    beforeDelete?: () => Promise<boolean>,
  ): Promise<boolean> => {
    const prepared = await prepareClaimedDeletion(reportId, now);
    if (!prepared) return false;
    if (prepared.kind === 'pending') return false;
    if (prepared.kind === 'complete') {
      return prepared.kind === 'complete';
    }
    if (!beforeDelete || !(await beforeDelete())) return false;
    return completeClaimedDeletion(reportId, now);
  };

  const listExpiredScreenshots = async (
    cutoff: Date,
    limit: number,
    offset = 0,
  ): Promise<ExpiredBugReportScreenshot[]> => {
    const db = await getDbInstance();
    const scanLimit = Math.min(Math.max(offset + limit, limit), 1_100);
    const [liveRows, backupRows] = await Promise.all([
      db
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
        .orderBy(asc(bugReportsInOps.createdAt), asc(bugReportsInOps.id))
        .limit(scanLimit),
      db
        .select({
          id: bugReportRetentionBackupsInOps.id,
          screenshotObjectKey: bugReportRetentionBackupsInOps.screenshotObjectKey,
          createdAt: bugReportRetentionBackupsInOps.screenshotCreatedAt,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(
          and(
            lte(bugReportRetentionBackupsInOps.screenshotCreatedAt, cutoff),
            isNotNull(bugReportRetentionBackupsInOps.screenshotObjectKey),
            sql`${bugReportRetentionBackupsInOps.screenshotDeletedAt} IS NULL`,
          ),
        )
        .orderBy(
          asc(bugReportRetentionBackupsInOps.screenshotCreatedAt),
          asc(bugReportRetentionBackupsInOps.id),
        )
        .limit(scanLimit),
    ]);
    return [...liveRows, ...backupRows]
      .flatMap((row) =>
        row.screenshotObjectKey && row.createdAt
          ? [{ id: row.id, screenshotObjectKey: row.screenshotObjectKey, createdAt: row.createdAt }]
          : [],
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .slice(offset, offset + limit);
  };

  const listActiveScreenshotKeys = async (limit: number, offset = 0): Promise<string[]> => {
    const db = await getDbInstance();
    const scanLimit = Math.min(Math.max(offset + limit, limit), 1_100);
    const [liveRows, backupRows] = await Promise.all([
      db
        .select({
          screenshotObjectKey: bugReportsInOps.screenshotObjectKey,
          createdAt: bugReportsInOps.createdAt,
          id: bugReportsInOps.id,
        })
        .from(bugReportsInOps)
        .where(
          and(
            isNotNull(bugReportsInOps.screenshotObjectKey),
            sql`${bugReportsInOps.screenshotDeletedAt} IS NULL`,
          ),
        )
        .orderBy(asc(bugReportsInOps.createdAt), asc(bugReportsInOps.id))
        .limit(scanLimit),
      db
        .select({
          screenshotObjectKey: bugReportRetentionBackupsInOps.screenshotObjectKey,
          createdAt: bugReportRetentionBackupsInOps.screenshotCreatedAt,
          id: bugReportRetentionBackupsInOps.id,
        })
        .from(bugReportRetentionBackupsInOps)
        .where(
          and(
            isNotNull(bugReportRetentionBackupsInOps.screenshotObjectKey),
            sql`${bugReportRetentionBackupsInOps.screenshotDeletedAt} IS NULL`,
          ),
        )
        .orderBy(
          asc(bugReportRetentionBackupsInOps.screenshotCreatedAt),
          asc(bugReportRetentionBackupsInOps.id),
        )
        .limit(scanLimit),
    ]);
    const keys = [...liveRows, ...backupRows]
      .flatMap((row) =>
        row.screenshotObjectKey && row.createdAt
          ? [{ id: row.id, screenshotObjectKey: row.screenshotObjectKey, createdAt: row.createdAt }]
          : [],
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id),
      )
      .map((row) => row.screenshotObjectKey);
    return [...new Set(keys)].slice(offset, offset + limit);
  };

  const markScreenshotDeleted = async (id: string, deletedAt: Date): Promise<void> => {
    const db = await getDbInstance();
    const mark = async (connection: DbOrTransaction) => {
      await connection
        .update(bugReportsInOps)
        .set({ screenshotObjectKey: null, screenshotDeletedAt: deletedAt })
        .where(eq(bugReportsInOps.id, id));
      await connection
        .update(bugReportRetentionBackupsInOps)
        .set({
          screenshotObjectKey: null,
          screenshotCreatedAt: null,
          screenshotDeletedAt: deletedAt,
          snapshot: {},
        })
        .where(
          and(
            eq(bugReportRetentionBackupsInOps.id, id),
            isNotNull(bugReportRetentionBackupsInOps.screenshotObjectKey),
          ),
        );
    };
    if ('transaction' in db) await db.transaction(mark);
    else await mark(db);
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
