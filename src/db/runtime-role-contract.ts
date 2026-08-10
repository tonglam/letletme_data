import type postgres from 'postgres';

export type DatabaseRoleAttributes = {
  readonly roleName: string;
  readonly canLogin: boolean;
  readonly superuser: boolean;
  readonly createDatabase: boolean;
  readonly createRole: boolean;
  readonly inherit: boolean;
  readonly replication: boolean;
  readonly bypassRls: boolean;
};

export type DataRuntimeRoleSnapshot = {
  readonly sessionUser: string;
  readonly currentUser: string;
  readonly loginRole: DatabaseRoleAttributes | undefined;
  readonly capabilityRole: DatabaseRoleAttributes | undefined;
  readonly inheritedRoles: readonly string[];
};

export const DATA_RUNTIME_CAPABILITY_ROLE = 'letletme_data_writer';

export function assertDataRuntimeRoleSnapshot(snapshot: DataRuntimeRoleSnapshot): void {
  if (snapshot.currentUser !== snapshot.sessionUser) {
    throw new Error('Data runtime connection must not assume another database role');
  }

  const login = snapshot.loginRole;
  if (
    !login ||
    login.roleName !== snapshot.currentUser ||
    !login.canLogin ||
    !login.inherit ||
    login.superuser ||
    login.createDatabase ||
    login.createRole ||
    login.replication ||
    login.bypassRls
  ) {
    throw new Error('Data runtime requires a dedicated non-admin LOGIN with INHERIT');
  }

  if (
    snapshot.inheritedRoles.length !== 1 ||
    snapshot.inheritedRoles[0] !== DATA_RUNTIME_CAPABILITY_ROLE
  ) {
    throw new Error(`Data runtime LOGIN must inherit only ${DATA_RUNTIME_CAPABILITY_ROLE}`);
  }

  const capability = snapshot.capabilityRole;
  if (
    !capability ||
    capability.roleName !== DATA_RUNTIME_CAPABILITY_ROLE ||
    capability.canLogin ||
    capability.inherit ||
    capability.superuser ||
    capability.createDatabase ||
    capability.createRole ||
    capability.replication ||
    capability.bypassRls
  ) {
    throw new Error('Data runtime capability role attributes are unsafe');
  }
}

type RoleRow = {
  role_name: string;
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
};

function roleAttributes(row: RoleRow | undefined): DatabaseRoleAttributes | undefined {
  if (!row) return undefined;
  return {
    roleName: row.role_name,
    canLogin: row.rolcanlogin,
    superuser: row.rolsuper,
    createDatabase: row.rolcreatedb,
    createRole: row.rolcreaterole,
    inherit: row.rolinherit,
    replication: row.rolreplication,
    bypassRls: row.rolbypassrls,
  };
}

export async function assertDataRuntimeRole(client: postgres.Sql): Promise<void> {
  const [identityRows, roleRows, inheritedRows] = await Promise.all([
    client<Array<{ session_user: string; current_user: string }>>`
      SELECT session_user::text, current_user::text
    `,
    client<RoleRow[]>`
      SELECT
        rolname AS role_name,
        rolcanlogin,
        rolsuper,
        rolcreatedb,
        rolcreaterole,
        rolinherit,
        rolreplication,
        rolbypassrls
      FROM pg_roles
      WHERE rolname IN (current_user, ${DATA_RUNTIME_CAPABILITY_ROLE})
      ORDER BY rolname
    `,
    client<Array<{ role_name: string }>>`
      WITH RECURSIVE inherited(role_oid, role_name, path) AS (
        SELECT granted_role.oid, granted_role.rolname, ARRAY[member_role.oid, granted_role.oid]
        FROM pg_auth_members membership
        JOIN pg_roles member_role ON member_role.oid = membership.member
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE member_role.rolname = current_user

        UNION ALL

        SELECT granted_role.oid, granted_role.rolname, inherited.path || granted_role.oid
        FROM inherited
        JOIN pg_auth_members membership ON membership.member = inherited.role_oid
        JOIN pg_roles granted_role ON granted_role.oid = membership.roleid
        WHERE NOT granted_role.oid = ANY(inherited.path)
      )
      SELECT DISTINCT role_name
      FROM inherited
      ORDER BY role_name
    `,
  ]);

  const identity = identityRows[0];
  if (!identity) throw new Error('Data runtime database identity is unavailable');

  assertDataRuntimeRoleSnapshot({
    sessionUser: identity.session_user,
    currentUser: identity.current_user,
    loginRole: roleAttributes(roleRows.find((row) => row.role_name === identity.current_user)),
    capabilityRole: roleAttributes(
      roleRows.find((row) => row.role_name === DATA_RUNTIME_CAPABILITY_ROLE),
    ),
    inheritedRoles: inheritedRows.map((row) => row.role_name),
  });
}
