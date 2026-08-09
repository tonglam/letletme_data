import { describe, expect, test } from 'bun:test';

import {
  assertV3MigrationLoginSnapshot,
  type MigrationLoginSnapshot,
} from '../../scripts/v3-migration-login-gate';

const preactivation: MigrationLoginSnapshot = {
  roleName: 'postgres',
  sessionUser: 'postgres',
  serverMajor: 15,
  canLogin: true,
  createRole: true,
  inherit: true,
  replication: false,
  bypassRls: true,
  migrationState: 'preactivation',
  publicRelationCount: 220,
  publicFunctionCount: 6,
  publicEnumCount: 20,
  wrongPublicOwnerCount: 0,
  invalidPreactivationSchemaCount: 0,
  preactivationSchemaObjectCount: 0,
  inheritedRoles: [],
  canWriteMigrationLedger: false,
};

describe('v3 migration LOGIN gate', () => {
  test('accepts the exact pre-activation Supabase postgres contract', () => {
    expect(() => assertV3MigrationLoginSnapshot(preactivation)).not.toThrow();
  });

  test('rejects a generic CREATEROLE operator', () => {
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        roleName: 'p5_operator',
        sessionUser: 'p5_operator',
        bypassRls: false,
      }),
    ).toThrow('Supabase postgres');
  });

  test('rejects a contaminated or wrongly owned pre-activation target schema', () => {
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        invalidPreactivationSchemaCount: 1,
      }),
    ).toThrow('schema scope or ownership');
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        preactivationSchemaObjectCount: 1,
      }),
    ).toThrow('schema scope or ownership');
  });

  test('accepts an activated migration login with owner membership and ledger access', () => {
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        migrationState: 'activated',
        publicRelationCount: 1,
        publicFunctionCount: 0,
        publicEnumCount: 0,
        wrongPublicOwnerCount: 1,
        inheritedRoles: ['letletme_data_owner'],
        canWriteMigrationLedger: true,
      }),
    ).not.toThrow();
  });

  test('rejects frozen-owner membership and missing migration-ledger access', () => {
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        inheritedRoles: ['letletme_v2_frozen_owner'],
      }),
    ).toThrow('frozen v2 owner');
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        migrationState: 'activated',
        inheritedRoles: ['letletme_data_owner'],
      }),
    ).toThrow('migration ledger');
  });
});
