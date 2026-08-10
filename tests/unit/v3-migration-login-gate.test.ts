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
  publicLeagueTrendsCatalogState: 'absent',
  publicLeagueTrendsCatalogRows: 0,
  publicLeagueTrendsCatalogOrphans: 0,
  graphqlMainlineFunctionsValid: false,
  invalidPreactivationSchemaCount: 0,
  preactivationSchemaObjectCount: 0,
  inheritedRoles: [],
  canWriteMigrationLedger: false,
};

describe('v3 migration LOGIN gate', () => {
  test('accepts the exact pre-activation Supabase postgres contract', () => {
    expect(() => assertV3MigrationLoginSnapshot(preactivation)).not.toThrow();
  });

  test('accepts only the exact later GraphQL catalog baseline', () => {
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        publicRelationCount: 221,
        publicFunctionCount: 8,
        publicLeagueTrendsCatalogState: 'valid',
        graphqlMainlineFunctionsValid: true,
      }),
    ).not.toThrow();

    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        publicRelationCount: 221,
        publicFunctionCount: 8,
      }),
    ).toThrow('exact B0 object scope');
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        publicRelationCount: 221,
        publicFunctionCount: 8,
        publicLeagueTrendsCatalogState: 'invalid',
        graphqlMainlineFunctionsValid: true,
      }),
    ).toThrow('exact B0 object scope');
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        publicRelationCount: 221,
        publicFunctionCount: 8,
        publicLeagueTrendsCatalogState: 'valid',
        publicLeagueTrendsCatalogRows: 1,
        publicLeagueTrendsCatalogOrphans: 1,
        graphqlMainlineFunctionsValid: true,
      }),
    ).toThrow('exact B0 object scope');
    expect(() =>
      assertV3MigrationLoginSnapshot({
        ...preactivation,
        publicRelationCount: 221,
        publicFunctionCount: 8,
        publicLeagueTrendsCatalogState: 'valid',
      }),
    ).toThrow('exact B0 object scope');
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
