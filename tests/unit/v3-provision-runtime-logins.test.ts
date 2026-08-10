import { describe, expect, test } from 'bun:test';

import {
  assertRuntimeLoginProvisioningSnapshot,
  V3_DATA_RUNTIME_CAPABILITY,
  V3_DATA_RUNTIME_LOGIN,
  V3_GRAPHQL_RUNTIME_CAPABILITY,
  V3_GRAPHQL_RUNTIME_LOGIN,
  type RuntimeLoginProvisioningSnapshot,
} from '../../scripts/v3-provision-runtime-logins';

const capability = (roleName: string) => ({
  roleName,
  canLogin: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: false,
  replication: false,
  bypassRls: false,
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
  settings: [],
});

const accepted = (): RuntimeLoginProvisioningSnapshot => ({
  roles: [
    login(V3_DATA_RUNTIME_LOGIN),
    capability(V3_DATA_RUNTIME_CAPABILITY),
    login(V3_GRAPHQL_RUNTIME_LOGIN),
    capability(V3_GRAPHQL_RUNTIME_CAPABILITY),
  ],
  memberships: [
    {
      loginRole: V3_DATA_RUNTIME_LOGIN,
      grantedRole: V3_DATA_RUNTIME_CAPABILITY,
      adminOption: false,
    },
    {
      loginRole: V3_GRAPHQL_RUNTIME_LOGIN,
      grantedRole: V3_GRAPHQL_RUNTIME_CAPABILITY,
      adminOption: false,
    },
  ],
});

describe('v3 production runtime LOGIN provisioning contract', () => {
  test('accepts two non-admin logins with exactly one locked capability each', () => {
    expect(() => assertRuntimeLoginProvisioningSnapshot(accepted())).not.toThrow();
  });

  test('rejects elevated, missing, and multiply inherited runtime identities', () => {
    const base = accepted();
    const elevated = {
      ...base,
      roles: base.roles.map((role) =>
        role.roleName === V3_DATA_RUNTIME_LOGIN ? { ...role, superuser: true } : role,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(elevated)).toThrow('missing or unsafe');

    const missing = {
      ...base,
      roles: base.roles.filter((role) => role.roleName !== V3_GRAPHQL_RUNTIME_LOGIN),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(missing)).toThrow('unexpected role set');

    const inherited = {
      ...base,
      memberships: [
        ...base.memberships,
        {
          loginRole: V3_GRAPHQL_RUNTIME_LOGIN,
          grantedRole: 'unexpected_reader',
          adminOption: false,
        },
      ],
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(inherited)).toThrow(
      `must inherit only ${V3_GRAPHQL_RUNTIME_CAPABILITY}`,
    );

    const delegated = {
      ...base,
      memberships: base.memberships.map((membership) =>
        membership.loginRole === V3_DATA_RUNTIME_LOGIN
          ? { ...membership, adminOption: true }
          : membership,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(delegated)).toThrow(
      `must inherit only ${V3_DATA_RUNTIME_CAPABILITY}`,
    );

    const configured = {
      ...base,
      roles: base.roles.map((role) =>
        role.roleName === V3_GRAPHQL_RUNTIME_LOGIN
          ? { ...role, settings: ['search_path=public'] }
          : role,
      ),
    };
    expect(() => assertRuntimeLoginProvisioningSnapshot(configured)).toThrow('missing or unsafe');
  });
});
