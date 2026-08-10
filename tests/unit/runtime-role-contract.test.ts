import { describe, expect, test } from 'bun:test';

import {
  assertDataRuntimeRoleSnapshot,
  DATA_RUNTIME_CAPABILITY_ROLE,
  type DataRuntimeRoleSnapshot,
  type DatabaseRoleAttributes,
} from '../../src/db/runtime-role-contract';

const lockedCapability: DatabaseRoleAttributes = {
  roleName: DATA_RUNTIME_CAPABILITY_ROLE,
  canLogin: false,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: false,
  replication: false,
  bypassRls: false,
};

const runtimeLogin: DatabaseRoleAttributes = {
  roleName: 'data_runtime',
  canLogin: true,
  superuser: false,
  createDatabase: false,
  createRole: false,
  inherit: true,
  replication: false,
  bypassRls: false,
};

const validSnapshot: DataRuntimeRoleSnapshot = {
  sessionUser: 'data_runtime',
  currentUser: 'data_runtime',
  loginRole: runtimeLogin,
  capabilityRole: lockedCapability,
  inheritedRoles: [DATA_RUNTIME_CAPABILITY_ROLE],
};

describe('Data runtime database role contract', () => {
  test('accepts one non-admin LOGIN inheriting only the writer capability', () => {
    expect(() => assertDataRuntimeRoleSnapshot(validSnapshot)).not.toThrow();
  });

  test('rejects the owner role and any additional inherited capability', () => {
    expect(() =>
      assertDataRuntimeRoleSnapshot({
        ...validSnapshot,
        inheritedRoles: ['letletme_data_owner'],
      }),
    ).toThrow('letletme_data_writer');
    expect(() =>
      assertDataRuntimeRoleSnapshot({
        ...validSnapshot,
        inheritedRoles: [DATA_RUNTIME_CAPABILITY_ROLE, 'unexpected_role'],
      }),
    ).toThrow('only letletme_data_writer');
  });

  test('rejects elevated LOGINs and unsafe capability attributes', () => {
    expect(() =>
      assertDataRuntimeRoleSnapshot({
        ...validSnapshot,
        loginRole: { ...runtimeLogin, createRole: true },
      }),
    ).toThrow('non-admin');
    expect(() =>
      assertDataRuntimeRoleSnapshot({
        ...validSnapshot,
        capabilityRole: { ...lockedCapability, canLogin: true },
      }),
    ).toThrow('unsafe');
  });

  test('rejects SET ROLE connections', () => {
    expect(() =>
      assertDataRuntimeRoleSnapshot({
        ...validSnapshot,
        currentUser: DATA_RUNTIME_CAPABILITY_ROLE,
      }),
    ).toThrow('must not assume');
  });
});
