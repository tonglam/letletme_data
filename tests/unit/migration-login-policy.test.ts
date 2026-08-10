import { describe, expect, test } from 'bun:test';

import {
  assertMigrationLoginSnapshot,
  type MigrationLoginSnapshot,
} from '../../scripts/migration-login-policy';

const accepted = (): MigrationLoginSnapshot => ({
  roleName: 'postgres',
  sessionUser: 'postgres',
  serverMajor: 15,
  canLogin: true,
  createRole: true,
  inherit: true,
  bypassRls: true,
  hasOpsLedger: true,
  canWriteMigrationLedger: true,
  canonicalSchemaOwnerCount: 6,
  publicApplicationObjectCount: 0,
  inheritedRoles: ['letletme_data_owner'],
});

describe('migration LOGIN contract', () => {
  test('accepts the canonical PostgreSQL and ownership boundary', () => {
    expect(() => assertMigrationLoginSnapshot(accepted())).not.toThrow();
  });

  test('rejects a generic operator or an incomplete database contract', () => {
    expect(() =>
      assertMigrationLoginSnapshot({
        ...accepted(),
        roleName: 'migration_operator',
        sessionUser: 'migration_operator',
      }),
    ).toThrow('Supabase postgres');
    expect(() =>
      assertMigrationLoginSnapshot({ ...accepted(), canonicalSchemaOwnerCount: 5 }),
    ).toThrow('expected owner');
    expect(() =>
      assertMigrationLoginSnapshot({ ...accepted(), publicApplicationObjectCount: 1 }),
    ).toThrow('public schema');
  });

  test('rejects missing ledger access or owner inheritance', () => {
    expect(() =>
      assertMigrationLoginSnapshot({ ...accepted(), canWriteMigrationLedger: false }),
    ).toThrow('authoritative ledger');
    expect(() => assertMigrationLoginSnapshot({ ...accepted(), inheritedRoles: [] })).toThrow(
      'Data owner',
    );
  });
});
