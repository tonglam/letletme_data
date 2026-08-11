import { describe, expect, test } from 'bun:test';

import {
  assertRuntimeLoginProvisioningSnapshot,
  assertRuntimeDatabaseUrl,
  assertRuntimeDatabaseTarget,
  DATA_RUNTIME_CAPABILITY,
  DATA_RUNTIME_LOGIN,
  GRAPHQL_RUNTIME_CAPABILITY,
  GRAPHQL_RUNTIME_LOGIN,
  type RuntimeLoginProvisioningSnapshot,
} from '../../scripts/provision-runtime-logins';

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

const accepted = (): RuntimeLoginProvisioningSnapshot => ({
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

describe('production runtime LOGIN provisioning contract', () => {
  test('accepts two non-admin logins with exactly one locked capability each', () => {
    expect(() => assertRuntimeLoginProvisioningSnapshot(accepted())).not.toThrow();
  });

  test('rejects exhausted or expired runtime logins', () => {
    const base = accepted();
    expect(() =>
      assertRuntimeLoginProvisioningSnapshot({
        ...base,
        roles: base.roles.map((role) =>
          role.roleName === DATA_RUNTIME_LOGIN ? { ...role, connectionLimit: 0 } : role,
        ),
      }),
    ).toThrow('missing or unsafe');
    expect(() =>
      assertRuntimeLoginProvisioningSnapshot({
        ...base,
        roles: base.roles.map((role) =>
          role.roleName === GRAPHQL_RUNTIME_LOGIN ? { ...role, validUntilOk: false } : role,
        ),
      }),
    ).toThrow('missing or unsafe');
  });

  test('requires runtime URLs to match the configured role passwords', () => {
    expect(() =>
      assertRuntimeDatabaseUrl(
        'postgresql://letletme_data_runtime:password@db.example/postgres',
        DATA_RUNTIME_LOGIN,
        'password',
        'DATA_RUNTIME_DATABASE_URL',
      ),
    ).not.toThrow();
    expect(() =>
      assertRuntimeDatabaseUrl(
        'postgresql://letletme_graphql_runtime.projectref:password@db.example/postgres',
        GRAPHQL_RUNTIME_LOGIN,
        'password',
        'GRAPHQL_RUNTIME_DATABASE_URL',
      ),
    ).not.toThrow();
    expect(() =>
      assertRuntimeDatabaseUrl(
        'postgresql://wrong:password@db.example/postgres',
        DATA_RUNTIME_LOGIN,
        'password',
        'DATA_RUNTIME_DATABASE_URL',
      ),
    ).toThrow('must use letletme_data_runtime');
  });

  test('requires runtime URLs to target the migration database', () => {
    expect(() =>
      assertRuntimeDatabaseTarget(
        'postgresql://postgres:password@db.projectref.supabase.co:5432/postgres',
        'postgresql://letletme_data_runtime:password@aws-0-au.pooler.supabase.com:6543/postgres',
        'DATA_RUNTIME_DATABASE_URL',
      ),
    ).toThrow('same PostgreSQL project');
    expect(() =>
      assertRuntimeDatabaseTarget(
        'postgresql://postgres.projectref:password@aws-0-au.pooler.supabase.com:5432/postgres',
        'postgresql://letletme_data_runtime.projectref:password@aws-0-au.pooler.supabase.com:6543/postgres',
        'DATA_RUNTIME_DATABASE_URL',
      ),
    ).not.toThrow();
    expect(() =>
      assertRuntimeDatabaseTarget(
        'postgresql://postgres:password@db.projectref.supabase.co:5432/postgres',
        'postgresql://letletme_data_runtime:password@db.projectref.supabase.co:5432/other',
        'DATA_RUNTIME_DATABASE_URL',
      ),
    ).toThrow('same PostgreSQL database');
  });

  test('rejects elevated, missing, and multiply inherited runtime identities', () => {
    const base = accepted();
    const elevated = {
      ...base,
      roles: base.roles.map((role) =>
        role.roleName === DATA_RUNTIME_LOGIN ? { ...role, superuser: true } : role,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(elevated)).toThrow('missing or unsafe');

    const missing = {
      ...base,
      roles: base.roles.filter((role) => role.roleName !== GRAPHQL_RUNTIME_LOGIN),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(missing)).toThrow('unexpected role set');

    const inherited = {
      ...base,
      memberships: [
        ...base.memberships,
        {
          loginRole: GRAPHQL_RUNTIME_LOGIN,
          grantedRole: 'unexpected_reader',
          adminOption: false,
        },
      ],
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(inherited)).toThrow(
      `must inherit only ${GRAPHQL_RUNTIME_CAPABILITY}`,
    );

    const delegated = {
      ...base,
      memberships: base.memberships.map((membership) =>
        membership.loginRole === DATA_RUNTIME_LOGIN
          ? { ...membership, adminOption: true }
          : membership,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(delegated)).toThrow(
      `must inherit only ${DATA_RUNTIME_CAPABILITY}`,
    );

    const configured = {
      ...base,
      roles: base.roles.map((role) =>
        role.roleName === GRAPHQL_RUNTIME_LOGIN
          ? { ...role, settings: ['search_path=public'] }
          : role,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(configured)).toThrow('missing or unsafe');
  });
});
