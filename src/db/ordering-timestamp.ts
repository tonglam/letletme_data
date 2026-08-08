import { sql } from 'drizzle-orm';

import { DatabaseError } from '../utils/errors';
import { getDb, type DbHandle } from './singleton';

export type DatabaseOrderingTimestamp = {
  date: Date;
  exact: string;
};

export async function readDatabaseOrderingTimestamp(
  dbInstance?: DbHandle,
): Promise<DatabaseOrderingTimestamp> {
  const db = dbInstance ?? (await getDb());
  const rows = await db.execute<{ checkedAt: Date | string; exactCheckedAt: string }>(sql`
    SELECT
      checked_at AS "checkedAt",
      to_char(
        checked_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) AS "exactCheckedAt"
    FROM (SELECT clock_timestamp() AS checked_at) source
  `);
  const checkedAt =
    rows[0]?.checkedAt instanceof Date
      ? rows[0].checkedAt
      : new Date(String(rows[0]?.checkedAt ?? ''));
  const exact = String(rows[0]?.exactCheckedAt ?? '');
  if (Number.isNaN(checkedAt.getTime()) || !exact) {
    throw new DatabaseError(
      'Database ordering timestamp is invalid.',
      'DATABASE_ORDERING_TIMESTAMP_INVALID',
    );
  }
  return { date: checkedAt, exact };
}
