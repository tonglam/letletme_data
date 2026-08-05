import { sql } from 'drizzle-orm';

import { getDb, type DbOrTransaction } from '../db/singleton';
import { DatabaseError } from '../utils/errors';

export interface CoreSnapshotAuthorityRecord {
  season: string;
  revision: number;
  publicationId: string;
  committedAt: Date;
}

type CoreSnapshotAuthorityRow = {
  season: string;
  revision: string | number;
  publicationId: string;
  committedAt: Date;
};

function mapAuthority(row: CoreSnapshotAuthorityRow): CoreSnapshotAuthorityRecord {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new DatabaseError(
      'Core snapshot authority revision is invalid.',
      'CORE_SNAPSHOT_AUTHORITY_INVALID',
    );
  }
  return { ...row, revision };
}

export async function allocateCoreSnapshotRevision(dbInstance?: DbOrTransaction): Promise<number> {
  const db = dbInstance ?? (await getDb());
  const rows = (await db.execute(sql`
    SELECT nextval('public.core_snapshot_revision_seq') AS revision
  `)) as unknown as Array<{ revision: string | number }>;
  const revision = Number(rows[0]?.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new DatabaseError(
      'Failed to reserve a core snapshot revision.',
      'CORE_SNAPSHOT_REVISION_RESERVATION_FAILED',
    );
  }
  return revision;
}

export async function findCoreSnapshotAuthority(
  dbInstance?: DbOrTransaction,
  options?: { lock?: boolean },
): Promise<CoreSnapshotAuthorityRecord | null> {
  const db = dbInstance ?? (await getDb());
  const lockClause = options?.lock ? sql`FOR UPDATE` : sql``;
  const rows = (await db.execute(sql`
    SELECT
      season,
      revision,
      publication_id AS "publicationId",
      committed_at AS "committedAt"
    FROM public.core_snapshot_authority
    WHERE singleton_id = 1
    ${lockClause}
  `)) as unknown as CoreSnapshotAuthorityRow[];
  return rows[0] ? mapAuthority(rows[0]) : null;
}

export async function recordCoreSnapshotAuthority(
  record: Pick<CoreSnapshotAuthorityRecord, 'season' | 'revision' | 'publicationId'>,
  dbInstance: DbOrTransaction,
): Promise<void> {
  await dbInstance.execute(sql`
    INSERT INTO public.core_snapshot_authority (
      singleton_id,
      season,
      revision,
      publication_id,
      committed_at
    )
    VALUES (1, ${record.season}, ${record.revision}, ${record.publicationId}::uuid, now())
    ON CONFLICT (singleton_id) DO UPDATE SET
      season = excluded.season,
      revision = excluded.revision,
      publication_id = excluded.publication_id,
      committed_at = excluded.committed_at
  `);
}
