/* eslint-disable no-console */
import postgres from 'postgres';

import {
  assertMigrationLoginPreflightSnapshot,
  assertMigrationLoginSnapshot,
  type MigrationLoginPreflightSnapshot,
  type MigrationLoginSnapshot,
} from './migration-login-policy';

type ContractRow = {
  role_name: string;
  session_user: string;
  server_major: number;
  rolcanlogin: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolbypassrls: boolean;
  has_ops_ledger: boolean;
  can_write_migration_ledger: boolean;
  canonical_schema_owner_count: number;
  public_application_object_count: number;
};

type PreflightRow = Pick<
  ContractRow,
  | 'role_name'
  | 'session_user'
  | 'server_major'
  | 'rolcanlogin'
  | 'rolcreaterole'
  | 'rolinherit'
  | 'rolbypassrls'
>;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const preflight = args.length === 1 && args[0] === '--preflight';
  if (args.length > 0 && !preflight) {
    throw new Error(`Migration contract does not accept arguments: ${args.join(' ')}`);
  }
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  const sql = postgres(databaseUrl, { connect_timeout: 10, max: 1, prepare: false });
  try {
    if (preflight) {
      const rows = await sql<PreflightRow[]>`
        SELECT
          current_user::text AS role_name,
          session_user::text AS session_user,
          current_setting('server_version_num')::integer / 10000 AS server_major,
          role_row.rolcanlogin,
          role_row.rolcreaterole,
          role_row.rolinherit,
          role_row.rolbypassrls
        FROM pg_roles role_row
        WHERE role_row.rolname = current_user
      `;
      const base = rows[0];
      if (!base) throw new Error('Migration LOGIN role is unavailable');
      const snapshot: MigrationLoginPreflightSnapshot = {
        roleName: base.role_name,
        sessionUser: base.session_user,
        serverMajor: base.server_major,
        canLogin: base.rolcanlogin,
        createRole: base.rolcreaterole,
        inherit: base.rolinherit,
        bypassRls: base.rolbypassrls,
      };
      assertMigrationLoginPreflightSnapshot(snapshot);
      console.log(
        JSON.stringify({ status: 'migration_login_preflight_passed', ...snapshot }, null, 2),
      );
      return;
    }

    const rows = await sql<ContractRow[]>`
      SELECT
        current_user::text AS role_name,
        session_user::text AS session_user,
        current_setting('server_version_num')::integer / 10000 AS server_major,
        role_row.rolcanlogin,
        role_row.rolcreaterole,
        role_row.rolinherit,
        role_row.rolbypassrls,
        to_regclass('ops.schema_migrations') IS NOT NULL AS has_ops_ledger,
        has_table_privilege(
          current_user,
          'ops.schema_migrations',
          'SELECT,INSERT,UPDATE'
        ) AS can_write_migration_ledger,
        (
          SELECT count(*)::integer
          FROM pg_namespace namespace_row
          WHERE namespace_row.nspname IN (
            'fpl', 'competition', 'understat', 'bridge', 'reporting', 'ops'
          )
            AND namespace_row.nspowner = 'letletme_data_owner'::regrole
        ) AS canonical_schema_owner_count,
        (
          SELECT count(*)::integer
          FROM pg_class relation_row
          WHERE relation_row.relnamespace = 'public'::regnamespace
            AND relation_row.relkind IN ('r', 'p', 'f', 'm', 'v', 'S')
        ) + (
          SELECT count(*)::integer
          FROM pg_proc function_row
          WHERE function_row.pronamespace = 'public'::regnamespace
        ) + (
          SELECT count(*)::integer
          FROM pg_type type_row
          WHERE type_row.typnamespace = 'public'::regnamespace
            AND type_row.typtype IN ('d', 'e')
        ) AS public_application_object_count
      FROM pg_roles role_row
      WHERE role_row.rolname = current_user
    `;
    const base = rows[0];
    if (!base) throw new Error('Migration LOGIN role is unavailable');

    const inheritedRows = await sql<Array<{ role_name: string }>>`
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
      SELECT DISTINCT role_name FROM inherited ORDER BY role_name
    `;

    const snapshot: MigrationLoginSnapshot = {
      roleName: base.role_name,
      sessionUser: base.session_user,
      serverMajor: base.server_major,
      canLogin: base.rolcanlogin,
      createRole: base.rolcreaterole,
      inherit: base.rolinherit,
      bypassRls: base.rolbypassrls,
      hasOpsLedger: base.has_ops_ledger,
      canWriteMigrationLedger: base.can_write_migration_ledger,
      canonicalSchemaOwnerCount: base.canonical_schema_owner_count,
      publicApplicationObjectCount: base.public_application_object_count,
      inheritedRoles: inheritedRows.map((row) => row.role_name),
    };
    assertMigrationLoginSnapshot(snapshot);
    console.log(
      JSON.stringify(
        {
          status: 'migration_login_contract_passed',
          ...snapshot,
        },
        null,
        2,
      ),
    );
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  console.error('[migration-login-contract] failed', error);
  process.exitCode = 1;
});
