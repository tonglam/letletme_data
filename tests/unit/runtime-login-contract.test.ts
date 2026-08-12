import { describe, expect, test } from 'bun:test';

import {
  assertRuntimeDatabaseTarget,
  assertRuntimeDatabaseUrl,
  assertRuntimeLoginSnapshot,
  DATA_RUNTIME_CAPABILITY,
  DATA_RUNTIME_LOGIN,
  GRAPHQL_RUNTIME_CAPABILITY,
  GRAPHQL_RUNTIME_LOGIN,
  parseRuntimeLoginBootstrapArgs,
  type RuntimeLoginSnapshot,
} from '../../scripts/runtime-login-contract';

const capability = (roleName: string) => ({
  roleName,
  canLogin: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: false,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  validUntilOk: true,
  settings: [],
});

const login = (roleName: string) => ({
  roleName,
  canLogin: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
  connectionLimit: -1,
  validUntilOk: true,
  settings: [],
});

const accepted = (): RuntimeLoginSnapshot => ({
  roles: [
    login(DATA_RUNTIME_LOGIN),
    capability(DATA_RUNTIME_CAPABILITY),
    login(GRAPHQL_RUNTIME_LOGIN),
    capability(GRAPHQL_RUNTIME_CAPABILITY),
  ],
  memberships: [
    {
      loginRole: DATA_RUNTIME_LOGIN,
      grantedRole: DATA_RUNTIME_CAPABILITY,
      adminOption: false,
    },
    {
      loginRole: GRAPHQL_RUNTIME_LOGIN,
      grantedRole: GRAPHQL_RUNTIME_CAPABILITY,
      adminOption: false,
    },
  ],
});

describe('production runtime LOGIN contract', () => {
  test('requires bootstrap to select exactly one supported target', () => {
    expect(parseRuntimeLoginBootstrapArgs(['--target=data'])).toBe('data');
    expect(parseRuntimeLoginBootstrapArgs(['--target=graphql'])).toBe('graphql');
    expect(() => parseRuntimeLoginBootstrapArgs([])).toThrow('exactly one');
    expect(() => parseRuntimeLoginBootstrapArgs(['--target=web'])).toThrow(
      'does not accept arguments',
    );
    expect(() => parseRuntimeLoginBootstrapArgs(['--target=data', '--target=graphql'])).toThrow(
      'exactly one',
    );
  });

  test('accepts two non-admin logins with exactly one locked capability each', () => {
    expect(() => assertRuntimeLoginSnapshot(accepted())).not.toThrow();
  });

  test('rejects unsafe, missing, expired, and multiply inherited runtime identities', () => {
    const base = accepted();
    expect(() =>
      assertRuntimeLoginSnapshot({
        ...base,
        roles: base.roles.map((role) =>
          role.roleName === DATA_RUNTIME_LOGIN ? { ...role, superuser: true } : role,
        ),
      }),
    ).toThrow('missing or unsafe');
    expect(() =>
      assertRuntimeLoginSnapshot({
        ...base,
        roles: base.roles.filter((role) => role.roleName !== GRAPHQL_RUNTIME_LOGIN),
      }),
    ).toThrow('unexpected role set');
    expect(() =>
      assertRuntimeLoginSnapshot({
        ...base,
        roles: base.roles.map((role) =>
          role.roleName === GRAPHQL_RUNTIME_LOGIN
            ? { ...role, validUntilOk: false, connectionLimit: 0 }
            : role,
        ),
      }),
    ).toThrow('missing or unsafe');
    expect(() =>
      assertRuntimeLoginSnapshot({
        ...base,
        memberships: [
          ...base.memberships,
          {
            loginRole: GRAPHQL_RUNTIME_LOGIN,
            grantedRole: 'unexpected_reader',
            adminOption: false,
          },
        ],
      }),
    ).toThrow(`must inherit only ${GRAPHQL_RUNTIME_CAPABILITY}`);
  });

  test('requires a complete runtime URL for the selected role', () => {
    expect(
      assertRuntimeDatabaseUrl(
        'postgresql://letletme_data_runtime:initial-secret@db.example/postgres',
        DATA_RUNTIME_LOGIN,
        'RUNTIME_DATABASE_URL',
      ),
    ).toEqual({ password: 'initial-secret' });
    expect(() =>
      assertRuntimeDatabaseUrl(
        'postgresql://letletme_graphql_runtime.projectref@db.example/postgres',
        GRAPHQL_RUNTIME_LOGIN,
        'RUNTIME_DATABASE_URL',
      ),
    ).toThrow('initial password');
    expect(() =>
      assertRuntimeDatabaseUrl(
        'postgresql://wrong:password@db.example/postgres',
        DATA_RUNTIME_LOGIN,
        'RUNTIME_DATABASE_URL',
      ),
    ).toThrow(`must include ${DATA_RUNTIME_LOGIN}`);
  });

  test('requires runtime URLs to target the migration database', () => {
    expect(() =>
      assertRuntimeDatabaseTarget(
        'postgresql://postgres:password@db.projectref.supabase.co:5432/postgres',
        'postgresql://letletme_data_runtime:password@aws-0-au.pooler.supabase.com:6543/postgres',
        'RUNTIME_DATABASE_URL',
      ),
    ).toThrow('same PostgreSQL project');
    expect(() =>
      assertRuntimeDatabaseTarget(
        'postgresql://postgres.projectref:password@aws-0-au.pooler.supabase.com:5432/postgres',
        'postgresql://letletme_data_runtime.projectref:password@aws-0-au.pooler.supabase.com:6543/postgres',
        'RUNTIME_DATABASE_URL',
      ),
    ).not.toThrow();
  });
});
