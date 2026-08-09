import { describe, expect, test } from 'bun:test';

import { isTransactionPoolerConnection } from '../../src/db/postgres-connection';

describe('Postgres connection mode', () => {
  test('disables prepared statements for transaction pooler URLs', () => {
    expect(
      isTransactionPoolerConnection(
        'postgresql://postgres.project:secret@aws-0-region.pooler.supabase.com:6543/postgres',
      ),
    ).toBe(true);
    expect(
      isTransactionPoolerConnection('postgresql://postgres:secret@localhost:5432/postgres'),
    ).toBe(false);
  });

  test('recognizes an explicit pgbouncer transaction hint', () => {
    expect(
      isTransactionPoolerConnection(
        'postgresql://postgres:secret@database.example:6432/postgres?pgbouncer=true',
      ),
    ).toBe(true);
  });
});
